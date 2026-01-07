# Upstream Feature Request: Authentik External Provider Integration

## Motivation

Building on the OIDC authentication feature (see related feature request), this adds Authentik-specific integration for automatic certificate enrollment, role synchronization, and agency management. This demonstrates the external provider pattern that can be extended to other identity providers.

### Why Authentik Integration Matters

1. **Passwordless Onboarding**: Users authenticate via SSO and automatically receive TAK certificates without manual enrollment
2. **Centralized Role Management**: System admin and agency admin roles managed in Authentik, synced to CloudTAK
3. **Agency-Based Access Control**: Authentik groups map to CloudTAK agencies for fine-grained permissions
4. **TAK Attribute Management**: User callsigns, colors, and other TAK-specific attributes stored in Authentik
5. **Machine User Support**: ETL service accounts created and managed via Authentik API

## Prerequisites

This feature works with both authentication methods:
- **OIDC Authentication** (see related feature request) - Optional but recommended for SSO
- **Traditional username/password** - Works with existing authentication

Additional requirements:
- Authentik instance with API access
- TAK Server with certificate authority configured (for automatic certificate enrollment)

## Architecture

```
User Login (OIDC or username/password)
        ↓
CloudTAK receives email
        ↓
Check if user exists
        ↓
If new user OR on login:
    ↓
    Fetch user from Authentik API
    ↓
    Get user attributes (callsign, color, groups)
    ↓
    Determine roles:
        - CloudTAKSystemAdmin group → system_admin = true
        - CloudTAKAgency{N} groups → agency_admin = [agency IDs]
    ↓
    Update CloudTAK profile with Authentik data
    ↓
    [If new user AND TAK Server configured]:
        Create application password in Authentik
        ↓
        Request certificate from TAK Server using app password
        ↓
        Store certificate in CloudTAK profile
    ↓
Generate JWT and complete login
```

## Implementation

### 1. External Provider Interface (`api/lib/external.ts`)

Add Authentik provider to the existing external provider interface:

```typescript
import AuthentikProvider from './authentik-provider.js';

export default class External {
    provider: COTAKProvider | AuthentikProvider;
    configured: boolean;

    constructor(provider: COTAKProvider | AuthentikProvider) {
        this.provider = provider;
        this.configured = true;
    }

    static async init(config: Config): Promise<External | null> {
        // Existing COTAK provider check
        if (process.env.COTAK_URL && process.env.COTAK_API_TOKEN_SECRET_ARN) {
            return new External(await COTAKProvider.init(config));
        }
        
        // New Authentik provider check
        if (process.env.AUTHENTIK_URL && process.env.AUTHENTIK_API_TOKEN_SECRET_ARN) {
            return new External(await AuthentikProvider.init(config));
        }
        
        return null;
    }
    
    // Delegate all methods to the provider
    async login(username: string): Promise<ExternalUser> {
        return await this.provider.login(username);
    }
    
    async agencies(): Promise<Array<ExternalAgency>> {
        return await this.provider.agencies();
    }
    
    async agency(agencyId: number): Promise<ExternalAgency> {
        return await this.provider.agency(agencyId);
    }
    
    async channels(agencyId?: number): Promise<Array<ExternalChannel>> {
        return await this.provider.channels(agencyId);
    }
    
    async createMachineUser(opts: CreateMachineUserOpts): Promise<ExternalMachineUser> {
        return await this.provider.createMachineUser(opts);
    }
    
    async attachMachineUser(opts: AttachMachineUserOpts): Promise<void> {
        return await this.provider.attachMachineUser(opts);
    }
}
```

### 2. Authentik Provider (`api/lib/authentik-provider.ts`)

```typescript
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import Err from '@openaddresses/batch-error';
import type Config from './config.js';

interface AuthentikUser {
    pk: number;
    username: string;
    name: string;
    email: string;
    attributes: {
        takCallsign?: string;
        takColor?: string;
    };
    groups: string[];
}

interface AuthentikGroup {
    pk: string;
    name: string;
    attributes: {
        agencyId?: number;
        channelId?: number;
    };
}

export default class AuthentikProvider {
    config: Config;
    authentikUrl: string;
    tokenSecretArn: string;
    tokenCache: { token: string; expires: number } | null = null;

    constructor(config: Config, authentikUrl: string, tokenSecretArn: string) {
        this.config = config;
        this.authentikUrl = authentikUrl;
        this.tokenSecretArn = tokenSecretArn;
    }

    static async init(config: Config): Promise<AuthentikProvider> {
        const authentikUrl = process.env.AUTHENTIK_URL;
        const tokenSecretArn = process.env.AUTHENTIK_API_TOKEN_SECRET_ARN;

        if (!authentikUrl || !tokenSecretArn) {
            throw new Err(500, null, 'Authentik configuration missing');
        }

        return new AuthentikProvider(config, authentikUrl, tokenSecretArn);
    }

    async auth(): Promise<{ token: string }> {
        // Cache token for 5 minutes
        if (this.tokenCache && this.tokenCache.expires > Date.now()) {
            return { token: this.tokenCache.token };
        }

        const client = new SecretsManagerClient({ region: process.env.AWS_DEFAULT_REGION || 'us-east-1' });
        const command = new GetSecretValueCommand({ SecretId: this.tokenSecretArn });
        const response = await client.send(command);

        if (!response.SecretString) {
            throw new Err(500, null, 'Failed to retrieve Authentik API token');
        }

        const token = response.SecretString;
        this.tokenCache = {
            token,
            expires: Date.now() + 5 * 60 * 1000
        };

        return { token };
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

        // Fetch user from Authentik
        const url = new URL('/api/v3/core/users/', this.authentikUrl);
        url.searchParams.append('username', username);

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Err(response.status, null, `Authentik API error: ${response.statusText}`);
        }

        const data = await response.json();
        if (!data.results || data.results.length === 0) {
            throw new Err(404, null, 'User not found in Authentik');
        }

        const user: AuthentikUser = data.results[0];

        // Fetch user's groups
        const groupsUrl = new URL(`/api/v3/core/users/${user.pk}/`, this.authentikUrl);
        const groupsResponse = await fetch(groupsUrl, {
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Accept': 'application/json'
            }
        });

        const userData = await groupsResponse.json();
        const groupNames = userData.groups_obj?.map((g: any) => g.name) || [];

        // Determine system admin status
        const isSystemAdmin = groupNames.includes('CloudTAKSystemAdmin');

        // Determine agency admin status
        const agencyAdminIds: number[] = [];
        for (const groupName of groupNames) {
            const match = groupName.match(/^CloudTAKAgency(\d+)$/);
            if (match) {
                agencyAdminIds.push(parseInt(match[1]));
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

    async agencies(): Promise<Array<{ id: number; name: string; description?: string }>> {
        const creds = await this.auth();

        const url = new URL('/api/v3/core/groups/', this.authentikUrl);
        url.searchParams.append('attributes__agencyId__isnull', 'false');

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Err(response.status, null, `Authentik API error: ${response.statusText}`);
        }

        const data = await response.json();
        const agencies = data.results
            .filter((g: AuthentikGroup) => g.attributes?.agencyId)
            .map((g: AuthentikGroup) => ({
                id: g.attributes.agencyId!,
                name: g.name,
                description: g.attributes.description
            }));

        return agencies;
    }

    async agency(agencyId: number): Promise<{ id: number; name: string; description?: string }> {
        const agencies = await this.agencies();
        const agency = agencies.find(a => a.id === agencyId);
        
        if (!agency) {
            throw new Err(404, null, `Agency ${agencyId} not found`);
        }
        
        return agency;
    }

    async channels(agencyId?: number): Promise<Array<{
        id: number;
        name: string;
        agencyId: number;
    }>> {
        const creds = await this.auth();

        const url = new URL('/api/v3/core/groups/', this.authentikUrl);
        url.searchParams.append('name__startswith', 'tak_');

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Err(response.status, null, `Authentik API error: ${response.statusText}`);
        }

        const data = await response.json();
        let channels = data.results
            .filter((g: AuthentikGroup) => 
                g.name.startsWith('tak_') && 
                g.attributes?.channelId && 
                g.attributes?.agencyId
            )
            .map((g: AuthentikGroup) => ({
                id: g.attributes.channelId!,
                name: g.name.replace(/^tak_/, ''),
                agencyId: g.attributes.agencyId!
            }));

        if (agencyId !== undefined) {
            channels = channels.filter(c => c.agencyId === agencyId);
        }

        return channels;
    }

    async createMachineUser(opts: {
        name: string;
        agency: number;
        channels: number[];
    }): Promise<{
        username: string;
        password: string;
    }> {
        const creds = await this.auth();
        
        // Format username: etl-{agency}-{name}
        const agencyName = (await this.agency(opts.agency)).name
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
        const safeName = opts.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
        const username = `etl-${agencyName}-${safeName}`;

        // Create user in Authentik
        const createUrl = new URL('/api/v3/core/users/', this.authentikUrl);
        const password = this.generatePassword();

        const createResponse = await fetch(createUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                username,
                name: username,
                email: `${username}@machine.local`,
                is_active: true,
                type: 'service_account',
                attributes: {
                    machineUser: true,
                    agency: opts.agency
                }
            })
        });

        if (!createResponse.ok) {
            const error = await createResponse.text();
            throw new Err(createResponse.status, null, `Failed to create machine user: ${error}`);
        }

        const user = await createResponse.json();

        // Set password
        const passwordUrl = new URL(`/api/v3/core/users/${user.pk}/set_password/`, this.authentikUrl);
        await fetch(passwordUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ password })
        });

        return { username, password };
    }

    async attachMachineUser(opts: {
        username: string;
        channels: number[];
    }): Promise<void> {
        const creds = await this.auth();

        // Get user
        const userUrl = new URL('/api/v3/core/users/', this.authentikUrl);
        userUrl.searchParams.append('username', opts.username);

        const userResponse = await fetch(userUrl, {
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Accept': 'application/json'
            }
        });

        const userData = await userResponse.json();
        if (!userData.results || userData.results.length === 0) {
            throw new Err(404, null, 'Machine user not found');
        }

        const user = userData.results[0];

        // Get all channel groups
        const allChannels = await this.channels();
        const targetGroups = allChannels
            .filter(c => opts.channels.includes(c.id))
            .map(c => `tak_${c.name}`);

        // Get group UUIDs
        const groupsUrl = new URL('/api/v3/core/groups/', this.authentikUrl);
        const groupsResponse = await fetch(groupsUrl, {
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Accept': 'application/json'
            }
        });

        const groupsData = await groupsResponse.json();
        const groupUuids = groupsData.results
            .filter((g: any) => targetGroups.includes(g.name))
            .map((g: any) => g.pk);

        // Update user's groups
        const updateUrl = new URL(`/api/v3/core/users/${user.pk}/`, this.authentikUrl);
        await fetch(updateUrl, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${creds.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                groups: [...user.groups, ...groupUuids]
            })
        });
    }

    private generatePassword(): string {
        const length = 32;
        const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
        let password = '';
        for (let i = 0; i < length; i++) {
            password += charset.charAt(Math.floor(Math.random() * charset.length));
        }
        return password;
    }
}
```

### 3. Integration with Login Routes

Update both OIDC and traditional login endpoints to use the external provider:

```typescript
// In api/routes/login.ts

// For traditional username/password login (existing endpoint)
await schema.post('/login', {
    // ... existing schema ...
}, async (req, res) => {
    try {
        // ... existing authentication logic ...
        
        const email = await provider.login(req.body.username, req.body.password);

        if (config.external && config.external.configured) {
            try {
                const response = await config.external.login(email);

                const updates: any = {
                    id: response.id,
                    system_admin: response.system_admin,
                    agency_admin: response.agency_admin,
                    last_login: new Date().toISOString()
                };
                
                // Apply TAK attributes if provided
                if (response.tak_callsign) {
                    updates.tak_callsign = response.tak_callsign;
                    updates.tak_remarks = response.tak_callsign;
                }
                if (response.tak_group) {
                    updates.tak_group = response.tak_group;
                }

                await config.models.Profile.commit(email, updates);
            } catch (err) {
                console.error('Failed to sync with external provider:', err);
            }
        }
        
        // ... rest of login logic ...
    } catch (err) {
        Err.respond(err, res);
    }
});

// For OIDC login (if implemented)
await schema.get('/login/oidc', {
    // ... schema ...
}, async (req, res) => {
    try {
        const auth = oidcParser(req);
        
        // Check if user exists, auto-create if not
        let profile;
        try {
            profile = await config.models.Profile.from(auth.email);
        } catch (err) {
            if (err instanceof Error && err.message.includes('Item Not Found')) {
                profile = await config.models.Profile.generate({
                    username: auth.email,
                    auth: { ca: [], key: '', cert: '' },
                    system_admin: false,
                    agency_admin: [],
                    last_login: new Date().toISOString()
                });
            } else {
                throw err;
            }
        }
        
        if (config.external && config.external.configured) {
            try {
                // Fetch user attributes and roles from Authentik
                const externalUser = await config.external.login(auth.email);
                
                // Update profile with Authentik data
                const updates: any = {
                    id: externalUser.id,
                    system_admin: externalUser.system_admin,
                    agency_admin: externalUser.agency_admin,
                    last_login: new Date().toISOString()
                };
                
                if (externalUser.tak_callsign) {
                    updates.tak_callsign = externalUser.tak_callsign;
                    updates.tak_remarks = externalUser.tak_callsign;
                }
                if (externalUser.tak_group) {
                    updates.tak_group = externalUser.tak_group;
                }
                
                await config.models.Profile.commit(auth.email, updates);
                
                // Auto-enroll certificate if TAK Server is configured and user is new
                if (!profile.auth.cert && config.server.auth.key && config.server.auth.cert) {
                    // Create application password in Authentik
                    const appPassword = await createAuthentikAppPassword(auth.email);
                    
                    // Request certificate from TAK Server
                    const takAuth = new APIAuthPassword(auth.email, appPassword);
                    const api = await TAKAPI.init(new URL(config.server.webtak), takAuth);
                    const certs = await api.Credentials.generate();
                    
                    // Store certificate
                    await config.models.Profile.commit(auth.email, {
                        auth: certs
                    });
                }
                
                profile = await config.models.Profile.from(auth.email);
            } catch (err) {
                console.error('Failed to sync with Authentik:', err);
                // Don't fail login - user can complete setup manually
            }
        }
        
        // ... generate JWT and redirect ...
    } catch (err) {
        // ... error handling ...
    }
});
```

## Configuration

### Environment Variables

```bash
# Authentik provider configuration
AUTHENTIK_URL=https://auth.example.com
AUTHENTIK_API_TOKEN_SECRET_ARN=arn:aws:secretsmanager:region:account:secret:authentik-api-token
```

### Authentik Setup

1. **Create API Token**: Generate a service account token with permissions to read users and groups
2. **Configure Groups**:
   - `CloudTAKSystemAdmin` - Members become system admins
   - `CloudTAKAgency1`, `CloudTAKAgency2`, etc. - Members become agency admins for that agency
   - `tak_channel1`, `tak_channel2`, etc. - TAK channels with `channelId` and `agencyId` attributes
3. **User Attributes**:
   - `takCallsign` - User's TAK callsign
   - `takColor` - User's TAK group color

## Benefits

1. **Zero-Touch Onboarding**: Users log in via SSO and automatically get certificates and proper roles
2. **Centralized Management**: All user management happens in Authentik
3. **Agency Isolation**: Users only see connections and data for their agencies
4. **Machine User Support**: ETL service accounts created programmatically
5. **Extensible Pattern**: Demonstrates how to integrate other identity providers

## Related Feature Requests

- **OIDC Authentication via ALB** (prerequisite) - Must be implemented first
- **Generic External Provider Interface** - Framework for adding other IdP integrations

## Testing

1. Configure Authentik with CloudTAK groups and user attributes
2. Set environment variables for Authentik URL and API token
3. Log in via OIDC as a new user
4. Verify user profile is created with correct roles from Authentik groups
5. Verify TAK certificate is automatically enrolled
6. Verify user can access appropriate resources based on agency membership
7. Create a machine user via CloudTAK UI
8. Verify machine user is created in Authentik with correct group memberships

## Implementation Notes

- Authentik provider implements the same interface as COTAK provider
- Role synchronization happens at login time
- Certificate enrollment is optional (requires TAK Server configuration)
- Machine users are created as Authentik service accounts
- Group membership determines agency access
