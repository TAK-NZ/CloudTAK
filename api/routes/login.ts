import jwt from 'jsonwebtoken';
import Err from '@openaddresses/batch-error';
import Auth, { AuthUserAccess, oidcParser, isOidcEnabled } from '../lib/auth.js';
import Config from '../lib/config.js';
import Schema from '@openaddresses/batch-schema';
import { Type } from '@sinclair/typebox'
import Provider from '../lib/provider.js';
import { TAKAPI, APIAuthPassword } from '@tak-ps/node-tak';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import axios from 'axios';
import { X509Certificate } from 'crypto';
import moment from 'moment';

export default async function router(schema: Schema, config: Config) {
    const provider = new Provider(config);

    await schema.post('/login', {
        name: 'Create Login',
        group: 'Login',
        body: Type.Object({
            username: Type.String({
                description: 'Case-Sensitive username, if an email, the client MUST lowercase'
            }),
            password: Type.String()
        }),
        res: Type.Object({
            token: Type.String(),
            access: Type.Enum(AuthUserAccess),
            email: Type.String()
        })
    }, async (req, res) => {
        try {
            // Check if OIDC is forced and local login is restricted to system admins
            const oidcForced = process.env.OIDC_FORCED === 'true';
            
            let profile;

            if (config.server.auth.key && config.server.auth.cert) {
                const email = await provider.login(req.body.username, req.body.password);
                
                // If OIDC is forced, only allow system admins to login locally
                if (oidcForced) {
                    const tempProfile = await config.models.Profile.from(email);
                    if (!tempProfile.system_admin) {
                        throw new Err(403, null, 'Local login is restricted. Please use SSO.');
                    }
                }

                if (config.external && config.external.configured) {
                    try {
                        const response = await config.external.login(email);

                        const updates: any = {
                            id: response.id,
                            system_admin: response.system_admin,
                            agency_admin: response.agency_admin,
                            last_login: new Date().toISOString()
                        };
                        
                        // Apply TAK attributes if provided (AuthentikProvider)
                        if (response.tak_callsign) {
                            updates.tak_callsign = response.tak_callsign;
                            updates.tak_remarks = response.tak_callsign;
                        }
                        if (response.tak_group) {
                            updates.tak_group = response.tak_group;
                        }

                        await config.models.Profile.commit(email, updates);
                    } catch (err) {
                        console.error(err);

                        // If there are upstream errors the user is limited to WebTAK like functionality
                        await config.models.Profile.commit(email, {
                            system_admin: false,
                            agency_admin: [],
                            last_login: new Date().toISOString()
                        });
                    }
                } else {
                    await config.models.Profile.commit(email, {
                        last_login: new Date().toISOString()
                    });
                }

                profile = await config.models.Profile.from(email);
            } else {
                throw new Err(400, null, 'Server has not been configured');
            }

            let access = AuthUserAccess.USER
            if (profile.system_admin) {
                access = AuthUserAccess.ADMIN
            } else if (profile.agency_admin && profile.agency_admin.length) {
                access = AuthUserAccess.AGENCY
            }

            res.json({
                access,
                email: profile.username,
                token: jwt.sign({ access, email: profile.username }, config.SigningSecret, { expiresIn: '16h' })
            })
        } catch (err) {
             Err.respond(err, res);
        }
    });

    await schema.get('/login', {
        name: 'Get Login',
        group: 'Login',
        res: Type.Object({
            email: Type.String(),
            access: Type.Enum(AuthUserAccess)
        })
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);

            res.json({
                email: user.email,
                access: user.access
            });
        } catch (err) {
             Err.respond(err, res);
        }
    });

    // OIDC login endpoint - GET for browser redirect flow
    await schema.get('/login/oidc', {
        name: 'OIDC Login',
        group: 'Login',
        description: 'Login via ALB OIDC authentication',
        query: Type.Object({
            redirect: Type.Optional(Type.String({ default: '/' }))
        }),
        res: Type.Object({
            message: Type.String(),
            status: Type.Optional(Type.Integer())
        })
    }, async (req, res) => {
        try {
            // Feature flag check
            if (!isOidcEnabled()) {
                return res.status(404).json({ 
                    status: 404, 
                    message: 'OIDC authentication not enabled' 
                });
            }
            
            const { user: auth } = await oidcParser(req);
            
            // Fetch groups from Authentik API
            let groups: string[] = [];
            let authentikUserId: number | undefined;
            if (process.env.AUTHENTIK_API_TOKEN_SECRET_ARN && process.env.AUTHENTIK_URL) {
                try {
                    const authentikToken = await getAuthentikToken();
                    const userGroups = await getAuthentikUserGroups(auth.email, authentikToken, process.env.AUTHENTIK_URL);
                    groups = userGroups.groups;
                    authentikUserId = userGroups.userId;
                } catch (err) {
                    console.error('Failed to fetch user groups:', err);
                }
            }
            
            // Parse groups for role assignment (used for both new and existing users)
            const systemAdminGroup = process.env.OIDC_SYSTEM_ADMIN_GROUP || 'CloudTAKSystemAdmin';
            const agencyAdminPrefix = process.env.OIDC_AGENCY_ADMIN_GROUP_PREFIX || 'CloudTAKAgency';
            
            const isSystemAdmin = groups.includes(systemAdminGroup);
            
            // Parse agency admin groups (e.g., "CloudTAKAgency1", "CloudTAKAgency5")
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
            
            // Check if user exists, auto-create if not
            let profile;
            let isNewUser = false;
            try {
                profile = await config.models.Profile.from(auth.email);
                
                // Update group membership and last_login for existing users
                await config.models.Profile.commit(auth.email, {
                    id: authentikUserId,
                    system_admin: isSystemAdmin,
                    agency_admin: agencyAdminIds,
                    last_login: new Date().toISOString()
                });
                profile = await config.models.Profile.from(auth.email);
            } catch (err) {
                if (err instanceof Error && err.message.includes('Item Not Found')) {
                    isNewUser = true;
                    // Auto-create user on first OIDC login using ProfileControl to respect system defaults
                    profile = await provider.profile.generate({
                        username: auth.email,
                        id: authentikUserId,
                        auth: { ca: [], key: '', cert: '' },
                        system_admin: isSystemAdmin,
                        agency_admin: agencyAdminIds,
                        last_login: new Date().toISOString()
                    });
                } else {
                    throw err;
                }
            }
            
            // Check if certificate is missing, invalid, or expired
            const needsCertificate = !profile.auth.cert || !profile.auth.key || 
                                    profile.auth.cert === '' || profile.auth.key === '' ||
                                    await isCertificateExpired(profile.auth.cert);
            
            // Check if we should sync attributes from Authentik
            const shouldSyncAttributes = process.env.SYNC_AUTHENTIK_ATTRIBUTES_ON_LOGIN === 'true';
            
            if ((needsCertificate || shouldSyncAttributes) && process.env.AUTHENTIK_API_TOKEN_SECRET_ARN && process.env.AUTHENTIK_URL && config.server.auth.key && config.server.auth.cert) {
                try {
                    console.log(`${isNewUser ? 'Starting' : 'Retrying'} automatic certificate enrollment for ${auth.email}`);
                    
                    // Get Authentik API token
                    const authentikToken = await getAuthentikToken();
                    
                    // Fetch and update user attributes from Authentik
                    if (shouldSyncAttributes || isNewUser) {
                        const userAttrs = await getAuthentikUserAttributes(
                            auth.email,
                            authentikToken,
                            process.env.AUTHENTIK_URL
                        );
                        
                        console.log(`Fetched Authentik attributes for ${auth.email}:`, JSON.stringify(userAttrs));
                        
                        // Update profile with Authentik attributes
                        const updates: any = {};
                        if (userAttrs.takCallsign) {
                            updates.tak_callsign = userAttrs.takCallsign;
                            updates.tak_remarks = userAttrs.takCallsign;
                        }
                        if (userAttrs.takColor) updates.tak_group = userAttrs.takColor;
                        
                        console.log(`Profile updates for ${auth.email}:`, JSON.stringify(updates));
                        
                        if (Object.keys(updates).length > 0) {
                            updates.updated = new Date().toISOString();
                            await config.models.Profile.commit(auth.email, updates);
                            console.log(`Successfully updated profile attributes for ${auth.email}`);
                            // Refresh profile to get updated attributes
                            profile = await config.models.Profile.from(auth.email);
                        } else {
                            console.log(`No attribute updates needed for ${auth.email}`);
                        }
                    }
                    
                    // Enroll certificate if needed
                    if (needsCertificate) {
                        const appPassword = await createAuthentikAppPassword(
                            auth.email,
                            authentikToken,
                            process.env.AUTHENTIK_URL
                        );
                        
                        // Request certificate from TAK Server
                        const takAuth = new APIAuthPassword(auth.email, appPassword);
                        const api = await TAKAPI.init(new URL(config.server.webtak), takAuth);
                        const certs = await api.Credentials.generate();
                        
                        // Update profile with certificate
                        await config.models.Profile.commit(auth.email, {
                            auth: certs
                        });
                        
                        // Refresh profile to get updated cert
                        profile = await config.models.Profile.from(auth.email);
                        
                        console.log(`Certificate enrolled successfully for ${auth.email}`);
                    }
                } catch (certErr) {
                    console.error('Certificate enrollment error:', certErr);
                    // Continue with login even if certificate enrollment fails
                }
            }
            
            // Update last login
            await config.models.Profile.commit(profile.username, {
                last_login: new Date().toISOString()
            });
            
            // Determine access level
            let access = AuthUserAccess.USER;
            if (profile.system_admin) {
                access = AuthUserAccess.ADMIN;
            } else if (profile.agency_admin && profile.agency_admin.length) {
                access = AuthUserAccess.AGENCY;
            }
            
            // Generate JWT token
            const token = jwt.sign(
                { access, email: profile.username },
                config.SigningSecret,
                { expiresIn: '16h' }
            );
            
            // Redirect back to frontend with token
            const redirect = req.query.redirect || '/';
            const frontendUrl = `/login?token=${token}&redirect=${encodeURIComponent(redirect)}`;
            
            return res.redirect(frontendUrl);
        } catch (err) {
            // Redirect to login page with error
            const errorMsg = err instanceof Error ? err.message : 'Authentication failed';
            return res.redirect(`/login?error=${encodeURIComponent(errorMsg)}`);
        }
    });

    // Logout endpoint - clears ALB OIDC cookies and redirects to IdP logout
    // https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html#authentication-logout
    await schema.get('/logout', {
        name: 'Logout',
        group: 'Login',
        description: 'Logout and clear ALB OIDC session'
    }, async (req, res) => {
        try {
            // Set expiration to -1 for all ALB authentication cookies
            const cookieName = process.env.ALB_AUTH_SESSION_COOKIE || 'AWSELBAuthSessionCookie';
            const cookieOptions = {
                path: '/',
                httpOnly: true,
                secure: true,
                maxAge: -1  // Expire the cookie
            };
            
            // ALB can create up to 4 cookie shards (0-3)
            for (let i = 0; i < 4; i++) {
                res.cookie(`${cookieName}-${i}`, '', cookieOptions);
            }
            
            // Also clear the base cookie (without shard number)
            res.cookie(cookieName, '', cookieOptions);
            
            // Add cache control headers to prevent caching
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            
            // Redirect to IdP logout endpoint if configured
            if (process.env.AUTHENTIK_URL && process.env.AUTHENTIK_APP_SLUG) {
                const authentikUrl = process.env.AUTHENTIK_URL.replace(/\/$/, '');
                const appSlug = process.env.AUTHENTIK_APP_SLUG;
                const logoutUrl = `${authentikUrl}/application/o/${appSlug}/end-session/`;
                return res.redirect(logoutUrl);
            } else {
                return res.redirect('/login');
            }
        } catch (err) {
            console.error('Logout error:', err);
            Err.respond(err, res);
        }
    });
}

// Helper function to get Authentik API token from Secrets Manager
async function getAuthentikToken(): Promise<string> {
    const client = new SecretsManagerClient();
    const command = new GetSecretValueCommand({
        SecretId: process.env.AUTHENTIK_API_TOKEN_SECRET_ARN
    });
    
    const response = await client.send(command);
    
    if (!response.SecretString) {
        throw new Error('Authentik API token secret is empty');
    }
    
    return response.SecretString;
    
    try {
        const secret = JSON.parse(response.SecretString);
        return secret.token || response.SecretString;
    } catch {
        return response.SecretString;
    }
}

// Helper function to create application password in Authentik
async function createAuthentikAppPassword(
    username: string,
    authToken: string,
    authentikUrl: string | undefined
): Promise<string> {
    if (!authentikUrl) {
        throw new Error('Authentik URL is not configured');
    }
    const apiUrl = authentikUrl.endsWith('/') ? authentikUrl.slice(0, -1) : authentikUrl;
    
    // Get user ID
    const userResponse = await axios.get(
        `${apiUrl}/api/v3/core/users/?username=${encodeURIComponent(username)}`,
        {
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            }
        }
    );
    
    if (!userResponse.data.results || userResponse.data.results.length === 0) {
        throw new Error(`User ${username} not found in Authentik`);
    }
    
    const userId = userResponse.data.results[0].pk;
    
    // Create token
    const tokenIdentifier = `CloudTAK-Auto-${username.replace(/[@.]/g, '-')}-${Date.now()}`;
    const expirationDate = new Date();
    expirationDate.setMinutes(expirationDate.getMinutes() + 30); // 30 minute expiration
    
    await axios.post(
        `${apiUrl}/api/v3/core/tokens/`,
        {
            identifier: tokenIdentifier,
            intent: 'app_password',
            user: userId,
            description: 'CloudTAK automatic certificate enrollment',
            expires: expirationDate.toISOString(),
            expiring: true
        },
        {
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            }
        }
    );
    
    // Get token key
    const keyResponse = await axios.get(
        `${apiUrl}/api/v3/core/tokens/${tokenIdentifier}/view_key/`,
        {
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            }
        }
    );
    
    return keyResponse.data.key;
}

// Helper function to get user groups from Authentik
async function getAuthentikUserGroups(
    username: string,
    authToken: string,
    authentikUrl: string
): Promise<{ groups: string[]; userId: number }> {
    const apiUrl = authentikUrl.endsWith('/') ? authentikUrl.slice(0, -1) : authentikUrl;
    
    const userResponse = await axios.get(
        `${apiUrl}/api/v3/core/users/?username=${encodeURIComponent(username)}`,
        { headers: { 'Authorization': `Bearer ${authToken}` } }
    );
    
    if (!userResponse.data.results?.[0]) return { groups: [], userId: 0 };
    
    const user = userResponse.data.results[0];
    const groupUuids = user.groups || [];
    const groups: string[] = [];
    
    for (const groupUuid of groupUuids) {
        try {
            const groupResponse = await axios.get(
                `${apiUrl}/api/v3/core/groups/${groupUuid}/`,
                { headers: { 'Authorization': `Bearer ${authToken}` } }
            );
            if (groupResponse.data.name) groups.push(groupResponse.data.name);
        } catch (err) {
            console.error(`Failed to fetch group ${groupUuid}:`, err);
        }
    }
    
    return { groups, userId: user.pk };
}

// Helper function to get user attributes from Authentik
async function getAuthentikUserAttributes(
    username: string,
    authToken: string,
    authentikUrl: string | undefined
): Promise<{ takCallsign?: string; takColor?: string }> {
    if (!authentikUrl) {
        throw new Error('Authentik URL is not configured');
    }
    const apiUrl = authentikUrl.endsWith('/') ? authentikUrl.slice(0, -1) : authentikUrl;
    
    const userResponse = await axios.get(
        `${apiUrl}/api/v3/core/users/?username=${encodeURIComponent(username)}`,
        {
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            }
        }
    );
    
    if (!userResponse.data.results || userResponse.data.results.length === 0) {
        return {};
    }
    
    const user = userResponse.data.results[0];
    const attributes = user.attributes || {};
    
    return {
        takCallsign: attributes.takCallsign,
        takColor: attributes.takColor
    };
}

// Helper function to check if certificate is expired or expiring soon
async function isCertificateExpired(certPem: string): Promise<boolean> {
    if (!certPem || certPem === '') return true;
    
    try {
        const cert = new X509Certificate(certPem);
        const validTo = cert.validTo;
        // Renew if expired or expiring within 7 days
        return moment(validTo, "MMM DD hh:mm:ss YYYY").isBefore(moment().add(7, 'days'));
    } catch (err) {
        console.error('Certificate validation error:', err);
        return true; // Treat invalid certificates as expired
    }
}
