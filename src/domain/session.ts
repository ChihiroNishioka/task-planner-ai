import { createHmac, timingSafeEqual } from 'node:crypto';

const sessionDurationSeconds = 12 * 60 * 60;

export function createSessionToken(secret: string, email: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ email: email.toLowerCase(), exp: Math.floor(now / 1000) + sessionDurationSeconds })).toString('base64url');
  return `${payload}.${signature(secret, payload)}`;
}

export function isValidSessionToken(token: string | undefined, secret: string | undefined, allowedEmails: string, now = Date.now()): boolean {
  return getSessionEmail(token, secret, allowedEmails, now) !== null;
}

export function getSessionEmail(token: string | undefined, secret: string | undefined, allowedEmails: string, now = Date.now()): string | null {
  if (!token || !secret || secret.length < 32) return null;
  const [payload, suppliedSignature, extra] = token.split('.');
  if (!payload || !suppliedSignature || extra !== undefined) return null;
  const expectedSignature = signature(secret, payload);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null || !('email' in decoded) || !('exp' in decoded)) return null;
    return typeof decoded.email === 'string' && typeof decoded.exp === 'number' && Number.isSafeInteger(decoded.exp) && decoded.exp > Math.floor(now / 1000) && isAllowedEmail(decoded.email, allowedEmails) ? decoded.email : null;
  } catch {
    return null;
  }
}

function signature(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function isAllowedEmail(email: string, allowedEmails: string): boolean {
  const normalized = email.trim().toLowerCase();
  return normalized !== '' && allowedEmails.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean).includes(normalized);
}
