import { X509Certificate } from 'crypto';
import { TAKAPI, APIAuthCertificate } from '@tak-ps/node-tak';

/**
 * The exception TAK Server reports when it rejects a client certificate it will
 * not honour - revoked, unknown, or issued by a CA it no longer trusts.
 *
 * Matched as a substring because TAK Server currently returns this inside a 500
 * body rather than a 401 status. Fragile by necessity; see isCertRejected().
 */
const BAD_CREDENTIALS = 'org.springframework.security.authentication.BadCredentialsException';

/** True when an error from TAK Server is a rejection of the client certificate. */
export function isBadCredentialsError(err: unknown): boolean {
    return err instanceof Error && err.message.includes(BAD_CREDENTIALS);
}

/**
 * Probe whether TAK Server still accepts a client certificate.
 *
 * Revocation is invisible locally: unlike expiry it cannot be read out of the
 * PEM, and TAK Server exposes no certificate-validity endpoint. So the only way
 * to know is to make a cheap authenticated call and see whether the credential
 * is refused - the same technique AuthProvider.valid() has always used.
 *
 * Returns true only for an authentication refusal. Anything else is re-thrown:
 * a TAK Server outage or a network error must not be read as "revoked", because
 * callers respond to that by re-enrolling, and re-enrolling on every login
 * during an outage would churn credentials for no reason.
 */
export async function isCertRejected(
    apiUrl: string | URL,
    cert: string,
    key: string,
): Promise<boolean> {
    const api = await TAKAPI.init(new URL(String(apiUrl)), new APIAuthCertificate(cert, key));

    try {
        await api.Contacts.list();
        return false;
    } catch (err) {
        if (isBadCredentialsError(err)) return true;
        throw err;
    }
}

export function needsCertRenewal(certPem: string, thresholdDays: number = 7): boolean {
    if (!certPem) return true;

    try {
        const cert = new X509Certificate(certPem);
        const daysLeft = (new Date(cert.validTo).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
        return daysLeft <= thresholdDays;
    } catch {
        return true;
    }
}
