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
