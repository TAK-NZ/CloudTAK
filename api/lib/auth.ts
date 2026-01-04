import { Request } from 'express';
import Err from '@openaddresses/batch-error';
import jwt from 'jsonwebtoken';
import Config from './config.js';
import { InferSelectModel } from 'drizzle-orm';
import type { Profile, Connection, Layer } from './schema.js';

export enum ResourceCreationScope {
    SERVER = 'server',
    USER = 'user'
}

export enum AuthUserAccess {
    ADMIN = 'admin',
    AGENCY = 'agency',
    USER = 'user'
}

function castUserAccessEnum(str: string): AuthUserAccess | undefined {
  const value = AuthUserAccess[str.toUpperCase() as keyof typeof AuthUserAccess];
  return value;
}

export type AuthResourceAccepted = {
    access: AuthResourceAccess;
    id?: string | number | undefined;
}

export enum AuthResourceAccess {
    DATA = 'data',
    LAYER = 'layer',
    IMPORT = 'import',
    LEASE = 'lease',
    BASEMAP = 'basemap',
    CONNECTION = 'connection',

    // Only used for media-infra <=> CloudTAK requests
    MEDIA = 'media',

    // Becomes AuthUser
    PROFILE = 'profile'
}

function castResourceAccessEnum(str: string): AuthResourceAccess | undefined {
  const value = AuthResourceAccess[str.toUpperCase() as keyof typeof AuthResourceAccess];
  return value;
}

export class AuthResource {
    id: number | string | undefined;
    access: AuthResourceAccess;
    token: string;
    internal: boolean;

    constructor(
        token: string,
        access: AuthResourceAccess,
        id: number | string | undefined,
        internal: boolean
    ) {
        this.token = token;
        this.internal = internal;
        this.access = access;
        this.id = id;
    }
}

export class AuthUser {
    access: AuthUserAccess;
    email: string;

    // Username of admin doing the impersonating - if this value is populated the calling user is guarenteed to be an admin
    impersonate?: string;

    constructor(access: AuthUserAccess, email: string) {
        this.access = access;
        this.email = email;
    }

    is_admin(): boolean {
        return this.access === AuthUserAccess.ADMIN
    }

    is_user(): boolean {
        return !!(this.email && this.email.length);
    }
}

/**
 * @class
 */
export default class Auth {
    /**
     * Is the requester authenticated - can be either a Resource or User auth
     *
     * @param config    - Server Config
     * @param req       - Express Request
     * @param opts.token        - Should URL query tokens be allowed (usually only for downloads)
     * @param opts.anyResources - Any Resource token can use this endpoint
     * @param resources         - Array of resource types that can use this endpoint
     */
    static async is_auth(config: Config, req: Request<any, any, any, any>, opts: {
        token?: boolean;
        anyResources?: boolean;
        resources?: Array<AuthResourceAccepted>;
    } = {}): Promise<AuthResource | AuthUser> {
        if (!opts.token) opts.token = false;
        if (!opts.resources) opts.resources = [];
        if (!opts.anyResources) opts.anyResources = false;

        const auth = await auth_request(config, req, { token: opts.token });

        if (!auth || !auth.access) {
            throw new Err(403, null, 'Authentication Required');
        }

        if (auth instanceof AuthResource) {
            const auth_resource = auth as AuthResource;

            if (opts.anyResources && opts.resources.length) {
                throw new Err(403, null, 'Server cannot specify defined resource access and any resource access together');
            } else if (!opts.anyResources && !opts.resources.length) {
                throw new Err(403, null, 'Resource token cannot access resource');
            }

            if (!auth_resource.internal) {
                try {
                    await config.models.ConnectionToken.from(auth_resource.token);
                } catch (err) {
                    if (err instanceof Error) {
                        throw new Err(403, err.name === 'PublicError' ? err : new Error(String(err)), 'Token does not exist');
                    } else {
                        throw new Err(500, new Error(String(err)), 'Unknown Token Error');
                    }
                }
            }

            if (!opts.anyResources && !opts.resources.some((r) => {
                if (r.id) {
                    return r.access === auth_resource.access && r.id === auth_resource.id;
                } else {
                    return r.access === auth_resource.access;
                }
            })) {
                throw new Err(403, null, 'Resource token cannot access this resource');
            }
        }

        return auth;
    }

    static async is_connection(config: Config, req: Request<any, any, any, any>, opts: {
        token?: boolean;
        resources?: Array<AuthResourceAccepted>;
    }, connectionid: number): Promise<{
        auth: AuthResource | AuthUser;
        connection: InferSelectModel<typeof Connection>;
        layer?: InferSelectModel<typeof Layer>;
        profile?: InferSelectModel<typeof Profile>;
    }> {
        const auth = await this.is_auth(config, req, opts)

        const connection = await config.models.Connection.from(connectionid);

        if (this.#is_user(auth)) {
            const profile = await this.#as_profile(config, auth as AuthUser);

            if (profile.system_admin === true) {
                return { connection, profile, auth };
            } else {
                if (!connection.agency) throw new Err(401, null, 'Only a System Admin can access this connection');
                if (!profile.agency_admin) throw new Err(401, null, 'Only an Agency Admin admin or higher can access connections');
                if (!profile.agency_admin.includes(connection.agency)) throw new Err(401, null, `You are not an Agency Admin for Agency ${connection.agency}`);

                return { connection, profile, auth };
            }
        } else {
            const auth_resource = auth as AuthResource;

            // If a resource token is used it's up to the caller to specify it is allowed via the resources array
            // is_auth will disallow resource tokens when no resource array is set

            if (auth_resource.access === AuthResourceAccess.LAYER) {
                const layer = await config.models.Layer.from(auth_resource.id);
                return { auth, connection, layer };
            } else {
                return { auth, connection };
            }
        }
    }

    static async is_user(config: Config, req: Request<any, any, any, any>): Promise<boolean> {
        const auth = await this.is_auth(config, req);
        return this.#is_user(auth);
    }

    static #is_user(auth: AuthResource | AuthUser): boolean {
        return auth instanceof AuthUser;
    }

    static async is_resource(config: Config, req: Request<any, any, any, any>): Promise<boolean> {
        const auth = await this.is_auth(config, req);
        return this.#is_resource(auth);
    }

    static #is_resource(auth: AuthResource | AuthUser): boolean {
        return auth instanceof AuthResource;
    }

    static async as_resource(config: Config, req: Request<any, any, any, any>, opts: {
        anyResources?: boolean;
        resources?: Array<AuthResourceAccepted>;
        token?: boolean;
    } = {}): Promise<AuthResource> {
        if (!opts.token) opts.token = false;
        const auth = await this.is_auth(config, req, opts);

        if (this.#is_user(auth)) throw new Err(401, null, 'Only a resource token can access this resource');

        return auth as AuthResource;
    }

    static async impersonate(
        config: Config,
        req: Request<any, any, any, any>,
        impersonate: string
    ): Promise<AuthUser> {
        const adminUser = await this.as_user(config, req, { admin: true });

        const imp = await config.models.Profile.from(impersonate);

        let access = AuthUserAccess.USER
        if (imp.agency_admin) access = AuthUserAccess.AGENCY;
        if (imp.system_admin) access = AuthUserAccess.ADMIN;

        const resolved = new AuthUser(access, impersonate);
        resolved.impersonate = adminUser.email;
        return resolved;
    }

    static async as_user(config: Config, req: Request<any, any, any, any>, opts: {
        token?: boolean;
        admin?: boolean;
    } = {}): Promise<AuthUser> {
        if (!opts.token) opts.token = false;
        const auth = await this.is_auth(config, req, { token: opts.token });

        if (this.#is_resource(auth)) throw new Err(401, null, 'Only an authenticated user can access this resource');

        const user = auth as AuthUser;

        if (opts.admin && user.access !== AuthUserAccess.ADMIN) {
            throw new Err(401, null, 'User must be a System Administrator to access this resource');
        }

        return user;
    }

    static async #as_profile(config: Config, user: AuthUser): Promise<InferSelectModel<typeof Profile>> {
        return await config.models.Profile.from(user.email);
    }

    static async as_profile(config: Config, req: Request<any, any, any, any>, opts: {
        token?: boolean;
        admin?: boolean;
    } = {}): Promise<InferSelectModel<typeof Profile>> {
        const user = await this.as_user(config, req, opts);
        return await this.#as_profile(config, user);
    }
}

async function auth_request(
    config: Config,
    req: Request<any, any, any, any>,
    opts?: {
        token: boolean
    }
): Promise<AuthResource | AuthUser> {
    try {
        if (req.headers && req.header('authorization')) {
            const authorization = (req.header('authorization') || '').split(' ');

            if (authorization[0].toLowerCase() !== 'bearer') {
                throw new Err(401, null, 'Only "Bearer" authorization header is allowed')
            }

            if (!authorization[1]) {
                throw new Err(401, null, 'No bearer token present');
            }

            return await tokenParser(config, authorization[1], config.SigningSecret);
        } else if (
            opts
            && opts.token
            && req.query
            && req.query.token
            && typeof req.query.token === 'string'
        ) {
            return await tokenParser(config, req.query.token, config.SigningSecret);
        } else {
            throw new Err(401, null, 'No Auth Present')
        }
    } catch (err) {
        if (err instanceof Error && err.name === 'PublicError') {
            throw err;
        } else {
            throw new Err(401, new Error(String(err)), 'Invalid Token')
        }
    }
}

export async function tokenParser(
    config: Config,
    token: string,
    secret: string
): Promise<AuthUser | AuthResource> {
    if (token.startsWith('etl.')) {
        token = token.replace(/^etl\./, '');
        const decoded = jwt.verify(token, secret);
        if (typeof decoded === 'string') throw new Err(400, null, 'Decoded JWT Should be Object');
        if (!decoded.access || typeof decoded.access !== 'string') throw new Err(401, null, 'Invalid Token');
        if (!decoded.internal || typeof decoded.internal !== 'boolean') decoded.internal = false;
        if (!decoded.internal && !decoded.id) throw new Err(401, null, 'Invalid Token');

        const access = castResourceAccessEnum(decoded.access);
        if (!access) throw new Err(400, null, 'Invalid Resource Access Value');

        if (access == AuthResourceAccess.PROFILE) {
            const profile = await config.models.Profile.from(decoded.id);

            if (profile.system_admin) {
                return new AuthUser(AuthUserAccess.ADMIN, profile.username);
            } else if (profile.agency_admin.length) {
                return new AuthUser(AuthUserAccess.AGENCY, profile.username);
            } else {
                return new AuthUser(AuthUserAccess.USER, profile.username);
            }
        } else {
            return new AuthResource(`etl.${token}`, access, decoded.id, decoded.internal);
        }
    } else {
        const decoded = jwt.verify(token, secret);
        if (typeof decoded === 'string') throw new Err(400, null, 'Decoded JWT Should be Object');
        if (!decoded.email || typeof decoded.email !== 'string') throw new Err(401, null, 'Invalid Token');
        if (!decoded.access || typeof decoded.access !== 'string') throw new Err(401, null, 'Invalid Token');

        const access = castUserAccessEnum(decoded.access);
        if (!access) throw new Err(400, null, 'Invalid User Access Value');

        const auth: {
            access: AuthUserAccess;
            email: string;
        } = {
            email: decoded.email,
            access
        };

        return new AuthUser(auth.access, auth.email);
    }
}

import { createPublicKey, createVerify, KeyObject } from 'crypto';
import axios from 'axios';

// Cache for ALB public keys (in-memory cache)
const albPublicKeys = new Map<string, string>();

// Fetch ALB public key for JWT verification
async function getAlbPublicKey(region: string, keyId: string): Promise<string> {
    const cacheKey = `${region}:${keyId}`;
    
    if (albPublicKeys.has(cacheKey)) {
        return albPublicKeys.get(cacheKey)!;
    }
    
    const url = `https://public-keys.auth.elb.${region}.amazonaws.com/${keyId}`;
    const response = await axios.get(url, { timeout: 5000 });
    
    if (!response.data) {
        throw new Error('Failed to fetch ALB public key');
    }
    
    albPublicKeys.set(cacheKey, response.data);
    return response.data;
}

// Verify JWT signature using ALB public key
function verifyJwtSignature(token: string, publicKeyPem: string): boolean {
    const [headerB64, payloadB64, signatureB64] = token.split('.');
    
    if (!headerB64 || !payloadB64 || !signatureB64) {
        throw new Error('Invalid JWT format');
    }
    
    try {
        const message = `${headerB64}.${payloadB64}`;
        // Convert base64url to base64
        const signatureBase64 = signatureB64.replace(/-/g, '+').replace(/_/g, '/');
        const signature = Buffer.from(signatureBase64, 'base64');
        
        // Create public key object
        const publicKey: KeyObject = createPublicKey({
            key: publicKeyPem,
            format: 'pem'
        });
        
        // Create verifier for ECDSA with SHA-256
        const verify = createVerify('SHA256');
        verify.update(message);
        verify.end();
        
        // Try verification with ieee-p1363 encoding (ALB uses this for ES256)
        try {
            const isValid = verify.verify(
                { key: publicKey, dsaEncoding: 'ieee-p1363' },
                signature
            );
            
            if (isValid) {
                return true;
            }
        } catch (err) {
            console.error('ieee-p1363 verification failed, trying DER:', err);
        }
        
        // Fallback: try with default DER encoding
        const verify2 = createVerify('SHA256');
        verify2.update(message);
        verify2.end();
        
        const isValid = verify2.verify(publicKey, signature);
        
        if (!isValid) {
            console.error('JWT signature verification failed with both encodings');
            console.error('Signature length:', signature.length, 'bytes');
        }
        
        return isValid;
    } catch (err) {
        console.error('Error during JWT signature verification:', err);
        throw err;
    }
}

// OIDC authentication parser for ALB OIDC headers with full security validation
export async function oidcParser(req: Request): Promise<{ user: AuthUser }> {
    // 1. Check if OIDC is enabled
    if (!process.env.ALB_OIDC_ENABLED || process.env.ALB_OIDC_ENABLED !== 'true') {
        throw new Err(404, null, 'OIDC authentication not enabled');
    }
    
    // 2. Validate OIDC data header exists
    const oidcData = req.headers['x-amzn-oidc-data'];
    if (!oidcData || typeof oidcData !== 'string') {
        throw new Err(401, null, 'No OIDC data');
    }
    
    // 3. Validate access token header exists (ensures request came through ALB)
    const accessToken = req.headers['x-amzn-oidc-accesstoken'];
    if (!accessToken) {
        throw new Err(401, null, 'No OIDC access token - request may not have come through ALB');
    }
    
    // 4. Extract and validate JWT header
    const [headerB64] = oidcData.split('.');
    if (!headerB64) {
        throw new Err(401, null, 'Invalid JWT format');
    }
    
    const header = JSON.parse(Buffer.from(headerB64, 'base64').toString());
    const keyId = header.kid;
    const alg = header.alg;
    
    if (!keyId) {
        throw new Err(401, null, 'No key ID in JWT header');
    }
    
    if (alg !== 'ES256') {
        throw new Err(401, null, `Invalid JWT algorithm: ${alg}. Expected ES256`);
    }
    
    // 5. Get ALB public key and verify signature
    const region = process.env.AWS_REGION || 'us-west-2';
    let publicKeyPem: string;
    
    try {
        publicKeyPem = await getAlbPublicKey(region, keyId);
    } catch (err) {
        throw new Err(401, err instanceof Error ? err : new Error(String(err)), 'Failed to fetch ALB public key');
    }
    
    let isValid: boolean;
    try {
        isValid = verifyJwtSignature(oidcData, publicKeyPem);
    } catch (err) {
        throw new Err(401, err instanceof Error ? err : new Error(String(err)), 'JWT signature verification failed');
    }
    
    if (!isValid) {
        throw new Err(401, null, 'Invalid JWT signature');
    }
    
    // 6. Decode and validate payload
    const payload = JSON.parse(
        Buffer.from(oidcData.split('.')[1], 'base64').toString()
    );
    
    console.log('OIDC Payload:', JSON.stringify(payload, null, 2));
    
    // 7. Validate token expiration
    if (payload.exp) {
        const now = Math.floor(Date.now() / 1000);
        if (payload.exp < now) {
            throw new Err(401, null, 'OIDC token expired');
        }
    }
    
    // 8. Validate issuer (if configured)
    const expectedIssuer = process.env.AUTHENTIK_URL;
    if (expectedIssuer && payload.iss) {
        // Normalize URLs for comparison (remove trailing slash)
        const normalizedExpected = expectedIssuer.replace(/\/$/, '');
        const normalizedActual = payload.iss.replace(/\/$/, '');
        
        // Check if issuer starts with the expected base URL
        // This allows for application-specific issuer paths like /application/o/cloudtak/
        if (!normalizedActual.startsWith(normalizedExpected)) {
            throw new Err(401, null, `Invalid token issuer: ${payload.iss}`);
        }
    }
    
    // 9. Validate email claim
    if (!payload.email) {
        throw new Err(401, null, 'No email in OIDC data');
    }
    
    return {
        user: new AuthUser(AuthUserAccess.USER, payload.email)
    };
}

// Helper to check if OIDC is enabled
export function isOidcEnabled(): boolean {
    return process.env.ALB_OIDC_ENABLED === 'true';
}

// Helper to check if OIDC is forced (only system admins can use local login)
export function isOidcForced(): boolean {
    return process.env.OIDC_FORCED === 'true';
}

