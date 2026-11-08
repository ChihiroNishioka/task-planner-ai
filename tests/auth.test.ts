import { describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { isSafeNextPath, validateCsrfRequest, verifyFirebaseIdToken, verifyTestIdToken } from '../src/lib/auth';
import { isAllowedEmail } from '../src/domain/session';
import { POST } from '../src/app/api/auth/session/route';

describe('認証境界', () => {
  it('空の許可リストは拒否し、大文字小文字を区別しない', () => {
    expect(isAllowedEmail('owner@example.com', '')).toBe(false);
    expect(isAllowedEmail('Owner@Example.com', ' other@example.com, owner@example.com ')).toBe(true);
  });
  it('next の外部 URL と protocol-relative path を拒否する', () => {
    expect(isSafeNextPath('/tasks/1')).toBe('/tasks/1');
    expect(isSafeNextPath('//evil.example')).toBe('/');
    expect(isSafeNextPath('/\\evil.example')).toBe('/');
    expect(isSafeNextPath('https://evil.example')).toBe('/');
  });
  it('Origin、JSON、Fetch Metadata を検査する', () => {
    const request = (origin: string, type = 'application/json', site = 'same-origin') => new Request('https://app.example/api/auth/session', { method: 'POST', headers: { host: 'app.example', origin, 'content-type': type, 'sec-fetch-site': site } });
    expect(validateCsrfRequest(request('https://app.example'))).toBe(true);
    expect(validateCsrfRequest(request('https://evil.example'))).toBe(false);
    expect(validateCsrfRequest(request('https://app.example', 'text/plain'))).toBe(false);
    expect(validateCsrfRequest(request('https://app.example', 'application/json', 'cross-site'))).toBe(false);
  });
  it('RSA署名トークンの issuer、audience、期限、確認済みメールを検証する', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const keySet = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] });
    const now = Math.floor(Date.now() / 1000);
    const makeToken = (claims: Record<string, unknown>, alg = 'RS256', issuer = 'https://securetoken.google.com/project-a', audience = 'project-a', expiresAt = now + 300) => {
      const token = new SignJWT({ email: 'owner@example.com', email_verified: true, ...claims }).setProtectedHeader({ alg, kid: 'test-key' }).setIssuer(issuer).setAudience(audience).setSubject('user-1').setIssuedAt(now).setExpirationTime(expiresAt);
      return alg === 'HS256' ? token.sign(new TextEncoder().encode('not-a-valid-firebase-key')) : token.sign(privateKey);
    };
    expect(await verifyFirebaseIdToken(await makeToken({}), 'project-a', 'OWNER@example.com', keySet)).toEqual({ ok: true, email: 'owner@example.com' });
    expect(await verifyFirebaseIdToken(await makeToken({ email_verified: false }), 'project-a', 'owner@example.com', keySet)).toMatchObject({ ok: false, reason: 'unverified' });
    expect(await verifyFirebaseIdToken(await makeToken({}), 'project-b', 'owner@example.com', keySet)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await verifyFirebaseIdToken(await makeToken({}, 'HS256'), 'project-a', 'owner@example.com', keySet)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await verifyFirebaseIdToken(await makeToken({}, 'RS256', 'https://securetoken.google.com/other', 'project-a'), 'project-a', 'owner@example.com', keySet)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await verifyFirebaseIdToken(await makeToken({}, 'RS256', 'https://securetoken.google.com/project-a', 'other'), 'project-a', 'owner@example.com', keySet)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await verifyFirebaseIdToken(await makeToken({}, 'RS256', 'https://securetoken.google.com/project-a', 'project-a', now - 60), 'project-a', 'owner@example.com', keySet)).toMatchObject({ ok: false, reason: 'expired' });
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'test-key' })).toString('base64url')}.${Buffer.from(JSON.stringify({ email: 'owner@example.com', email_verified: true, sub: 'user-1', iss: 'https://securetoken.google.com/project-a', aud: 'project-a', iat: now, exp: now + 300 })).toString('base64url')}.`;
    expect(await verifyFirebaseIdToken(unsigned, 'project-a', 'owner@example.com', keySet)).toMatchObject({ ok: false, reason: 'invalid' });
  });
  it('テスト検証器は期限切れ、偽造、未確認、許可外を拒否する', async () => {
    expect(await verifyTestIdToken('test:expired', 'owner@example.com')).toMatchObject({ ok: false, reason: 'expired' });
    expect(await verifyTestIdToken('fake-token', 'owner@example.com')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await verifyTestIdToken('test:owner@example.com:unverified', 'owner@example.com')).toMatchObject({ ok: false, reason: 'unverified' });
    expect(await verifyTestIdToken('test:owner@example.com:verified', '')).toMatchObject({ ok: false, reason: 'not_allowed' });
  });
  it('本番のテストモードと未知の認証モードではセッション発行を拒否する', async () => {
    const original = { authMode: process.env.AUTH_MODE, secret: process.env.SESSION_SECRET };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('NODE_ENV', 'production'); process.env.AUTH_MODE = 'test'; process.env.SESSION_SECRET = 's'.repeat(48);
    try {
      const request = new Request('http://app.example/api/auth/session', { method: 'POST', headers: { host: 'app.example', origin: 'http://app.example', 'content-type': 'application/json' }, body: JSON.stringify({ idToken: 'test:owner@example.com:verified' }) });
      const response = await POST(request);
      expect(response.status).toBe(503);
      expect(log).toHaveBeenCalledOnce();
      process.env.AUTH_MODE = 'unsupported';
      expect((await POST(request)).status).toBe(503);
    } finally {
      vi.unstubAllEnvs();
      if (original.authMode === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = original.authMode;
      if (original.secret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = original.secret;
      log.mockRestore();
    }
  });
});
