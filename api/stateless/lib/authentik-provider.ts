import Err from '@openaddresses/batch-error';
import Config from '../../common/config.js';
import { Static } from '@sinclair/typebox';
import { Agency, MachineUser, Channel } from './interface-user.js';
import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { TAKAPI, APIAuthPassword } from '@tak-ps/node-tak';
import { TAKGroup, TAKRole } from '@tak-ps/node-tak/lib/api/types';
import pem from 'pem';
import xmljs from 'xml-js';

const TAK_GROUPS: ReadonlySet<string> = new Set(Object.values(TAKGroup));
const TAK_ROLES: ReadonlySet<string> = new Set(Object.values(TAKRole));

/**
 * Authentik user attributes are free-text, admin-editable strings - they are
 * not guaranteed to be one of CloudTAK's enum values. A bad value (an unset
 * attribute serialised as the literal string "None" by an external script,
 * a typo, a stale value from a renamed team colour, etc.) must not reach
 * ProfileConfig: `tak_group`/`tak_role` are stored as free text but the
 * `GET /api/profile` response schema validates them against TAKGroup/TAKRole
 * (see api/common/types.ts), so a single bad write poisons the profile and
 * every subsequent profile fetch starts returning 400 until someone finds
 * and corrects the row by hand. Validate at the boundary instead: drop an
 * attribute that is not a recognised enum value rather than passing it
 * through, so `login.ts`'s "only set if truthy" logic leaves the existing,
 * previously-valid value untouched.
 */
export function asTakGroup(value: unknown, username: string): string | undefined {
    if (typeof value !== 'string' || !value) return undefined;
    if (TAK_GROUPS.has(value)) return value;

    console.error(`Authentik attribute takColor="${value}" for ${username} is not a valid TAK team colour - ignoring`);
    return undefined;
}

export function asTakRole(value: unknown, username: string): string | undefined {
    if (typeof value !== 'string' || !value) return undefined;
    if (TAK_ROLES.has(value)) return value;

    console.error(`Authentik attribute takRole="${value}" for ${username} is not a valid TAK role - ignoring`);
    return undefined;
}

export default class AuthentikProvider {
    config: Config;
    authentikUrl: string;
    tokenArn: string;
    cache?: { expires: Date; token: string };

    constructor(config: Config, authentikUrl: string, tokenArn: string) {
        this.config = config;
        this.authentikUrl = authentikUrl;
        this.tokenArn = tokenArn;
    }

    get configured(): boolean {
        return !!(this.authentikUrl && this.tokenArn);
    }

    static async init(config: Config): Promise<AuthentikProvider> {
        const authentikUrl = process.env.AUTHENTIK_URL || '';
        const tokenArn = process.env.AUTHENTIK_API_TOKEN_SECRET_ARN || '';

        if (!authentikUrl) {
            throw new Err(500, null, 'AUTHENTIK_URL not configured');
        }

        if (!tokenArn) {
            throw new Err(500, null, 'AUTHENTIK_API_TOKEN_SECRET_ARN not configured');
        }

        return new AuthentikProvider(config, authentikUrl, tokenArn);
    }

    async auth(): Promise<{ expires: Date; token: string }> {
        if (!this.cache || this.cache.expires < new Date()) {
            const AWS = await import('@aws-sdk/client-secrets-manager');
            const client = new AWS.SecretsManagerClient({});
            const response = await client.send(
                new AWS.GetSecretValueCommand({ SecretId: this.tokenArn }),
            );

            const token = response.SecretString || '';
            const expires = new Date();
            expires.setHours(expires.getHours() + 1);

            this.cache = { token, expires };
        }

        return this.cache;
    }

    async agencies(uid: number, filter: string): Promise<{
        total: number;
        items: Array<Static<typeof Agency>>;
    }> {
        const creds = await this.auth();

        const agencyPrefix = process.env.OIDC_AGENCY_ADMIN_GROUP_PREFIX || 'CloudTAKAgency';

        const url = new URL('/api/v3/core/groups/', this.authentikUrl);
        if (filter) url.searchParams.append('search', filter);

        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${creds.token}`,
                Accept: 'application/json',
            },
        });

        if (!response.ok) throw new Err(500, new Error(await response.text()), 'Authentik Agency List Error');

        const data: any = await response.json();
        const filteredResults = data.results.filter((g: any) => g.name.startsWith(agencyPrefix));

        return {
            total: filteredResults.length,
            items: filteredResults.map((g: any) => ({
                id: g.attributes?.agencyId || 0,
                name: g.attributes?.agencyName || g.name,
                description: g.attributes?.description || '',
            })),
        };
    }

    async agency(uid: number, agencyId: number): Promise<Static<typeof Agency>> {
        const creds = await this.auth();

        const agencyPrefix = process.env.OIDC_AGENCY_ADMIN_GROUP_PREFIX || 'CloudTAKAgency';

        const url = new URL('/api/v3/core/groups/', this.authentikUrl);
        url.searchParams.append('name', `${agencyPrefix}${agencyId}`);

        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${creds.token}`,
                Accept: 'application/json',
            },
        });

        if (!response.ok) throw new Err(500, new Error(await response.text()), 'Authentik Agency Fetch Error');

        const data: any = await response.json();
        const group = data.results[0];

        if (!group) throw new Err(404, null, 'Agency not found');

        return {
            id: group.attributes?.agencyId || agencyId,
            name: group.attributes?.agencyName || group.name,
            description: group.attributes?.description || '',
        };
    }

    async createMachineUser(uid: number, body: {
        name: string;
        agency_id?: number;
        password: string;
        integration: any;
    }): Promise<Static<typeof MachineUser>> {
        const creds = await this.auth();

        const userUrl = new URL('/api/v3/core/users/', this.authentikUrl);
        userUrl.searchParams.append('pk', String(uid));
        const userResponse = await fetch(userUrl, {
            headers: {
                Authorization: `Bearer ${creds.token}`,
                Accept: 'application/json',
            },
        });

        if (!userResponse.ok) throw new Err(500, new Error(await userResponse.text()), 'Authentik User Fetch Error');
        const creatorData: any = await userResponse.json();
        const creatorUsername = creatorData.results[0]?.username || 'unknown';

        const agencyPrefix = body.agency_id ? `agency${body.agency_id}-` : '';
        const username = `etl-${agencyPrefix}${body.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;

        const createUrl = new URL('/api/v3/core/users/service_account/', this.authentikUrl);
        const createResponse = await fetch(createUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify({
                name: username,
                username: username,
                attributes: {
                    machineUser: true,
                    agencyId: body.agency_id || null,
                    createdBy: creatorUsername,
                    createdAt: new Date().toISOString(),
                    description: body.integration.description,
                },
            }),
        });

        if (!createResponse.ok) throw new Err(500, new Error(await createResponse.text()), 'Authentik Service Account Creation Error');

        const userData: any = await createResponse.json();
        const userId = userData.user_pk;

        const passwordUrl = new URL(`/api/v3/core/users/${userId}/set_password/`, this.authentikUrl);
        const passwordResponse = await fetch(passwordUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ password: body.password }),
        });

        if (!passwordResponse.ok) throw new Err(500, new Error(await passwordResponse.text()), 'Authentik Password Set Error');

        return {
            id: userId,
            email: username,
            integrations: [],
        };
    }

    async fetchMachineUser(uid: number, email: string): Promise<Static<typeof MachineUser>> {
        const creds = await this.auth();

        const url = new URL('/api/v3/core/users/', this.authentikUrl);
        url.searchParams.append('username', email);

        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${creds.token}`,
                Accept: 'application/json',
            },
        });

        if (!response.ok) throw new Err(500, new Error(await response.text()), 'Authentik User Fetch Error');

        const data: any = await response.json();
        const user = data.results[0];

        if (!user) throw new Err(404, null, 'Machine user not found');

        return {
            id: user.pk,
            email: user.username,
            integrations: [],
        };
    }

    async updateMachineUser(uid: number, mid: number, body: {
        password?: string;
    }): Promise<Static<typeof MachineUser>> {
        const creds = await this.auth();

        if (body.password) {
            const url = new URL(`/api/v3/core/users/${mid}/set_password/`, this.authentikUrl);
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${creds.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ password: body.password }),
            });

            if (!response.ok) throw new Err(500, new Error(await response.text()), 'Authentik Password Update Error');
        }

        return {
            id: mid,
            email: '',
            integrations: [],
        };
    }

    async channels(uid: number, query: {
        filter: string;
        agency?: number;
    }): Promise<{
        total: number;
        items: Array<Static<typeof Channel>>;
    }> {
        const creds = await this.auth();
        const channelPrefix = process.env.AUTHENTIK_CHANNEL_GROUP_PREFIX || 'tak_';

        const url = new URL('/api/v3/core/groups/', this.authentikUrl);
        if (query.filter) url.searchParams.append('search', query.filter);

        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${creds.token}`,
                Accept: 'application/json',
            },
        });

        if (!response.ok) throw new Err(500, new Error(await response.text()), 'Authentik Channel List Error');

        const data: any = await response.json();
        let channels = data.results.filter((g: any) => g.name.startsWith(channelPrefix));

        if (query.agency) {
            channels = channels.filter((g: any) => g.attributes?.agencyId === query.agency);
        }

        return {
            total: channels.length,
            items: channels.map((g: any) => ({
                id: g.attributes?.channelId || g.num_pk || 0,
                rdn: g.name.replace(/^tak_/, ''),
                name: g.attributes?.channelName || g.name.replace(/^tak_/, ''),
                description: g.attributes?.description || '',
            })),
        };
    }

    async attachMachineUser(uid: number, body: {
        machine_id: number;
        channel_id: number;
        access: string;
    }): Promise<void> {
        const creds = await this.auth();
        const channelPrefix = process.env.AUTHENTIK_CHANNEL_GROUP_PREFIX || 'tak_';

        const groupsUrl = new URL('/api/v3/core/groups/', this.authentikUrl);
        const groupsResponse = await fetch(groupsUrl, {
            headers: {
                Authorization: `Bearer ${creds.token}`,
                Accept: 'application/json',
            },
        });

        if (!groupsResponse.ok) throw new Err(500, new Error(await groupsResponse.text()), 'Authentik Groups Fetch Error');

        const groupsData: any = await groupsResponse.json();
        const group = groupsData.results.find((g: any) =>
            g.name.startsWith(channelPrefix)
            && (g.attributes?.channelId === body.channel_id || g.num_pk === body.channel_id),
        );

        if (!group) throw new Err(404, null, `Channel ${body.channel_id} not found`);

        const url = new URL(`/api/v3/core/groups/${group.pk}/add_user/`, this.authentikUrl);
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ pk: body.machine_id }),
        });

        if (!response.ok) throw new Err(500, new Error(await response.text()), 'Authentik User Group Assignment Error');
    }

    async updateIntegrationConnectionId(): Promise<void> {
        return;
    }

    async deleteIntegrationByConnectionId(): Promise<void> {
        return;
    }

    async deleteMachineUser(username: string): Promise<void> {
        try {
            const creds = await this.auth();

            // Fetch user by username
            const url = new URL('/api/v3/core/users/', this.authentikUrl);
            url.searchParams.append('username', username);

            const response = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${creds.token}`,
                    Accept: 'application/json',
                },
            });

            if (!response.ok) {
                console.error(`Failed to fetch machine user ${username}:`, await response.text());
                return;
            }

            const data: any = await response.json();
            const user = data.results[0];

            if (!user) {
                console.log(`Machine user ${username} not found, skipping deletion`);
                return;
            }

            // Only delete if it's a machine user (service account)
            if (!user.attributes?.machineUser) {
                console.log(`User ${username} is not a machine user, skipping deletion`);
                return;
            }

            // Delete the user
            const deleteUrl = new URL(`/api/v3/core/users/${user.pk}/`, this.authentikUrl);
            const deleteResponse = await fetch(deleteUrl, {
                method: 'DELETE',
                headers: {
                    Authorization: `Bearer ${creds.token}`,
                    Accept: 'application/json',
                },
            });

            if (!deleteResponse.ok) {
                console.error(`Failed to delete machine user ${username}:`, await deleteResponse.text());
                return;
            }

            console.log(`Successfully deleted Authentik service account: ${username}`);
        } catch (err) {
            console.error(`Error deleting machine user ${username}:`, err);
            // Don't throw - allow connection deletion to continue
        }
    }

    /**
     * Look up an Authentik user by `email` first, falling back to `username`.
     * OIDC callers pass the userinfo `email` claim, which Authentik does not
     * guarantee equals the account's `username` field - querying by `email`
     * first avoids silently failing (and skipping cert enrollment/attribute
     * sync) for accounts where the two differ.
     */
    private async findUserByEmailOrUsername(token: string, identifier: string): Promise<any> {
        const byEmailUrl = new URL('/api/v3/core/users/', this.authentikUrl);
        byEmailUrl.searchParams.append('email', identifier);
        const byEmailResponse = await fetch(byEmailUrl, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        if (!byEmailResponse.ok) throw new Err(500, new Error(await byEmailResponse.text()), 'Authentik User Fetch Error');
        const byEmailData: any = await byEmailResponse.json();
        if (byEmailData.results && byEmailData.results.length > 0) return byEmailData.results[0];

        const byUsernameUrl = new URL('/api/v3/core/users/', this.authentikUrl);
        byUsernameUrl.searchParams.append('username', identifier);
        const byUsernameResponse = await fetch(byUsernameUrl, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        if (!byUsernameResponse.ok) throw new Err(500, new Error(await byUsernameResponse.text()), 'Authentik User Fetch Error');
        const byUsernameData: any = await byUsernameResponse.json();
        return byUsernameData.results?.[0];
    }

    async login(username: string): Promise<{
        id: number;
        name: string;
        phone: string | null;
        system_admin: boolean;
        agency_admin: Array<number>;
        tak_callsign?: string;
        tak_group?: string;
        tak_role?: string;
    }> {
        const creds = await this.auth();

        // `username` here is the OIDC email claim, which is not guaranteed to
        // equal the Authentik user's `username` field (Authentik allows those
        // to differ) - look up by `email` instead, falling back to `username`
        // for compatibility with any pre-existing password-auth callers.
        const user = await this.findUserByEmailOrUsername(creds.token, username);

        if (!user) throw new Err(404, null, 'User not found');

        const groupUuids = user.groups || [];
        const groups: string[] = [];

        for (const groupUuid of groupUuids) {
            try {
                const groupUrl = new URL(`/api/v3/core/groups/${groupUuid}/`, this.authentikUrl);
                const groupResponse = await fetch(groupUrl, {
                    headers: {
                        Authorization: `Bearer ${creds.token}`,
                        Accept: 'application/json',
                    },
                });
                if (groupResponse.ok) {
                    const groupData: any = await groupResponse.json();
                    if (groupData.name) groups.push(groupData.name);
                }
            } catch (err) {
                console.error(`Failed to fetch group ${groupUuid}:`, err);
            }
        }

        const systemAdminGroup = process.env.OIDC_SYSTEM_ADMIN_GROUP || 'CloudTAKSystemAdmin';
        const agencyAdminPrefix = process.env.OIDC_AGENCY_ADMIN_GROUP_PREFIX || 'CloudTAKAgency';

        const isSystemAdmin = groups.includes(systemAdminGroup);

        const agencyAdminIds: number[] = [];
        for (const group of groups) {
            if (group.startsWith(agencyAdminPrefix)) {
                const agencyIdStr = group.substring(agencyAdminPrefix.length);
                const agencyId = parseInt(agencyIdStr, 10);
                if (!isNaN(agencyId) && agencyId > 0) {
                    agencyAdminIds.push(agencyId);
                }
            }
        }

        const attributes = user.attributes || {};

        return {
            id: user.pk,
            name: user.name || username,
            phone: null,
            system_admin: isSystemAdmin,
            agency_admin: agencyAdminIds,
            // Passed through verbatim, matching upstream, which does not decorate
            // the callsign at all.
            //
            // This used to append " (Web)" so a browser session was distinguishable
            // from the same person's ATAK/WinTAK device, since Authentik hands the
            // same callsign attribute to both and TAK Server disambiguates clients
            // only by the literal callsign string. That trade was reconsidered: the
            // suffix showed up everywhere the callsign is displayed, and it is not
            // how upstream or any other TAK client behaves.
            //
            // Note the certificate enrollment path below still uses a " (Web)"
            // suffixed `clientUid`. That is a different identifier - it keeps the
            // browser's TAK Server client certificate from colliding with the user's
            // device certificate - and is deliberately left alone.
            tak_callsign: attributes.takCallsign,
            tak_group: asTakGroup(attributes.takColor, username),
            tak_role: asTakRole(attributes.takRole, username),
        };
    }

    /**
     * Create a short-lived Authentik app-password token for a human user
     * identified by email/username, then use it to generate a TAK client
     * certificate via the TAK Server WebTAK credentials endpoint.
     *
     * The app-password is set to expire in 5 minutes — long enough to complete
     * the certificate enrollment handshake but not lingering in Authentik.
     *
     * The whole set-password / TAK-login / revoke-password sequence mutates a
     * single shared credential (the Authentik user's password), so it is wrapped
     * in a Postgres advisory lock keyed on the username. Without this, two
     * concurrent enrollment attempts for the same user (e.g. a double-fired
     * OIDC callback from the browser) can interleave: request A sets password
     * #1 and starts logging into TAK Server, request B sets password #2 before
     * A's login completes, and A's TAK Server login then fails with a
     * stale-credential error because the password it's using no longer matches
     * what's stored in Authentik. The lock is acquired via a real Postgres
     * transaction (not an in-process mutex) so it serializes correctly across
     * multiple ECS tasks behind the load balancer, not just within one process.
     */
    /**
     * Attempt to enroll a TAK client certificate using an Authentik-issued
     * bearer token instead of a temporary password, via the OAuth2
     * client_credentials + JWT-bearer client-assertion exchange (RFC 7523).
     *
     * The `userAccessToken` (the real user's own CloudTAK-session OIDC token,
     * NOT CloudTAK's client credentials) is passed as `client_assertion` so
     * Authentik ties the exchanged token to that user's identity rather than
     * to a generic client_credentials service account - see
     * https://docs.goauthentik.io/.../machine_to_machine/#externally-issued-jwts
     * "JWT authentication" section. Using plain client_credentials here would
     * silently issue every enrollment to the same synthetic service account,
     * which is wrong and was an earlier mistake in this implementation.
     *
     * This only works if:
     *   1. TAK Server's CoreConfig.xml <oauth><authServer> trusts the OAuth2
     *      provider CloudTAK authenticates against (Federated OIDC Providers)
     *   2. That connector accepts bearer tokens (clientAuth="false", and the
     *      request hits a port AccessTokenResolver checks - 8446/8447)
     *   3. The exchanged token's usernameClaim/groupsClaim resolve to a real,
     *      known TAK Server identity
     * None of that is verified here - this is a best-effort attempt, logged
     * clearly at every step, that throws on any failure so the caller can fall
     * back to the existing temporary-password flow. Nothing about the
     * fallback path changes if this fails or is never configured.
     */
    private async enrollUserCertificateViaM2M(
        identifier: string,
        clientId: string,
        userAccessToken: string,
        takServerUrl: string,
    ): Promise<{ cert: string; key: string; ca: string[] }> {
        console.log(`[M2M] Attempting bearer-token cert enrollment for ${identifier} via Authentik JWT-bearer exchange`);

        // `identifier` here is the OIDC identifier CloudTAK resolved the user by
        // (preferred_username or email claim), which is not guaranteed to equal
        // the Authentik user's `username` field. Resolve the real Authentik
        // username up front so the certificate subject matches exactly what the
        // temporary-password fallback path below would produce for the same
        // user - otherwise the CN/clientUid a person gets depends on which of
        // the two enrollment paths happened to succeed.
        const creds = await this.auth();
        const user = await this.findUserByEmailOrUsername(creds.token, identifier);
        if (!user) throw new Err(404, null, `User ${identifier} not found in Authentik`);
        const username = user.username;

        // Exchange the user's own CloudTAK-issued access token for a new token,
        // using the JWT-bearer client-assertion grant so Authentik ties the
        // result to this user's subject rather than a generic client identity.
        const tokenUrl = new URL('/application/o/token/', this.authentikUrl);
        const tokenResponse = await fetch(tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                client_assertion: userAccessToken,
                client_id: clientId,
                scope: 'openid profile email groups',
            }),
        });

        const tokenBody = await tokenResponse.text();
        if (!tokenResponse.ok) {
            throw new Err(500, null, `[M2M] Authentik client_credentials exchange failed (${tokenResponse.status}): ${tokenBody}`);
        }

        let exchangedToken: string;
        try {
            exchangedToken = JSON.parse(tokenBody).access_token;
        } catch {
            throw new Err(500, null, `[M2M] Authentik token response was not valid JSON: ${tokenBody}`);
        }
        if (!exchangedToken) {
            throw new Err(500, null, `[M2M] Authentik token response had no access_token: ${tokenBody}`);
        }

        console.log(`[M2M] Got exchanged token for ${username}, requesting cert from TAK Server`);

        // Step 2: build the CSR ourselves - node-tak's Credentials.generate()
        // hardcodes Basic auth (APIAuthPassword) and can't be reused for a
        // bearer token, so the TLS config fetch + CSR + signClient/v2 POST is
        // replicated here manually.
        const configUrl = new URL('/Marti/api/tls/config', takServerUrl);
        const configResponse = await fetch(configUrl, {
            headers: { Authorization: `Bearer ${exchangedToken}` },
        });
        if (!configResponse.ok) {
            throw new Err(500, null, `[M2M] TAK Server /tls/config rejected bearer token (${configResponse.status}): ${await configResponse.text()}`);
        }
        const configXml = await configResponse.text();

        let parsedConfig: any;
        try {
            parsedConfig = xmljs.xml2js(configXml, { compact: true });
        } catch (err) {
            throw new Err(500, err instanceof Error ? err : null, `[M2M] Failed to parse /tls/config XML for ${username}: ${configXml.slice(0, 500)}`);
        }

        let organization: string | undefined;
        let organizationUnit: string | undefined;
        const nameEntries = parsedConfig['ns2:certificateConfig']?.nameEntries;
        if (nameEntries?.nameEntry) {
            for (const ne of nameEntries.nameEntry) {
                if (ne._attributes?.name === 'O') organization = ne._attributes.value;
                if (ne._attributes?.name === 'OU') organizationUnit = ne._attributes.value;
            }
        }

        const { csr, clientKey } = await pem.promisified.createCSR({
            organization,
            organizationUnit,
            commonName: username,
        });

        const signUrl = new URL('/Marti/api/tls/signClient/v2', takServerUrl);
        signUrl.searchParams.append('clientUid', `${username} (Web)`);
        signUrl.searchParams.append('version', '3');

        const signResponse = await fetch(signUrl, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${exchangedToken}`,
            },
            body: csr,
        });

        const signBody = await signResponse.text();
        if (!signResponse.ok) {
            throw new Err(500, null, `[M2M] TAK Server signClient/v2 rejected bearer token (${signResponse.status}): ${signBody}`);
        }

        let signed: any;
        try {
            signed = JSON.parse(signBody);
        } catch {
            throw new Err(500, null, `[M2M] TAK Server signClient/v2 response was not valid JSON: ${signBody}`);
        }

        let cert = '-----BEGIN CERTIFICATE-----\n' + signed.signedCert;
        if (!signed.signedCert.endsWith('\n')) cert += '\n';
        cert += '-----END CERTIFICATE-----';

        const ca: string[] = [];
        if (signed.ca0) ca.push(signed.ca0);
        if (signed.ca1) ca.push(signed.ca1);

        console.log(`[M2M] Cert enrollment succeeded for ${username} via bearer token exchange`);

        return { cert, key: clientKey, ca };
    }

    async enrollUserCertificate(
        username: string,
        takServerUrl: string,
        userAccessToken?: string,
    ): Promise<{ cert: string; key: string; ca: string[] }> {
        // Try the OAuth2 M2M bearer-token exchange first, if the caller has the
        // user's own OIDC access token (only available right after the OIDC
        // callback, not on password-login cert renewal paths) and CloudTAK's
        // client ID is configured. This is a straight attempt with no feature
        // flag - if it's not configured or TAK Server/Authentik reject it for
        // any reason, the error is logged and the existing temporary-password
        // flow below runs exactly as before.
        if (userAccessToken && process.env.OIDC_CLIENT_ID) {
            try {
                return await this.enrollUserCertificateViaM2M(
                    username,
                    process.env.OIDC_CLIENT_ID,
                    userAccessToken,
                    takServerUrl,
                );
            } catch (err) {
                console.error(`[M2M] Bearer-token cert enrollment failed for ${username}, falling back to temporary-password flow:`, err);
            }
        }

        return this.config.pg.transaction(async (tx) => {
            // Fixed namespace (arbitrary, just needs to not collide with other
            // advisory lock usage) + a hash of the username as the two int4 lock
            // keys. hashtext() is deterministic per-value within a session/process,
            // which is all that's required here — occasional hash collisions
            // between different usernames would only cause unrelated enrollments
            // to briefly serialize, not any incorrect behavior.
            await tx.execute(sql`SELECT pg_advisory_xact_lock(918273645, hashtext(${username}))`);

            const creds = await this.auth();

            // `username` here is the OIDC email claim, which is not guaranteed
            // to equal the Authentik user's `username` field - look up by
            // `email` instead, falling back to `username` for compatibility
            // with any pre-existing password-auth callers.
            const user = await this.findUserByEmailOrUsername(creds.token, username);
            if (!user) throw new Err(404, null, `User ${username} not found in Authentik`);

            // Set a random temporary password on the user account (overwritten after enrollment)
            const tempPassword = crypto.randomBytes(32).toString('base64url');
            const passwordUrl = new URL(`/api/v3/core/users/${user.pk}/set_password/`, this.authentikUrl);
            const passwordResponse = await fetch(passwordUrl, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: tempPassword }),
            });
            if (!passwordResponse.ok) throw new Err(500, new Error(await passwordResponse.text()), 'Failed to set temporary password for cert enrollment');

            try {
                // Authenticate to the TAK Server using Authentik's actual
                // `username` field (may differ from the OIDC email claim
                // passed into this method).
                const takAuth = new APIAuthPassword(user.username, tempPassword);
                const takApi = await TAKAPI.init(new URL(takServerUrl), takAuth);
                const enrollment = await takApi.Credentials.generate();
                return { cert: enrollment.cert, key: enrollment.key, ca: enrollment.ca || [] };
            } finally {
                // Always revoke the temporary password by setting a new random one,
                // so the account cannot be used with password auth after enrollment.
                const revokePassword = crypto.randomBytes(32).toString('base64url');
                const revokeUrl = new URL(`/api/v3/core/users/${user.pk}/set_password/`, this.authentikUrl);
                await fetch(revokeUrl, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: revokePassword }),
                }).catch(err => console.error('Failed to revoke temporary password after cert enrollment:', err));
            }
        });
    }

    async renewConnectionCertificate(
        machineUserId: number,
        takServerUrl: string,
    ): Promise<{ cert: string; key: string }> {
        const creds = await this.auth();
        const tempPassword = crypto.randomBytes(32).toString('base64url');

        const passwordUrl = new URL(`/api/v3/core/users/${machineUserId}/set_password/`, this.authentikUrl);
        const passwordResponse = await fetch(passwordUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ password: tempPassword }),
        });

        if (!passwordResponse.ok) throw new Err(500, new Error(await passwordResponse.text()), 'Failed to set password');

        const userUrl = new URL(`/api/v3/core/users/${machineUserId}/`, this.authentikUrl);
        const userResponse = await fetch(userUrl, {
            headers: {
                Authorization: `Bearer ${creds.token}`,
                Accept: 'application/json',
            },
        });

        if (!userResponse.ok) throw new Err(500, new Error(await userResponse.text()), 'Failed to fetch user');
        const userData: any = await userResponse.json();

        // Use password auth instead of potentially revoked certificate
        const takAuth = new APIAuthPassword(userData.username, tempPassword);
        const takApi = await TAKAPI.init(new URL(takServerUrl), takAuth);
        const enrollment = await takApi.Credentials.generate();

        return { cert: enrollment.cert, key: enrollment.key };
    }
}
