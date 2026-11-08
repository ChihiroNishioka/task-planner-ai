import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../src/proxy';
import { validateCsrfRequest } from '../src/lib/auth';

describe('proxy の保護範囲', () => {
  it('拡張子付きのパスでも未ログインならページは /login、API は 401', () => {
    const api = proxy(new NextRequest('http://app.example/api/tasks/abc.png'));
    expect(api.status).toBe(401);
    const page = proxy(new NextRequest('http://app.example/tasks/abc.css'));
    expect(page.status).toBe(307);
    expect(page.headers.get('location')).toContain('/login');
  });
  it('Next の静的ファイルは通す', () => {
    const asset = proxy(new NextRequest('http://app.example/_next/static/chunks/app.js'));
    expect(asset.headers.get('x-middleware-next')).toBe('1');
  });
});

describe('Origin 検査（リバースプロキシ配下）', () => {
  it('x-forwarded-proto が無くても、ホストが一致すれば https の Origin を受け付ける', () => {
    const request = new Request('http://127.0.0.1:3320/api/auth/session', { method: 'POST', headers: { host: 'app.example', origin: 'https://app.example', 'content-type': 'application/json' } });
    expect(validateCsrfRequest(request)).toBe(true);
  });
  it('x-forwarded-proto がある場合は protocol も一致を求める', () => {
    const request = new Request('http://127.0.0.1:3320/api/auth/session', { method: 'POST', headers: { host: 'app.example', 'x-forwarded-proto': 'https', origin: 'http://app.example', 'content-type': 'application/json' } });
    expect(validateCsrfRequest(request)).toBe(false);
  });
});

describe('レビュー指摘への追加', () => {
  it('制御文字や不正な値を含む next は / にする', async () => {
    const { isSafeNextPath } = await import('../src/lib/auth-next');
    expect(isSafeNextPath('/\t/evil.example')).toBe('/');
    expect(isSafeNextPath('/\n/evil.example')).toBe('/');
    expect(isSafeNextPath('/tasks/1?x=2')).toBe('/tasks/1?x=2');
    expect(isSafeNextPath(['/a', '/b'])).toBe('/');
    expect(isSafeNextPath(undefined)).toBe('/');
  });
  it('期限を過ぎた ID トークンは許容差なしで拒否し、Google 以外のログイン方法も拒否する', async () => {
    const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } = await import('jose');
    const { verifyFirebaseIdToken } = await import('../src/lib/auth');
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256' }] });
    const now = Math.floor(Date.now() / 1000);
    const sign = (claims: Record<string, unknown>, exp: number) => new SignJWT({ email: 'owner@example.com', email_verified: true, firebase: { sign_in_provider: 'google.com' }, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k' }).setIssuer('https://securetoken.google.com/p').setAudience('p').setSubject('u1').setIssuedAt(now - 600).setExpirationTime(exp).sign(privateKey);
    expect(await verifyFirebaseIdToken(await sign({}, now + 300), 'p', 'owner@example.com', keys)).toEqual({ ok: true, email: 'owner@example.com' });
    expect((await verifyFirebaseIdToken(await sign({}, now - 30), 'p', 'owner@example.com', keys)).ok).toBe(false);
    expect((await verifyFirebaseIdToken(await sign({ firebase: { sign_in_provider: 'password' } }, now + 300), 'p', 'owner@example.com', keys)).ok).toBe(false);
  });
});
