import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ReferenceStore } from '../src/adapters/reference-store';
import { fetchErrors, fetchErrorMessage, getReferenceCompletenessMessage, referenceSchema, type FetchErrorCode } from '../src/domain/references';
import { z } from 'zod';
import { extractText } from '../src/domain/html-text';
import { buildReferenceBlock } from '../src/domain/reference-context';
import { TaskStore } from '../src/adapters/task-store';

let dir: string;
let store: ReferenceStore;
let tasks: TaskStore;
let id: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'references-'));
  tasks = new TaskStore(join(dir, 'db.sqlite'));
  id = tasks.create({ title: '資料の確認' }).id;
  store = new ReferenceStore(join(dir, 'db.sqlite'));
});
afterEach(() => { store?.close(); tasks?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

it('NOTE-01/02/03/06/07 保存・再起動・競合・他タスク分離・削除', () => {
  const originalRevision = tasks.get(id)?.revision;
  const note = store.add(id, { kind: 'NOTE', title: '題名', body: '本文' }, 'one');
  store.close(); store = new ReferenceStore(join(dir, 'db.sqlite'));
  expect(store.list(id)).toEqual([note]);
  expect(() => store.edit('other', note.id, { body: '別', revision: 1 })).toThrow();
  expect(store.edit(id, note.id, { title: '新', body: '更新', revision: 1 })).toMatchObject({ revision: 2, body: '更新' });
  expect(() => store.edit(id, note.id, { body: '古い', revision: 1 })).toThrow();
  expect(store.list(id)[0]?.body).toBe('更新');
  expect(tasks.get(id)?.revision).toBe(originalRevision);
  expect(() => store.remove('other', note.id)).toThrow();
  store.remove(id, note.id);
  expect(store.list(id)).toEqual([]);
  expect(() => store.remove(id, note.id)).toThrow();
});
it('NOTE-04/05 本文上限と冪等キー', () => {
  expect(() => store.add(id, { kind: 'NOTE', body: '' })).toThrow();
  expect(() => store.add(id, { kind: 'NOTE', body: 'あ'.repeat(20_001) })).toThrow();
  const note = store.add(id, { kind: 'NOTE', body: 'あ'.repeat(20_000) }, 'same');
  expect(store.add(id, { kind: 'NOTE', body: 'あ'.repeat(20_000) }, 'same')).toEqual(note);
  expect(() => store.add(id, { kind: 'NOTE', body: '別' }, 'same')).toThrow();
  expect(store.list(id)).toHaveLength(1);
});
it('URL-03/04/10 古い取得は反映せず失敗時の旧本文は保持、削除で復活しない', () => {
  const url = store.add(id, { kind: 'URL', url: 'https://example.com/' });
  const first = store.beginFetch(id, url.id, 'live');
  expect(() => store.beginFetch(id, url.id, 'live')).toThrow();
  store.finishFetch(id, url.id, first, { ok: true, title: 'ページ', body: '前回本文', contentType: 'text/html', finalUrl: 'https://example.com/', truncated: false });
  const second = store.beginFetch(id, url.id, 'fixture');
  store.finishFetch(id, url.id, first, { ok: false, code: 'NETWORK_ERROR' });
  expect(store.get(id, url.id)).toMatchObject({ fetchStatus: 'FETCHING' });
  store.finishFetch(id, url.id, second, { ok: false, code: 'TIMEOUT' });
  expect(store.get(id, url.id)).toMatchObject({ body: '前回本文', fetchStatus: 'FAILED', fetchErrorCode: 'TIMEOUT' });
  const third = store.beginFetch(id, url.id, 'live');
  store.remove(id, url.id);
  store.finishFetch(id, url.id, third, { ok: false, code: 'NETWORK_ERROR' });
  expect(store.list(id)).toEqual([]);
});
it('URL-11 中断を復旧し再取得できる', () => {
  const url = store.add(id, { kind: 'URL', url: 'https://example.com/' });
  store.beginFetch(id, url.id, 'live');
  const db = new Database(join(dir, 'db.sqlite'));
  db.prepare("UPDATE task_references SET fetch_started_at = ?").run(new Date(Date.now() - 31_000).toISOString());
  db.close();
  expect(store.get(id, url.id)).toMatchObject({ fetchStatus: 'FAILED', fetchErrorCode: 'INTERRUPTED' });
  expect(store.beginFetch(id, url.id, 'live')).toBeTypeOf('string');
});
it('MIG-01/02/03 既存のスキーマと行は不変、複数Store初期化', () => {
  const db = new Database(join(dir, 'db.sqlite'));
  const before = db.prepare("SELECT sql FROM sqlite_master WHERE name='tasks'").get();
  const rows = db.prepare('SELECT * FROM tasks').all();
  const another = new ReferenceStore(join(dir, 'db.sqlite'));
  another.close();
  expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='tasks'").get()).toEqual(before);
  expect(db.prepare('SELECT * FROM tasks').all()).toEqual(rows);
  db.close();
});

function sql() { return new Database(join(dir, 'db.sqlite')); }
const success = { ok:true, title:'題', body:'短い本文', finalUrl:'https://example.com/', contentType:'text/html', truncated:false, contentHint:'SHORT_BODY' } as const;
it('UF-COMP-01/02 列なしDBへ追加だけで移行し再初期化できる', () => {
  const note = store.add(id, { kind:'NOTE', body:'残す本文' });
  store.close();
  const db = sql();
  for (const column of ['fetch_failure_reason','content_hint','fetch_detail_revision','fetch_http_status']) {
    const columns = z.array(z.object({name:z.string()})).parse(db.prepare('PRAGMA table_info(task_references)').all());
    if (columns.some(item=>item.name===column)) db.exec(`ALTER TABLE task_references DROP COLUMN ${column}`);
  }
  const before = db.prepare('SELECT * FROM task_references').all();
  store = new ReferenceStore(join(dir,'db.sqlite'));
  const columns = z.array(z.object({name:z.string()})).parse(db.prepare('PRAGMA table_info(task_references)').all()).map(item=>item.name);
  expect(columns).toEqual(expect.arrayContaining(['fetch_failure_reason','content_hint','fetch_detail_revision','fetch_http_status']));
  const after = db.prepare('SELECT * FROM task_references').all();
  expect(after).toEqual(before.map(row=>({...z.record(z.string(),z.unknown()).parse(row), fetch_failure_reason:null,content_hint:null,fetch_detail_revision:null,fetch_http_status:null})));
  expect(store.require(id,note.id)).toEqual(note);
  const second = new ReferenceStore(join(dir,'db.sqlite')); second.close(); db.close();
});
it.each(Object.keys(fetchErrors))('UF-COMP-03/06/07 旧12コード %s を新旧スキーマで読める', code => {
  const item=store.add(id,{kind:'URL',url:'https://example.com/'});
  const attempt=store.beginFetch(id,item.id,'live');
  store.finishFetch(id,item.id,attempt,{ok:false,code:z.enum(Object.keys(fetchErrors) as [FetchErrorCode,...FetchErrorCode[]]).parse(code)});
  const result=store.require(id,item.id);
  expect(result).toMatchObject({fetchErrorCode:code,fetchFailureReason:null,contentHint:null});
  const old=z.object({kind:z.literal('URL'),fetchErrorCode:z.enum(['BLOCKED_URL','DNS_FAILED','TIMEOUT','NETWORK_ERROR','HTTP_ERROR','TOO_MANY_REDIRECTS','UNSUPPORTED_TYPE','TOO_LARGE','EMPTY_CONTENT','DECODE_FAILED','INTERRUPTED','FETCH_DISABLED'])});
  expect(old.parse(result).fetchErrorCode).toBe(code);
  expect(referenceSchema.parse(result)).toEqual(result);
});
it('UF-COMP-04 未知の詳細はnullとして読む',()=>{
  const item=store.add(id,{kind:'URL',url:'https://example.com/'});
  const db=sql();
  db.prepare("UPDATE task_references SET fetch_failure_reason='FUTURE',content_hint='FUTURE',fetch_detail_revision=revision WHERE id=?").run(item.id);
  expect(store.require(id,item.id)).toMatchObject({fetchFailureReason:null,contentHint:null}); db.close();
});
it('UF-COMP-08/09 開始・成功・回復で理由と状態をクリアし失敗時本文とhintを保持する',()=>{
  const item=store.add(id,{kind:'URL',url:'https://example.com/'});
  const run=(result:Parameters<ReferenceStore['finishFetch']>[3])=>store.finishFetch(id,item.id,store.beginFetch(id,item.id,'live'),result);
  run(success);
  run({ok:false,code:'HTTP_ERROR',reason:'HTTP_REFUSED',httpStatus:403});
  expect(store.require(id,item.id)).toMatchObject({body:success.body,contentHint:'SHORT_BODY',fetchFailureReason:'HTTP_REFUSED'});
  const db=sql();
  expect(db.prepare('SELECT fetch_http_status FROM task_references WHERE id=?').get(item.id)).toEqual({fetch_http_status:403});
  const attempt=store.beginFetch(id,item.id,'live');
  expect(db.prepare('SELECT fetch_failure_reason,fetch_http_status FROM task_references WHERE id=?').get(item.id)).toEqual({fetch_failure_reason:null,fetch_http_status:null});
  store.finishFetch(id,item.id,attempt,{...success,contentHint:null});
  expect(store.require(id,item.id)).toMatchObject({contentHint:null,fetchFailureReason:null});
  store.beginFetch(id,item.id,'live');
  db.prepare("UPDATE task_references SET fetch_started_at=?,fetch_failure_reason='HTTP_REFUSED',fetch_http_status=403 WHERE id=?").run(new Date(Date.now()-31_000).toISOString(),item.id);
  expect(store.require(id,item.id)).toMatchObject({fetchErrorCode:'INTERRUPTED',fetchFailureReason:null});
  expect(db.prepare('SELECT fetch_http_status,fetch_detail_revision=revision AS stamped FROM task_references WHERE id=?').get(item.id)).toEqual({fetch_http_status:null,stamped:1}); db.close();
});
it('UF-COMP-10 新→旧→新の更新で古い詳細を表示しない',()=>{
  const item=store.add(id,{kind:'URL',url:'https://example.com/'}); const db=sql();
  const run=(result:Parameters<ReferenceStore['finishFetch']>[3])=>store.finishFetch(id,item.id,store.beginFetch(id,item.id,'live'),result);
  run({ok:false,code:'HTTP_ERROR',reason:'HTTP_REFUSED',httpStatus:403});
  db.prepare("UPDATE task_references SET fetch_status='FAILED',fetch_error_code='HTTP_ERROR',revision=revision+1,updated_at=? WHERE id=?").run(new Date().toISOString(),item.id);
  const old=store.require(id,item.id); expect(old).toMatchObject({fetchFailureReason:null});
  if(old.kind!=='URL')throw new Error('URL expected');
  expect(fetchErrorMessage(old.fetchErrorCode!,old.fetchFailureReason)).toBe('ページがエラーを返しました。時間をおいて再取得してください。');
  run(success); expect(store.require(id,item.id)).toMatchObject({contentHint:'SHORT_BODY'});
  db.prepare("UPDATE task_references SET title=?,body=?,final_url=?,content_type=?,truncated=?,fetch_status='SUCCEEDED',fetch_error_code=NULL,fetched_at=?,updated_at=?,revision=revision+1 WHERE id=?").run('旧題','旧本文','https://example.com/','text/html',0,new Date().toISOString(),new Date().toISOString(),item.id);
  expect(store.require(id,item.id)).toMatchObject({contentHint:null,fetchFailureReason:null});
  run({ok:false,code:'TIMEOUT'}); expect(store.require(id,item.id)).toMatchObject({contentHint:null});
  run(success); expect(store.require(id,item.id)).toMatchObject({contentHint:'SHORT_BODY'}); db.close();
});
it('UF-TIME-04 20秒と21秒のFETCHINGは回復しない',()=>{
 const item=store.add(id,{kind:'URL',url:'https://example.com/'}); store.beginFetch(id,item.id,'live'); const db=sql();
 for(const ms of [20_000,21_000]) { db.prepare('UPDATE task_references SET fetch_started_at=? WHERE id=?').run(new Date(Date.now()-ms).toISOString(),item.id); expect(store.require(id,item.id)).toMatchObject({fetchStatus:'FETCHING'}); } db.close();
});

it('UF-ERR-07/UF-COMP-05 全コード・全理由に固定文を持ち不一致理由を無視する',()=>{
 for(const code of Object.keys(fetchErrors)) {
  const parsed=z.enum(Object.keys(fetchErrors) as [FetchErrorCode,...FetchErrorCode[]]).parse(code);
  const text=fetchErrorMessage(parsed); expect(text).toBeTruthy(); expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
 }
 expect(fetchErrorMessage('DNS_FAILED','HTTP_REFUSED')).toBe(fetchErrorMessage('DNS_FAILED'));
 expect(fetchErrorMessage('TIMEOUT','DNS_NOT_FOUND')).toBe(fetchErrorMessage('TIMEOUT'));
 for(const [code,reason,expected] of [
 ['DNS_FAILED','DNS_NOT_FOUND','サイトが見つかりませんでした。URLに誤りがないか確認してください。'],
 ['DNS_FAILED','DNS_UNAVAILABLE','サイトの場所を確認できませんでした。時間をおいて再取得してください。'],
 ['BLOCKED_URL','BLOCKED_ADDRESS','安全上の理由で取得を止めました。公開されていない宛先の可能性があります。公開サイトでも、サーバーの名前解決の設定で止まることがあります。続く場合は管理者に伝えてください。内容が必要なら、メモに貼り付けて追加できます。'],
 ['BLOCKED_URL','BLOCKED_URL_FORM','安全上の理由で取得できない形式のURLです。ポート番号やユーザー名を付けない http / https のURLでお試しください。'],
 ['HTTP_ERROR','HTTP_REFUSED','サイトに取得を断られました。時間をおいて再取得するか、内容をメモに貼り付けてください。'],
 ['HTTP_ERROR','HTTP_NOT_FOUND','ページが見つかりませんでした。URLを確認してください。'],
 ['HTTP_ERROR','HTTP_SERVER','サイト側でエラーが起きています。時間をおいて再取得してください。'],
 ['HTTP_ERROR','HTTP_OTHER','ページがエラーを返しました。時間をおいて再取得してください。'],
 ] as const) expect(fetchErrorMessage(code,reason)).toBe(expected);
});


it('S01/S07 切り詰めと理由なしの旧BLOCKED_URLにも次の行動を表示する', () => {
  expect(fetchErrorMessage('BLOCKED_URL')).toBe('安全上の理由で取得できませんでした。再取得しても直らない場合は、内容をメモに貼り付けてください。');
  const item = store.add(id, { kind: 'URL', url: 'https://example.com/' });
  const revision = store.beginFetch(id, item.id, 'live');
  store.finishFetch(id, item.id, revision, { ok: true, title: '題', body: '文'.repeat(50000), finalUrl: 'https://example.com/', contentType: 'text/html', truncated: true });
  expect(getReferenceCompletenessMessage(store.require(id, item.id))).toBe('一部のみ取り込みました（先頭の5万字まで）。続きが必要なら、必要な部分をメモに貼り付けてください。');
});


it('C11 上限後の長いmainの欠落をDB再読込・画面用文言・AI注記へ伝える', () => {
  const item = store.add(id, { kind: 'URL', url: 'https://example.com/' });
  const result = extractText(`<main>${'文'.repeat(799)}</main>${'<br>'.repeat(19998)}<main>${'後'.repeat(60000)}</main>`, 'text/html', 'example.com');
  store.finishFetch(id, item.id, store.beginFetch(id, item.id, 'live'), { ok: true, ...result, contentType: 'text/html', finalUrl: 'https://example.com/' });
  store.close(); store = new ReferenceStore(join(dir, 'db.sqlite'));
  const saved = store.require(id, item.id);
  expect(saved).toMatchObject({ body: '文'.repeat(799), truncated: true, contentHint: null });
  expect(getReferenceCompletenessMessage(saved)).toBe('一部のみ取得しました。解析の上限などで本文が欠けています。必要な部分はメモに貼り付けてください。');
  expect(buildReferenceBlock([saved]).text).toContain('注記: 本文の一部しか取得できていない可能性があります。書かれていない内容は推測しないでください。');
});
