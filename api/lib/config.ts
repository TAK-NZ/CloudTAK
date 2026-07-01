import Err from '@openaddresses/batch-error';
import STS from '@aws-sdk/client-sts';
import { UserManager } from './interface-user.js';
import { WeatherManager } from './interface-weather.js';
import SecretsManager from '@aws-sdk/client-secrets-manager';
import EventsPool from './events-pool.js';
import { Pool, GenerateUpsert } from '@openaddresses/batch-generic';
import ConnectionPool from './connection-pool.js';
import ConnectionGeofence from './connection-geofence.js';
import { ConnectionWebSocket } from './connection-web.js';
import type { Server } from './schema.js';
import { type InferSelectModel, sql } from 'drizzle-orm';
import Models from './models.js';
import process from 'node:process';
import * as pgtypes from './schema.js';

interface ConfigArgs {
    silent: boolean;
    postgres: string;
    noevents: boolean;
    nosinks: boolean;
    nogeofence?: boolean;
    nocache: boolean;
}

export default class Config {
    silent: boolean;
    noevents: boolean;
    nosinks: boolean;
    nogeofence: boolean;
    nocache: boolean;
    models: Models;
    StackName: string;
    SigningSecret: string;
    MediaSecret: string;
    user?: UserManager;
    weather: WeatherManager;
    API_URL: string;
    PMTILES_URL: string;
    DynamoDB?: string;
    wsClients: Map<string, ConnectionWebSocket[]>;
    Bucket?: string;
    pg: Pool<typeof pgtypes>;
    conns: ConnectionPool;
    geofence: ConnectionGeofence;
    server: InferSelectModel<typeof Server>;
    events: EventsPool;
    VpcId?: string;
    SubnetPublicA?: string;
    SubnetPublicB?: string;
    MediaSecurityGroup?: string;
    arnPrefix?: string;

    constructor(init: {
        silent: boolean;
        noevents: boolean;
        nosinks: boolean;
        nogeofence: boolean;
        nocache: boolean;
        models: Models;
        StackName: string;
        API_URL: string;
        PMTILES_URL: string;
        SigningSecret: string;
        MediaSecret: string;
        wsClients: Map<string, ConnectionWebSocket[]>;
        pg: Pool<typeof pgtypes>;
        server: InferSelectModel<typeof Server>;
        DynamoDB?: string;
        Bucket?: string;
    }) {
        this.silent = init.silent;
        this.noevents = init.noevents;
        this.nosinks = init.nosinks;
        this.nogeofence = init.nogeofence;
        this.nocache = init.nocache;
        this.models = init.models;
        this.StackName = init.StackName;
        this.SigningSecret = init.SigningSecret;
        this.MediaSecret = init.MediaSecret;
        this.API_URL = init.API_URL;
        this.PMTILES_URL = init.PMTILES_URL;
        this.wsClients = init.wsClients;
        this.pg = init.pg;
        this.DynamoDB = init.DynamoDB;
        this.Bucket = init.Bucket;
        this.server = init.server;

        this.conns = new ConnectionPool(this);
        this.geofence = new ConnectionGeofence(this);

        this.events = new EventsPool(this.StackName);

        this.weather = new WeatherManager();
    }

    serverCert(): {
        cert: string;
        key: string;
    } {
        if (!this.server.auth.cert) throw new Err(500, null, 'Server auth.cert not set');
        if (!this.server.auth.key) throw new Err(500, null, 'Server auth.key not set');

        return {
            cert: this.server.auth.cert,
            key: this.server.auth.key,
        };
    }

    static async env(args: ConfigArgs): Promise<Config> {
        if (!process.env.AWS_REGION) {
            process.env.AWS_REGION = 'us-east-1';
        }

        let SigningSecret, MediaSecret, API_URL, PMTILES_URL, DynamoDB, Bucket;
        if (!process.env.StackName || process.env.StackName === 'test') {
            process.env.StackName = 'test';

            SigningSecret = process.env.SigningSecret || 'coe-wildland-fire';
            MediaSecret = process.env.MediaSecret || 'coe-wildland-fire-video';
            Bucket = process.env.ASSET_BUCKET;
            API_URL = process.env.API_URL || 'http://localhost:5001';
            PMTILES_URL = process.env.PMTILES_URL || 'http://localhost:5001';
        } else {
            if (!process.env.StackName) throw new Error('StackName env must be set');
            if (!process.env.API_URL) throw new Error('API_URL env must be set');
            if (!process.env.ASSET_BUCKET) throw new Error('ASSET_BUCKET env must be set');

            // API_URL env var contains only the hostname; prepend the scheme
            const apiUrl = new URL(`http://${process.env.API_URL}`);
            if (apiUrl.hostname === 'localhost') {
                API_URL = `http://${process.env.API_URL}`;
                PMTILES_URL = process.env.PMTILES_URL || 'http://localhost:5001';
            } else {
                PMTILES_URL = process.env.PMTILES_URL || `https://tiles.${process.env.API_URL}`;
                API_URL = `https://${process.env.API_URL}`;
            }

            Bucket = process.env.ASSET_BUCKET;
            DynamoDB = process.env.StackName;
            SigningSecret = process.env.SigningSecret || await Config.fetchSecret(process.env.StackName, 'secret');
            MediaSecret = process.env.MediaSecret || await Config.fetchSecret(process.env.StackName, 'media');
        }

        const pg: Pool<typeof pgtypes> = await Pool.connect(args.postgres, pgtypes, {
            ssl: process.env.StackName === 'test' ? undefined : { rejectUnauthorized: false },
            migrationsFolder: (new URL('../migrations', import.meta.url)).pathname,
        });

        const models = new Models(pg);

        let server: InferSelectModel<typeof Server>;
        try {
            server = await models.Server.from(1);
        } catch (err) {
            console.log(`ok - no server config found: ${err instanceof Error ? err.message : String(err)}`);

            // Create server record, seeding from CLOUDTAK_Server_* env vars if present
            const serverData: Record<string, unknown> = {
                name: process.env.CLOUDTAK_Server_name || 'Default Server',
                url: process.env.CLOUDTAK_Server_url || 'ssl://localhost:8089',
                api: process.env.CLOUDTAK_Server_api || 'https://localhost:8443',
            };
            if (process.env.CLOUDTAK_Server_webtak) {
                serverData.webtak = process.env.CLOUDTAK_Server_webtak;
            }
            if (process.env.CLOUDTAK_Server_auth_cert && process.env.CLOUDTAK_Server_auth_key) {
                serverData.auth = {
                    cert: process.env.CLOUDTAK_Server_auth_cert,
                    key: process.env.CLOUDTAK_Server_auth_key,
                };
            } else if (process.env.CLOUDTAK_Server_auth_p12_secret_arn && process.env.CLOUDTAK_Server_auth_password) {
                try {
                    const secrets = new SecretsManager.SecretsManagerClient({ region: process.env.AWS_REGION });
                    const secretValue = await secrets.send(new SecretsManager.GetSecretValueCommand({
                        SecretId: process.env.CLOUDTAK_Server_auth_p12_secret_arn,
                    }));
                    if (secretValue.SecretBinary) {
                        const pem = (await import('pem')).default;
                        const p12Buffer = Buffer.from(secretValue.SecretBinary);
                        const certs = await new Promise<{ pemCertificate: string; pemKey: string }>((resolve, reject) => {
                            pem.readPkcs12(p12Buffer, { p12Password: process.env.CLOUDTAK_Server_auth_password }, (e: Error | null, result: { cert: string; key: string }) => {
                                if (e) {
                                    reject(e);
                                } else {
                                    resolve({ pemCertificate: result.cert, pemKey: result.key });
                                }
                            });
                        });
                        serverData.auth = { cert: certs.pemCertificate, key: certs.pemKey };
                        console.error('ok - Extracted P12 certificate from Secrets Manager');
                    }
                } catch (e) {
                    console.error(`Error loading P12 from Secrets Manager: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            server = await models.Server.generate(serverData as unknown as { url: string });
        }

        // Apply CLOUDTAK_Server_* env var overrides to an existing server record
        const serverUpdates: Record<string, unknown> = {};
        if (process.env.CLOUDTAK_Server_name) serverUpdates.name = process.env.CLOUDTAK_Server_name;
        if (process.env.CLOUDTAK_Server_url) serverUpdates.url = process.env.CLOUDTAK_Server_url;
        if (process.env.CLOUDTAK_Server_api) serverUpdates.api = process.env.CLOUDTAK_Server_api;
        if (process.env.CLOUDTAK_Server_webtak) serverUpdates.webtak = process.env.CLOUDTAK_Server_webtak;

        if (process.env.CLOUDTAK_Server_auth_cert && process.env.CLOUDTAK_Server_auth_key) {
            serverUpdates.auth = {
                ...(server.auth || {}),
                cert: process.env.CLOUDTAK_Server_auth_cert,
                key: process.env.CLOUDTAK_Server_auth_key,
            };
        } else if (process.env.CLOUDTAK_Server_auth_p12_secret_arn && process.env.CLOUDTAK_Server_auth_password) {
            try {
                const secrets = new SecretsManager.SecretsManagerClient({ region: process.env.AWS_REGION });
                const secretValue = await secrets.send(new SecretsManager.GetSecretValueCommand({
                    SecretId: process.env.CLOUDTAK_Server_auth_p12_secret_arn,
                }));
                if (secretValue.SecretBinary) {
                    const pem = (await import('pem')).default;
                    const p12Buffer = Buffer.from(secretValue.SecretBinary);
                    const certs = await new Promise<{ pemCertificate: string; pemKey: string }>((resolve, reject) => {
                        pem.readPkcs12(p12Buffer, { p12Password: process.env.CLOUDTAK_Server_auth_password }, (e: Error | null, result: { cert: string; key: string }) => {
                            if (e) {
                                reject(e);
                            } else {
                                resolve({ pemCertificate: result.cert, pemKey: result.key });
                            }
                        });
                    });
                    serverUpdates.auth = { ...(server.auth || {}), cert: certs.pemCertificate, key: certs.pemKey };
                }
            } catch (e) {
                console.error(`Error loading P12 for server update: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        if (Object.keys(serverUpdates).length > 0) {
            server = await models.Server.commit(server.id, { ...serverUpdates, updated: sql`Now()` });
            console.error(`ok - Server updated from environment variables`);
        }

        const config = new Config({
            silent: (args.silent || false),
            noevents: (args.noevents || false),
            nosinks: (args.nosinks || false),
            nogeofence: (args.nogeofence || false),
            nocache: (args.nocache || false),
            StackName: process.env.StackName,
            wsClients: new Map(),
            server, SigningSecret, MediaSecret, API_URL, DynamoDB, Bucket, pg, models, PMTILES_URL,
        });

        if (!config.silent) {
            console.error(`ok - set env AWS_REGION: ${process.env.AWS_REGION}`);
            console.log(`ok - PMTiles: ${config.PMTILES_URL}`);
            console.error(`ok - StackName: ${config.StackName}`);
        }

        config.user = new UserManager(config);
        await config.user.init();

        // Set optional VPC/networking config from env
        if (process.env.VpcId) config.VpcId = process.env.VpcId;
        if (process.env.SubnetPublicA) config.SubnetPublicA = process.env.SubnetPublicA;
        if (process.env.SubnetPublicB) config.SubnetPublicB = process.env.SubnetPublicB;
        if (process.env.MediaSecurityGroup) config.MediaSecurityGroup = process.env.MediaSecurityGroup;

        // Ensure admin user exists with system_admin if credentials are provided
        if (process.env.CLOUDTAK_ADMIN_USERNAME && process.env.CLOUDTAK_ADMIN_PASSWORD) {
            try {
                // Ensure admin profile exists with system_admin flag.
                // In v13, auth uses certificates; the admin must login normally
                // to enroll their cert. We just ensure the profile record exists
                // with the correct system_admin flag.
                try {
                    const existing = await config.models.Profile.from(process.env.CLOUDTAK_ADMIN_USERNAME);
                    await config.models.Profile.commit(process.env.CLOUDTAK_ADMIN_USERNAME, { system_admin: true });
                    void existing; // mark as used
                } catch (err) {
                    if (err instanceof Error && err.message.includes('Item Not Found')) {
                        await config.models.Profile.generate({
                            username: process.env.CLOUDTAK_ADMIN_USERNAME,
                            auth: { ca: [], key: '', cert: '' },
                            system_admin: true,
                        });
                    } else {
                        throw err;
                    }
                }
                console.error('ok - Admin user ensured');
            } catch (err) {
                console.error(`Error ensuring admin user: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        for (const envkey in process.env) {
            if (!envkey.startsWith('CLOUDTAK')) continue;

            // TODO Strongly type via the Type in routes/config
            if (envkey.startsWith('CLOUDTAK_Config_')) {
                const key = envkey.replace(/^CLOUDTAK_Config_/, '').replace(/_/g, '::');
                console.error(`ok - Updating ${key} with value from environment`);
                await config.models.Setting.generate({
                    key,
                    value: process.env[envkey],
                }, {
                    upsert: GenerateUpsert.UPDATE,
                });
            }
        }

        return config;
    }

    /**
     * Return a prefix to an ARN
     */
    async fetchArnPrefix(service = ''): Promise<string> {
        if (this.arnPrefix) {
            return this.arnPrefix;
        } else {
            const sts = new STS.STSClient({ region: process.env.AWS_REGION });
            const account = await sts.send(new STS.GetCallerIdentityCommand({}));
            const res = [];

            if (!account.Arn) throw new Error('ARN Could not be determined');

            res.push(...account.Arn.split(':').splice(0, 2));
            res.push(service);
            res.push(process.env.AWS_REGION);
            res.push(...account.Arn.split(':').splice(4, 1));
            this.arnPrefix = res.join(':');

            return this.arnPrefix;
        }
    }

    static async fetchSecret(
        StackName: string,
        Secret: string,
    ): Promise<string> {
        const secrets = new SecretsManager.SecretsManagerClient({ region: process.env.AWS_REGION });

        const secret = await secrets.send(new SecretsManager.GetSecretValueCommand({
            SecretId: `${StackName}/api/${Secret}`,
        }));

        return secret.SecretString || '';
    }
}
