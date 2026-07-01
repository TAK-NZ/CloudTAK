import jwt from 'jsonwebtoken';
import Err from '@openaddresses/batch-error';
import Auth, { AuthUserAccess, oidcParser, isOidcEnabled, isOidcForced } from '../lib/auth.js';
import Config from '../lib/config.js';
import Schema from '@openaddresses/batch-schema';
import { Type } from '@sinclair/typebox';
import Provider from '../lib/provider.js';
import ProfileControl from '../lib/control/profile.js';
import { UAParser } from 'ua-parser-js';

export default async function router(schema: Schema, config: Config) {
    await schema.post('/login', {
        name: 'Create Login',
        group: 'Login',
        body: Type.Object({
            username: Type.String({
                description: 'Case-Sensitive username, if an email, the client MUST lowercase',
            }),
            password: Type.String(),
        }),
        res: Type.Object({
            token: Type.String(),
            access: Type.Enum(AuthUserAccess),
            email: Type.String(),
            session: Type.String(),
        }),
    }, async (req, res) => {
        try {
            const oidc = await config.models.Setting.typedMany({
                'oidc::enabled': false,
                'oidc::enforced': false,
            });

            if (oidc['oidc::enabled'] && oidc['oidc::enforced']) {
                throw new Err(403, null, 'Username/Password login is disabled - Please use SSO');
            }

            let profile;

            if (config.server.auth.key && config.server.auth.cert && config.server.webtak) {
                const provider = new Provider(config);
                const email = await provider.login(req.body.username, req.body.password);

                const cotak = config.user?.get('cotak');
                if (cotak && cotak.configured) {
                    try {
                        const response = await cotak.login(email);

                        await config.models.Profile.commit(email, {
                            ...response,
                            last_login: new Date().toISOString(),
                        });
                    } catch (err) {
                        console.error(err);

                        await config.models.Profile.commit(email, {
                            last_login: new Date().toISOString(),
                        });
                    }
                } else {
                    await config.models.Profile.commit(email, {
                        last_login: new Date().toISOString(),
                    });
                }

                profile = await config.models.Profile.from(email);
            } else {
                throw new Err(400, null, 'Server has not been configured');
            }

            let access = AuthUserAccess.USER;
            if (profile.system_admin) {
                access = AuthUserAccess.ADMIN;
            } else if (profile.agency_admin && profile.agency_admin.length) {
                access = AuthUserAccess.AGENCY;
            }

            const userAgent = req.headers['user-agent'] || '';
            const ua = UAParser(userAgent);

            const session = await config.models.ProfileSession.generate({
                username: profile.username,
                created: new Date().toISOString(),
                ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown'),
                device_type: ua.device.type || 'Desktop',
                browser: [ua.browser.name, ua.browser.version].filter(Boolean).join(' ') || 'Unknown',
                os: [ua.os.name, ua.os.version].filter(Boolean).join(' ') || 'Unknown',
                user_agent: userAgent,
            });

            res.json({
                access,
                email: profile.username,
                session: session.id,
                token: jwt.sign({ access, email: profile.username, s: session.id }, config.SigningSecret, { expiresIn: '16h' }),
            });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/login', {
        name: 'Get Login',
        group: 'Login',
        res: Type.Object({
            email: Type.String(),
            access: Type.Enum(AuthUserAccess),
        }),
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);

            const profile = await config.models.Profile.from(user.email);

            // If the server hasn't been configured the user won't have a valid cert
            if (config.server.auth.key && config.server.auth.cert) {
                const provider = new Provider(config);
                await provider.valid(profile);
            }

            res.json({
                email: user.email,
                access: user.access,
            });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    /**
     * ALB OIDC authentication endpoint.
     * The ALB handles the OIDC redirect with the IdP and adds x-amzn-oidc-data
     * headers. This route validates those headers, creates/updates the user
     * profile, and redirects to the frontend with a signed JWT.
     */
    await schema.get('/login/oidc', {
        name: 'OIDC Login',
        group: 'Login',
        description: 'ALB OIDC authentication - validates ALB headers and issues a JWT',
        query: Type.Object({
            redirect: Type.Optional(Type.String()),
            error: Type.Optional(Type.String()),
        }),
    }, async (req, res) => {
        const redirectTarget = req.query.redirect || '/';

        try {
            if (!isOidcEnabled()) {
                throw new Err(403, null, 'OIDC authentication is not enabled');
            }

            const { user: auth, groups } = await oidcParser(req as import('express').Request);
            const email = auth.email;

            // Block accounts configured for local-only login
            const localOnlyAccounts = (process.env.LOCAL_ONLY_ACCOUNTS || '')
                .split(',').map((a: string) => a.trim()).filter(Boolean);
            if (localOnlyAccounts.includes(email)) {
                return res.redirect(`/login?error=${encodeURIComponent('This account requires local login. Use /login?local=true')}`);
            }

            // Parse group membership for role assignment
            const systemAdminGroup = process.env.OIDC_SYSTEM_ADMIN_GROUP || 'CloudTAKSystemAdmin';
            const agencyAdminPrefix = process.env.OIDC_AGENCY_ADMIN_GROUP_PREFIX || 'CloudTAKAgencyAdmin';

            const isSystemAdmin = groups.includes(systemAdminGroup);
            const agencyAdminIds: number[] = [];
            for (const group of groups) {
                if (group.startsWith(agencyAdminPrefix)) {
                    const agencyId = parseInt(group.substring(agencyAdminPrefix.length), 10);
                    if (!isNaN(agencyId) && agencyId > 0) agencyAdminIds.push(agencyId);
                }
            }

            const profileControl = new ProfileControl(config);
            let profile;

            try {
                profile = await config.models.Profile.from(email);

                // Update group membership on every login
                await config.models.Profile.commit(email, {
                    system_admin: isSystemAdmin,
                    agency_admin: agencyAdminIds,
                    last_login: new Date().toISOString(),
                });
                profile = await config.models.Profile.from(email);
            } catch (err) {
                if (err instanceof Error && err.message.includes('Item Not Found')) {
                    // First OIDC login — auto-create profile using ProfileControl
                    // to inherit any admin-configured system defaults
                    profile = await profileControl.generate({
                        username: email,
                        auth: { ca: [], key: '', cert: '' },
                        system_admin: isSystemAdmin,
                        agency_admin: agencyAdminIds,
                        last_login: new Date().toISOString(),
                    });
                } else {
                    throw err;
                }
            }

            // Sync Authentik attributes if configured
            if (process.env.SYNC_AUTHENTIK_ATTRIBUTES_ON_LOGIN === 'true'
                && process.env.AUTHENTIK_API_TOKEN_SECRET_ARN
                && process.env.AUTHENTIK_URL) {
                try {
                    const AuthentikProvider = (await import('../lib/authentik-provider.js')).default;
                    const authentik = await AuthentikProvider.init(config);
                    const userInfo = await authentik.login(email);

                    const updates: Record<string, unknown> = {};
                    if (userInfo.tak_callsign) {
                        updates.tak_callsign = userInfo.tak_callsign;
                        updates.tak_remarks = userInfo.tak_callsign;
                    }
                    if (userInfo.tak_group) updates.tak_group = userInfo.tak_group;

                    if (Object.keys(updates).length > 0) {
                        await config.models.Profile.commit(email, updates);
                        profile = await config.models.Profile.from(email);
                    }
                } catch (err) {
                    console.error('Authentik attribute sync error (continuing):', err);
                }
            }

            let access = AuthUserAccess.USER;
            if (profile.system_admin) {
                access = AuthUserAccess.ADMIN;
            } else if (profile.agency_admin && profile.agency_admin.length) {
                access = AuthUserAccess.AGENCY;
            }

            const userAgent = req.headers['user-agent'] || '';
            const ua = UAParser(userAgent);
            const session = await config.models.ProfileSession.generate({
                username: profile.username,
                created: new Date().toISOString(),
                ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown'),
                device_type: ua.device.type || 'Desktop',
                browser: [ua.browser.name, ua.browser.version].filter(Boolean).join(' ') || 'Unknown',
                os: [ua.os.name, ua.os.version].filter(Boolean).join(' ') || 'Unknown',
                user_agent: userAgent,
            });

            const token = jwt.sign(
                { access, email: profile.username, s: session.id },
                config.SigningSecret,
                { expiresIn: '16h' }
            );

            const safeRedirect = String(redirectTarget).startsWith('/') ? String(redirectTarget) : '/';
            return res.redirect(`/login?token=${encodeURIComponent(token)}&redirect=${encodeURIComponent(safeRedirect)}`);
        } catch (err) {
            console.error('OIDC login error:', err);
            const errorMsg = err instanceof Error ? err.message : 'OIDC authentication failed';
            return res.redirect(`/login?error=${encodeURIComponent(errorMsg)}`);
        }
    });

    /**
     * Logout endpoint — expires ALB OIDC session cookies and redirects to the
     * IdP end-session endpoint (if configured) or to /login.
     */
    await schema.get('/logout', {
        name: 'Logout',
        group: 'Login',
        description: 'Logout and clear ALB OIDC session cookies',
    }, async (req, res) => {
        try {
            const cookieName = process.env.ALB_AUTH_SESSION_COOKIE || 'AWSELBAuthSessionCookie';
            const cookieOptions = { path: '/', httpOnly: true, secure: true, maxAge: -1 };

            // ALB can create up to 4 cookie shards (0–3)
            for (let i = 0; i < 4; i++) {
                res.cookie(`${cookieName}-${i}`, '', cookieOptions);
            }

            if (process.env.AUTHENTIK_URL && process.env.AUTHENTIK_APP_SLUG) {
                const authentikBase = process.env.AUTHENTIK_URL.replace(/\/$/, '');
                return res.redirect(`${authentikBase}/application/o/${process.env.AUTHENTIK_APP_SLUG}/end-session/`);
            }

            return res.redirect('/login');
        } catch (err) {
            console.error('Logout error:', err);
            Err.respond(err, res);
        }
    });
}
