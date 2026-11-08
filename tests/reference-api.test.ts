import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReferenceStore } from '../src/adapters/reference-store';
import { TaskStore } from '../src/adapters/task-store';
import type { FetchResult } from '../src/domain/references';
import { createReferenceApi } from '../src/adapters/reference-api';

let dir: string; let store: ReferenceStore; let tasks: TaskStore; let id: string;
const origin = 'http://127.0.0.1:3350';
const testSecret = createHash('sha256').update('reference-api-local-test').digest('base64url');
function request(path: string, method = 'GET', body?: unknown, authenticated = true, extra: Record<string, string> = {}) {
  const payload = Buffer.from(JSON.stringify({ email: 'owner@example.com', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
  const value = `${payload}.${createHmac('sha256', testSecret).update(payload).digest('base64url')}`;
  return new Request(origin + path, { method, headers: { host: '127.0.0.1:3350', origin, 'content-type': 'application/json', ...(authenticated ? { cookie: `task-planner-session=${value}` } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
beforeEach(() => {
  vi.stubEnv('AUTH_MODE', 'test'); vi.stubEnv('SESSION_SECRET', testSecret); vi.stubEnv('ALLOWED_EMAILS', 'owner@example.com');
  dir = mkdtempSync(join(tmpdir(), 'reference-api-')); tasks = new TaskStore(join(dir, 'db.sqlite')); store = new ReferenceStore(join(dir, 'db.sqlite')); id = tasks.create({ title: '資料' }).id;
});
afterEach(() => { store.close(); tasks.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function api(fetch: (url: string) => Promise<FetchResult> = vi.fn(async (): Promise<FetchResult> => ({ ok: false, code: 'BLOCKED_URL' }))) { return createReferenceApi({ tasks, store, fetcher: { mode: 'fixture', fetch } }); }
it('AUTH-01 未認証の5操作は401、DB変更と取得なし', async () => {
  const fetch = vi.fn(); const routes = api(fetch);
  for (const [method, refId, action] of [['GET', undefined, undefined], ['POST', undefined, undefined], ['PATCH', 'none', undefined], ['DELETE', 'none', undefined], ['POST', 'none', 'refetch']] as const) {
    expect((await routes.handle(request('/', method, undefined, false), id, refId, action)).status).toBe(401);
  }
  expect(store.list(id)).toEqual([]); expect(fetch).not.toHaveBeenCalled();
});
it('AUTH-03 Origin不一致は403、登録後にNOTE編集競合と別タスク404', async () => {
  const routes = api();
  expect((await routes.handle(request('/', 'POST', { kind: 'NOTE', body: '本文' }, true, { origin: 'http://example.com' }), id)).status).toBe(403);
  const saved = await routes.handle(request('/', 'POST', { kind: 'NOTE', body: '本文' }), id);
  expect(saved.status).toBe(201);
  const note = (await saved.json()).reference;
  expect((await routes.handle(request('/', 'PATCH', { body: '更新', revision: 1 }), id, note.id)).status).toBe(200);
  expect((await routes.handle(request('/', 'PATCH', { body: '古い', revision: 1 }), id, note.id)).status).toBe(409);
  const other = tasks.create({ title: '別' }).id;
  expect((await routes.handle(request('/', 'DELETE'), other, note.id)).status).toBe(404);
});
it('URL-03/13 不正形式は保存せずSSRF拒否はURL保存・固定文の失敗', async () => {
  const routes = api();
  for (const url of ['ftp://example.com/', 'https://user:pass@example.com/', 'https://example.com/' + 'a'.repeat(2048)]) expect((await routes.handle(request('/', 'POST', { kind: 'URL', url }), id)).status).toBe(422);
  const response = await routes.handle(request('/', 'POST', { kind: 'URL', url: 'http://127.0.0.1/' }), id);
  expect(response.status).toBe(201);
  expect((await response.json()).reference).toMatchObject({ url: 'http://127.0.0.1/', fetchStatus: 'FAILED', fetchErrorCode: 'BLOCKED_URL' });
  expect(store.list(id)).toHaveLength(1);
});
it('URL-12 4件目は429、同じ操作キーで再取得しない', async () => {
  let finish!: (value: { ok: false; code: 'TIMEOUT' }) => void;
  const deferred = new Promise<{ ok: false; code: 'TIMEOUT' }>(resolve => { finish = resolve; });
  const fetch = vi.fn(() => deferred); const routes = api(fetch);
  const pending = Array.from({ length: 3 }, (_, i) => routes.handle(request('/', 'POST', { kind: 'URL', url: `https://example.com/${i}` }, true, { 'idempotency-key': String(i) }), id));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect((await routes.handle(request('/', 'POST', { kind: 'URL', url: 'https://example.com/4' }), id)).status).toBe(429);
  finish({ ok: false, code: 'TIMEOUT' }); await Promise.all(pending);
  expect((await routes.handle(request('/', 'POST', { kind: 'URL', url: 'https://example.com/0' }, true, { 'idempotency-key': '0' }), id)).status).toBe(201);
  expect(fetch).toHaveBeenCalledTimes(3);
});
it('権限取消後には取得結果を確定しない', async () => {
  let finish!: (value: { ok: true; title: string; body: string; finalUrl: string; contentType: string; truncated: boolean }) => void;
  const fetch = vi.fn(() => new Promise<Parameters<typeof finish>[0]>(resolve => { finish = resolve; }));
  const routes = createReferenceApi({ tasks, store, fetcher: { mode: 'fixture', fetch } });
  const pending = routes.handle(request('/', 'POST', { kind: 'URL', url: 'https://example.com/' }), id);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  vi.stubEnv('ALLOWED_EMAILS', 'other@example.com');
  finish({ ok: true, title: '取得', body: '確定しない', finalUrl: 'https://example.com/', contentType: 'text/plain', truncated: false });
  expect((await pending).status).toBe(401);
  expect(store.list(id)[0]?.body).toBe('');
});
it('論理削除済タスクの資料は全API操作で404、取得も実行しない', async () => {
  const note = store.add(id, { kind: 'NOTE', body: '削除タスクのメモ' });
  const url = store.add(id, { kind: 'URL', url: 'https://example.com/' });
  const fetch = vi.fn();
  const routes = api(fetch);
  expect(tasks.delete(id)).toBe(true);
  expect(tasks.get(id)).toBeNull();
  expect(store.list(id)).toHaveLength(2);
  expect((await routes.handle(request('/'), id)).status).toBe(404);
  expect((await routes.handle(request('/', 'POST', { kind: 'NOTE', body: '追加' }), id)).status).toBe(404);
  expect((await routes.handle(request('/', 'PATCH', { body: '更新', revision: 1 }), id, note.id)).status).toBe(404);
  expect((await routes.handle(request('/', 'DELETE'), id, note.id)).status).toBe(404);
  expect((await routes.handle(request('/', 'POST'), id, url.id, 'refetch')).status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
  expect(store.list(id)).toHaveLength(2);
});
it('取得中にタスクが論理削除された場合は本文を確定しない', async () => {
  let finish!: (value: FetchResult) => void;
  const fetch = vi.fn(() => new Promise<FetchResult>(resolve => { finish = resolve; }));
  const routes = api(fetch);
  const pending = routes.handle(request('/', 'POST', { kind: 'URL', url: 'https://example.com/' }), id);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  tasks.delete(id);
  finish({ ok: true, title: '取得', body: '削除後に確定しない本文', finalUrl: 'https://example.com/', contentType: 'text/plain', truncated: false });
  expect((await pending).status).toBe(404);
  expect(store.list(id)[0]?.body).toBe('');
});
