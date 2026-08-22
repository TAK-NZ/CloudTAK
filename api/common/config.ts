import Err from '@openaddresses/batch-error';
import STS from '@aws-sdk/client-sts';
import SecretsManager from '@aws-sdk/client-secrets-manager';
import { Pool, GenerateUpsert } from '@openaddresses/batch-generic';
import type { Server } from './schema.js';
import { type InferSelectModel, sql } from 'drizzle-orm';
import Models from './models.js';
import process from 'node:process';
import * as pgtypes from './schema.js';

export type ServerMode = 'both' | 'api' | 'hub';

const SERVER_MODES: ServerMode[] = ['both', 'api', 'hub'];

export interface ConfigArgs {
    silent: boolean;
    postgres: string;
    noevents: boolean;
    nosinks: boolean;
    nogeofence?: boolean;
    noconnections?: boolean;
    nocache: boolean;
    mode?: ServerMode;
    hubUrl?: string;
}

export interface ConfigInit {
    silent: boolean;
    noevents: boolean;
    nosinks: boolean;
    nogeofence: boolean;
    noconnections: boolean;
    nocache: boolean;
    models: Models;
    StackName: string;
    API_URL: string;
    PMTILES_URL: string;
    WEBHOOKS_URL: string;
    SigningSecret: string;
    pg: Pool<typeof pgtypes>;
    server: InferSelectModel<typeof Server>;
    Bucket?: string;
    mode: ServerMode;
    hubUrl?: string;
}

// envInit() side effects (boot logging, CLOUDTAK_Config_ settings upsert) only
// run once per process - in 'both' mode the stateful and stateless configs
// each bootstrap their own database pool and would otherwise repeat them.
let envInitOnce = false;

/**
 * Shared configuration base. Owns everything both server halves need - the
 * database pool, models, server record, secrets and URLs - and nothing that
 * belongs to only one half. ConfigStateful (stateful/config.ts) adds the
 * in-memory connection/geofence/event/ws managers and the in-process LocalHub;
 * ConfigStateless (stateless/config.ts) adds the HubClient, UserManager and
 * WeatherManager that request handling needs. Each subclass bootstraps its own
 * pool via Config.envInit() - in 'both' mode two instances coexist, bridged
 * only by the stateful side's LocalHub.
 */
export default class Config {
    silent: boolean;
    noevents: boolean;
    nosinks: boolean;
    nogeofence: boolean;
    noconnections: boolean;
    nocache: boolean;
    models: Models;
    StackName: string;
    SigningSecret: string;
    API_URL: string;
    PMTILES_URL: string;
    WEBHOOKS_URL: string;
    /** Hostnames of external tile CDNs that are allowed to bypass the tile proxy (from CLOUDTAK_TILE_ORIGINS). */
    tileOriginHostnames: Set<string>;
    Bucket?: string;
    pg: Pool<typeof pgtypes>;
    server: InferSelectModel<typeof Server>;
    mode: ServerMode;
    arnPrefix?: string;

    constructor(init: ConfigInit) {
        this.silent = init.silent;
        this.noevents = init.noevents;
        this.nosinks = init.nosinks;
        this.nogeofence = init.nogeofence;
        this.noconnections = init.noconnections;
        this.nocache = init.nocache;
        this.models = init.models;
        this.StackName = init.StackName;
        this.SigningSecret = init.SigningSecret;
        this.API_URL = init.API_URL;
        this.PMTILES_URL = init.PMTILES_URL;
        this.WEBHOOKS_URL = init.WEBHOOKS_URL;

        // TAK-NZ: hostnames of external tile CDNs allowed to bypass the tile
        // proxy. Read straight from the environment rather than plumbed through
        // ConfigInit, so upstream's init contract stays untouched.
        this.tileOriginHostnames = new Set(
            (process.env.CLOUDTAK_TILE_ORIGINS || '')
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
                .flatMap((s) => {
                    try {
                        return [new URL(s).hostname];
                    } catch {
                        return [];
                    }
                }),
        );
        this.pg = init.pg;
        this.Bucket = init.Bucket;
        this.server = init.server;
        this.mode = init.mode;
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
        return new Config(await Config.envInit(args));
    }

    static async envInit(args: ConfigArgs, opts: {
        /**
         * Database migrations only run from the stateful config - it is
         * deployed as a single instance, while stateless replicas autoscale
         * and must never race each other on schema changes
         */
        migrate?: boolean;
    } = {}): Promise<ConfigInit> {
        if (!process.env.AWS_REGION) {
            process.env.AWS_REGION = 'us-east-1';
        }

        const mode = (args.mode || process.env.CLOUDTAK_Server_Mode || 'both') as ServerMode;
        if (!SERVER_MODES.includes(mode)) {
            throw new Error(`CLOUDTAK_Server_Mode must be one of: ${SERVER_MODES.join(', ')}`);
        }

        const hubUrl = args.hubUrl || process.env.CLOUDTAK_Hub_URL;

        if (mode === 'api' && !hubUrl) {
            throw new Error('CLOUDTAK_Hub_URL must be set when CLOUDTAK_Server_Mode is api');
        }

        let SigningSecret, API_URL, PMTILES_URL, WEBHOOKS_URL, Bucket;
        if (!process.env.StackName || process.env.StackName === 'test') {
            process.env.StackName = 'test';

            SigningSecret = process.env.SigningSecret || 'coe-wildland-fire';
            Bucket = process.env.ASSET_BUCKET;
            API_URL = process.env.API_URL || 'http://localhost:5001';
            PMTILES_URL = process.env.PMTILES_URL || 'http://localhost:5001';
            WEBHOOKS_URL = process.env.WEBHOOKS_URL || 'http://localhost:5001';
        } else {
            if (!process.env.StackName) throw new Error('StackName env must be set');
            if (!process.env.API_URL) throw new Error('API_URL env must be set');
            if (!process.env.ASSET_BUCKET) throw new Error('ASSET_BUCKET env must be set');

            // API_URL env var already contains the full URL with scheme (set by CDK)
            const apiUrl = new URL(process.env.API_URL);
            if (apiUrl.hostname === 'localhost') {
                API_URL = process.env.API_URL;
                PMTILES_URL = process.env.PMTILES_URL || 'http://localhost:5001';
                WEBHOOKS_URL = process.env.WEBHOOKS_URL || 'http://localhost:5001';
            } else {
                API_URL = process.env.API_URL;
                PMTILES_URL = process.env.PMTILES_URL || `https://tiles.${apiUrl.host}`;

                // The Webhooks API Gateway is a sibling of the map subdomain
                // (webhooks.example.com) - see cloudformation/webhooks.template.js
                WEBHOOKS_URL = process.env.WEBHOOKS_URL || `https://webhooks.${apiUrl.host.replace(/^map\./, '')}`;
            }

            Bucket = process.env.ASSET_BUCKET;
            SigningSecret = process.env.SigningSecret || await Config.fetchSecret(process.env.StackName, 'secret');
        }

        const pg: Pool<typeof pgtypes> = await Pool.connect(args.postgres, pgtypes, {
            ssl: process.env.StackName === 'test' ? undefined : { rejectUnauthorized: false },
            migrationsFolder: opts.migrate ? (new URL('../migrations', import.meta.url)).pathname : undefined,
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

        if (!envInitOnce) {
            envInitOnce = true;

            if (!args.silent) {
                console.error(`ok - set env AWS_REGION: ${process.env.AWS_REGION}`);
                console.log(`ok - PMTiles: ${PMTILES_URL}`);
                console.error(`ok - StackName: ${process.env.StackName}`);
            }

            for (const envkey in process.env) {
                if (!envkey.startsWith('CLOUDTAK')) continue;

                // TODO Strongly type via the Type in routes/config
                if (envkey.startsWith('CLOUDTAK_Config_')) {
                    const key = envkey.replace(/^CLOUDTAK_Config_/, '').replace(/_/g, '::');
                    console.error(`ok - Updating ${key} with value from environment`);
                    await models.Setting.generate({
                        key,
                        value: process.env[envkey],
                    }, {
                        upsert: GenerateUpsert.UPDATE,
                    });
                }
            }

            // TAK-NZ: ensure the bootstrap admin profile exists with system_admin.
            // Auth is certificate-based, so we cannot pre-provision credentials -
            // the admin still logs in normally to enroll a cert. This only
            // guarantees the profile row exists with the right flag, so a fresh
            // stack is reachable without manual DB surgery.
            //
            // Lives inside the envInitOnce block so it runs once per process, and
            // uses `models` directly because envInit() returns a ConfigInit rather
            // than a constructed Config.
            if (process.env.CLOUDTAK_ADMIN_USERNAME && process.env.CLOUDTAK_ADMIN_PASSWORD) {
                try {
                    try {
                        await models.Profile.from(process.env.CLOUDTAK_ADMIN_USERNAME);
                        await models.Profile.commit(process.env.CLOUDTAK_ADMIN_USERNAME, { system_admin: true });
                    } catch (err) {
                        if (err instanceof Error && err.message.includes('Item Not Found')) {
                            await models.Profile.generate({
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
        }

        return {
            silent: (args.silent || false),
            noevents: (args.noevents || false),
            nosinks: (args.nosinks || false),
            nogeofence: (args.nogeofence || false),
            noconnections: (args.noconnections || false),
            nocache: (args.nocache || false),
            StackName: process.env.StackName,
            server, SigningSecret, API_URL, Bucket, pg, models, PMTILES_URL, WEBHOOKS_URL,
            mode, hubUrl,
        };
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
