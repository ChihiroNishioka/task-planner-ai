import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { isAllowedEmail } from '../domain/session';

const firebaseJwks = createRemoteJWKSet(new URL(`https://www.googleapis.com/service_accounts/v1/jwk/securetoken${'@'}system.gserviceaccount.com`));
export type TokenRejection = 'invalid' | 'unverified' | 'not_allowed' | 'expired';
export type TokenResult = { ok: true; email: string } | { ok: false; reason: TokenRejection };

export async function verifyFirebaseIdToken(token: string, projectId: string, allowedEmails: string, jwks: JWTVerifyGetKey = firebaseJwks): Promise<TokenResult> {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, jwks, {
      algorithms: ['RS256'], issuer: `https://securetoken.google.com/${projectId}`, audience: projectId,
    });
    if (protectedHeader.alg !== 'RS256' || !hasValidTimes(payload) || typeof payload.sub !== 'string' || payload.sub.trim() === '') return { ok: false, reason: 'invalid' };
    if (!isGoogleSignIn(payload)) return { ok: false, reason: 'invalid' };
    if (typeof payload.email !== 'string' || payload.email_verified !== true) return { ok: false, reason: 'unverified' };
    if (!isAllowedEmail(payload.email, allowedEmails)) return { ok: false, reason: 'not_allowed' };
    return { ok: true, email: payload.email };
  } catch (error) {
    if (error instanceof Error && error.name === 'JWTExpired') return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'invalid' };
  }
}

export async function verifyTestIdToken(token: string, allowedEmails: string): Promise<TokenResult> {
  if (token === 'test:expired') return { ok: false, reason: 'expired' };
  const match = /^test:([^:]+):(verified|unverified)$/.exec(token);
  if (!match) return { ok: false, reason: 'invalid' };
  if (match[2] === 'unverified') return { ok: false, reason: 'unverified' };
  return isAllowedEmail(match[1], allowedEmails) ? { ok: true, email: match[1] } : { ok: false, reason: 'not_allowed' };
}

export { isSafeNextPath } from './auth-next';

export function validateCsrfRequest(request: Request): boolean {
  const headers = request.headers;
  if (headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return false;
  if (headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') return false;
  const host = headers.get('x-forwarded-host')?.split(',')[0].trim() || headers.get('host');
  const origin = headers.get('origin');
  if (!host || !origin) return false;
  try {
    const originUrl = new URL(origin);
    if (originUrl.host.toLowerCase() !== host.toLowerCase()) return false;
    // TLS 終端のリバースプロキシ（Tailscale Funnel）配下では request.url が http になるため、
    // protocol はプロキシが x-forwarded-proto を付けたときだけ照合する。
    const forwardedProto = headers.get('x-forwarded-proto')?.split(',')[0].trim();
    return !forwardedProto || originUrl.protocol === `${forwardedProto}:`;
  } catch {
    return false;
  }
}

function hasValidTimes(payload: JWTPayload): boolean {
  const now = Math.floor(Date.now() / 1000);
  return typeof payload.exp === 'number' && typeof payload.iat === 'number' && Number.isFinite(payload.exp) && Number.isFinite(payload.iat) && payload.iat <= now + 60;
}

function isGoogleSignIn(payload: JWTPayload): boolean {
  const firebase = payload.firebase;
  return typeof firebase === 'object' && firebase !== null && 'sign_in_provider' in firebase && firebase.sign_in_provider === 'google.com';
}
