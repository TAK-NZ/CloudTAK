import jwt from 'jsonwebtoken';
import Err from '@openaddresses/batch-error';
import { randomBytes } from 'crypto';
import Schema from '@openaddresses/batch-schema';
import { Type } from '@sinclair/typebox';
import Config from '../lib/config.js';
import { AuthUserAccess } from '../lib/auth.js';

// Simple in-memory store for state validation
const stateStore = new Map<string, {
    nonce: string;
    redirect_uri: string;
    created: number;
}>();

// Clean up expired states every 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const [state, data] of stateStore.entries()) {
        if (now - data.created > 10 * 60 * 1000) { // 10 minutes
            stateStore.delete(state);
        }
    }
}, 10 * 60 * 1000);

export default async function router(schema: Schema, config: Config) {
    const oidcConfig = {
        enabled: !!process.env.OIDC_AUTHORIZE_URL,
        client_id: process.env.OIDC_CLIENT_ID,
        client_secret: process.env.OIDC_CLIENT_SECRET,
        authorize_url: process.env.OIDC_AUTHORIZE_URL,
        token_url: process.env.OIDC_TOKEN_URL,
        provider_name: process.env.OIDC_PROVIDER_NAME || 'SSO'
    };

    await schema.get('/auth/oidc/config', {
        name: 'Get OIDC Config',
        group: 'OIDC',
        description: 'Get OIDC configuration for client',
        res: Type.Object({
            enabled: Type.Boolean(),
            provider_name: Type.Optional(Type.String()),
            client_id: Type.Optional(Type.String()),
            authorize_url: Type.Optional(Type.String()),
            token_url: Type.Optional(Type.String())
        })
    }, async (req, res) => {
        if (!oidcConfig.enabled) {
            res.json({ enabled: false });
            return;
        }

        res.json({
            enabled: oidcConfig.enabled,
            provider_name: oidcConfig.provider_name,
            client_id: oidcConfig.client_id,
            authorize_url: oidcConfig.authorize_url,
            token_url: oidcConfig.token_url
        });
    });

    await schema.post('/auth/oidc/authorize', {
        name: 'OIDC Authorize',
        group: 'OIDC',
        description: 'Get OIDC authorization URL',
        body: Type.Object({
            redirect_uri: Type.String({
                description: 'Redirect URI for OIDC callback'
            })
        }),
        res: Type.Object({
            url: Type.String(),
            state: Type.String()
        })
    }, async (req, res) => {
        if (!oidcConfig.enabled) {
            throw new Err(404, null, 'OIDC not configured');
        }

        if (!oidcConfig.client_id || !oidcConfig.authorize_url) {
            throw new Err(500, null, 'OIDC configuration incomplete');
        }

        const state = randomBytes(32).toString('hex');
        const nonce = randomBytes(32).toString('hex');

        // Store state for validation (expires in 10 minutes)
        stateStore.set(state, {
            nonce,
            redirect_uri: req.body.redirect_uri,
            created: Date.now()
        });

        const authUrl = new URL(oidcConfig.authorize_url);
        authUrl.searchParams.set('client_id', oidcConfig.client_id);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('scope', 'openid profile email');
        authUrl.searchParams.set('redirect_uri', req.body.redirect_uri);
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('nonce', nonce);

        res.json({
            url: authUrl.toString(),
            state
        });
    });

    await schema.post('/auth/oidc/callback', {
        name: 'OIDC Callback',
        group: 'OIDC',
        description: 'Handle OIDC callback and create session',
        body: Type.Object({
            code: Type.String({
                description: 'Authorization code from OIDC provider'
            }),
            state: Type.String({
                description: 'State parameter to prevent CSRF'
            }),
            redirect_uri: Type.String({
                description: 'Redirect URI used in authorization request'
            })
        }),
        res: Type.Object({
            token: Type.String(),
            access: Type.Enum(AuthUserAccess),
            email: Type.String()
        })
    }, async (req, res) => {
        try {
            if (!oidcConfig.enabled) {
                throw new Err(404, null, 'OIDC not configured');
            }

            if (!oidcConfig.client_id || !oidcConfig.client_secret || !oidcConfig.token_url) {
                throw new Err(500, null, 'OIDC configuration incomplete');
            }

            const { code, state, redirect_uri } = req.body;

            // Validate state
            const stateData = stateStore.get(state);
            if (!stateData) {
                throw new Err(400, null, 'Invalid or expired state parameter');
            }
            stateStore.delete(state);

            if (stateData.redirect_uri !== redirect_uri) {
                throw new Err(400, null, 'Redirect URI mismatch');
            }

            // Exchange code for tokens
            const tokenResponse = await fetch(oidcConfig.token_url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    client_id: oidcConfig.client_id,
                    client_secret: oidcConfig.client_secret,
                    code,
                    redirect_uri
                })
            });

            if (!tokenResponse.ok) {
                const error = await tokenResponse.text();
                throw new Err(400, null, `Failed to exchange code for token: ${error}`);
            }

            const tokens = await tokenResponse.json();
            
            if (!tokens.id_token) {
                throw new Err(400, null, 'No ID token received from OIDC provider');
            }

            // Decode ID token (To do: verify the signature)
            const idToken = jwt.decode(tokens.id_token) as any;
            if (!idToken) {
                throw new Err(400, null, 'Invalid ID token format');
            }

            // Verify nonce
            if (idToken.nonce !== stateData.nonce) {
                throw new Err(400, null, 'Invalid nonce in ID token');
            }

            if (!idToken.email) {
                throw new Err(400, null, 'Email claim not found in ID token');
            }

            // Get or create user profile
            let profile;
            try {
                profile = await config.models.Profile.from(idToken.email);
                
                // Update last login
                await config.models.Profile.commit(idToken.email, {
                    last_login: new Date().toISOString(),
                    // Update display name if available
                    ...(idToken.name && { display_name: idToken.name })
                });
            } catch {
                // Profile doesn't exist, create new one
                // That one needs to be expanded to use the Token
                // with the TAK server to get the x.509 certificate
                console.log(`Creating new profile for OIDC user: ${idToken.email}`);
                
                await config.models.Profile.commit(idToken.email, {
                    system_admin: false,
                    agency_admin: [],
                    last_login: new Date().toISOString(),
                    display_name: idToken.name || idToken.preferred_username || idToken.email.split('@')[0]
                });

                profile = await config.models.Profile.from(idToken.email);
            }

            // Determine access level
            let access = AuthUserAccess.USER;
            if (profile.system_admin) {
                access = AuthUserAccess.ADMIN;
            } else if (profile.agency_admin && profile.agency_admin.length) {
                access = AuthUserAccess.AGENCY;
            }

            // Generate JWT token
            const token = jwt.sign(
                { 
                    access, 
                    email: profile.username 
                }, 
                config.SigningSecret, 
                { expiresIn: '16h' }
            );

            res.json({
                token,
                access,
                email: profile.username
            });
        } catch (err) {
            Err.respond(err, res);
        }
    });
}
