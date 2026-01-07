import fetch from './fetch.js';
import Err from '@openaddresses/batch-error';
import Config from './config.js';
import { Static } from '@sinclair/typebox';
import { Agency, MachineUser, Channel } from './external.js';
import crypto from 'crypto';
import TAKAPI from '@tak-ps/node-tak';

export default class AuthentikProvider {
    config: Config;
    authentikUrl: string;
    tokenArn: string;
    cache?: { expires: Date; token: string; };

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

    async auth(): Promise<{ expires: Date; token: string; }> {
        if (!this.cache || this.cache.expires < new Date()) {
            const AWS = await import('@aws-sdk/client-secrets-manager');
            const client = new AWS.SecretsManagerClient({});
            const response = await client.send(
                new AWS.GetSecretValueCommand({ SecretId: this.tokenArn })
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
        items: Array<Static<typeof Agency>>
    }> {
        const creds = await this.auth();
        
        const agencyPrefix = process.env.OIDC_AGENCY_ADMIN_GROUP_PREFIX || 'CloudTAKAgency';

        const url = new URL('/api/v3/core/groups/', this.authentikUrl);
        if (filter) url.searchParams.append('search', filter);

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) throw new Err(500, new Error(await response.text()), 'Authentik Agency List Error');

        const data: any = await response.json();
        const filteredResults = data.results.filter((g: any) => g.name.startsWith(agencyPrefix));

        return {
            total: filteredResults.length,
            items: filteredResults.map((g: any) => ({
                id: g.attributes?.agencyId || 0,
                name: g.attributes?.agencyName || g.name,
                description: g.attributes?.description || ''
            }))
        };
    }

    async agency(uid: number, agencyId: number): Promise<Static<typeof Agency>> {
        const creds = await this.auth();
        
        const agencyPrefix = process.env.OIDC_AGENCY_ADMIN_GROUP_PREFIX || 'CloudTAKAgency';

        const url = new URL('/api/v3/core/groups/', this.authentikUrl);
        url.searchParams.append('name', `${agencyPrefix}${agencyId}`);

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) throw new Err(500, new Error(await response.text()), 'Authentik Agency Fetch Error');

        const data: any = await response.json();
        const group = data.results[0];

        if (!group) throw new Err(404, null, 'Agency not found');

        return {
            id: group.attributes?.agencyId || agencyId,
            name: group.attributes?.agencyName || group.name,
            description: group.attributes?.description || ''
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
                'Authorization': `Bearer ${creds.token}`,
                'Accept': 'application/json'
            }
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
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                name: username,
                username: username,
                attributes: {
                    machineUser: true,
                    agencyId: body.agency_id || null,
                    createdBy: creatorUsername,
                    createdAt: new Date().toISOString(),
                    description: body.integration.description
                }
            })
        });

        if (!createResponse.ok) throw new Err(500, new Error(await createResponse.text()), 'Authentik Service Account Creation Error');

        const userData: any = await createResponse.json();
        const userId = userData.user_pk;

        const passwordUrl = new URL(`/api/v3/core/users/${userId}/set_password/`, this.authentikUrl);
        const passwordResponse = await fetch(passwordUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ password: body.password })
        });

        if (!passwordResponse.ok) throw new Err(500, new Error(await passwordResponse.text()), 'Authentik Password Set Error');

        return {
            id: userId,
            email: username,
            integrations: []
        };
    }

    async fetchMachineUser(uid: number, email: string): Promise<Static<typeof MachineUser>> {
        const creds = await this.auth();

        const url = new URL('/api/v3/core/users/', this.authentikUrl);
        url.searchParams.append('username', email);

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) throw new Err(500, new Error(await response.text()), 'Authentik User Fetch Error');

        const data: any = await response.json();
        const user = data.results[0];

        if (!user) throw new Err(404, null, 'Machine user not found');

        return {
            id: user.pk,
            email: user.username,
            integrations: []
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
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ password: body.password })
            });

            if (!response.ok) throw new Err(500, new Error(await response.text()), 'Authentik Password Update Error');
        }

        return {
            id: mid,
            email: '',
            integrations: []
        };
    }

    async channels(uid: number, query: {
        filter: string;
        agency?: number;
    }): Promise<{
        total: number;
        items: Array<Static<typeof Channel>>
    }> {
        const creds = await this.auth();
        const channelPrefix = process.env.AUTHENTIK_CHANNEL_GROUP_PREFIX || 'tak_';

        const url = new URL('/api/v3/core/groups/', this.authentikUrl);
        if (query.filter) url.searchParams.append('search', query.filter);

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Accept': 'application/json'
            }
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
                description: g.attributes?.description || ''
            }))
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
                'Authorization': `Bearer ${creds.token}`,
                'Accept': 'application/json'
            }
        });

        if (!groupsResponse.ok) throw new Err(500, new Error(await groupsResponse.text()), 'Authentik Groups Fetch Error');

        const groupsData: any = await groupsResponse.json();
        const group = groupsData.results.find((g: any) => 
            g.name.startsWith(channelPrefix) && 
            (g.attributes?.channelId === body.channel_id || g.num_pk === body.channel_id)
        );

        if (!group) throw new Err(404, null, `Channel ${body.channel_id} not found`);

        const url = new URL(`/api/v3/core/groups/${group.pk}/add_user/`, this.authentikUrl);
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ pk: body.machine_id })
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
                    'Authorization': `Bearer ${creds.token}`,
                    'Accept': 'application/json'
                }
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
                    'Authorization': `Bearer ${creds.token}`,
                    'Accept': 'application/json'
                }
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

    async login(username: string): Promise<{
        id: number;
        name: string;
        phone: string | null;
        system_admin: boolean;
        agency_admin: Array<number>;
        tak_callsign?: string;
        tak_group?: string;
    }> {
        const creds = await this.auth();

        const url = new URL('/api/v3/core/users/', this.authentikUrl);
        url.searchParams.append('username', username);

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) throw new Err(500, new Error(await response.text()), 'Authentik User Fetch Error');

        const data: any = await response.json();
        const user = data.results[0];

        if (!user) throw new Err(404, null, 'User not found');

        const groupUuids = user.groups || [];
        const groups: string[] = [];

        for (const groupUuid of groupUuids) {
            try {
                const groupUrl = new URL(`/api/v3/core/groups/${groupUuid}/`, this.authentikUrl);
                const groupResponse = await fetch(groupUrl, {
                    headers: {
                        'Authorization': `Bearer ${creds.token}`,
                        'Accept': 'application/json'
                    }
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
            tak_callsign: attributes.takCallsign,
            tak_group: attributes.takColor
        };
    }

    async renewConnectionCertificate(
        machineUserId: number,
        takApi: TAKAPI
    ): Promise<{ cert: string; key: string }> {
        const creds = await this.auth();
        const tempPassword = crypto.randomBytes(32).toString('base64url');
        
        const passwordUrl = new URL(`/api/v3/core/users/${machineUserId}/set_password/`, this.authentikUrl);
        const passwordResponse = await fetch(passwordUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ password: tempPassword })
        });
        
        if (!passwordResponse.ok) throw new Err(500, new Error(await passwordResponse.text()), 'Failed to set password');
        
        const userUrl = new URL(`/api/v3/core/users/${machineUserId}/`, this.authentikUrl);
        const userResponse = await fetch(userUrl, {
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Accept': 'application/json'
            }
        });
        
        if (!userResponse.ok) throw new Err(500, new Error(await userResponse.text()), 'Failed to fetch user');
        const userData: any = await userResponse.json();
        
        const enrollment = await takApi.Certificate.generate({
            username: userData.username,
            password: tempPassword
        });
        
        return { cert: enrollment.cert, key: enrollment.key };
    }
}
