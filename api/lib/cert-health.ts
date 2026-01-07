import { X509Certificate } from 'crypto';

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
