import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { referenceInputSchema, noteEditSchema, referenceSchema, ReferenceError, referenceLimits, type Reference, type FetchResult } from '../domain/references';

const rowSchema = z.object({
  id: z.string(), task_id: z.string(), kind: z.enum(['NOTE', 'URL']), title: z.string(), body: z.string(),
  url: z.string().nullable(), final_url: z.string().nullable(), fetch_status: z.string().nullable(),
  fetch_error_code: z.string().nullable(), fetch_mode: z.string().nullable(), fetched_at: z.string().nullable(),
  content_type: z.string().nullable(), truncated: z.number(), revision: z.number(), created_at: z.string(), updated_at: z.string(),
});

export class ReferenceStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('busy_timeout = 3000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_references (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('NOTE','URL')),
      title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', url TEXT, final_url TEXT,
      fetch_status TEXT CHECK(fetch_status IN ('FETCHING','SUCCEEDED','FAILED')), fetch_error_code TEXT,
      fetch_http_status INTEGER, fetch_mode TEXT CHECK(fetch_mode IN ('live','fixture')), fetch_attempt_id TEXT,
      fetch_started_at TEXT, fetched_at TEXT, content_type TEXT, truncated INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1, operation_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(task_id, operation_key)
    ); CREATE INDEX IF NOT EXISTS task_references_task ON task_references(task_id, created_at);`);
  }
  add(taskId: string, raw: unknown, operationKey: string = randomUUID()): Reference {
    const input = referenceInputSchema.parse(raw);
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT id, request_hash FROM task_references WHERE task_id=? AND operation_key=?').get(taskId, operationKey);
      if (previous) {
        const prior = z.object({ id: z.string(), request_hash: z.string() }).parse(previous);
        if (prior.request_hash !== hash) throw new ReferenceError(409, 'この操作キーは別の内容に使われています。');
        return this.require(taskId, prior.id);
      }
      const count = z.object({ n: z.number() }).parse(this.db.prepare('SELECT count(*) AS n FROM task_references WHERE task_id=?').get(taskId)).n;
      if (count >= referenceLimits.count) throw new ReferenceError(422, '関連資料は50件までです。');
      const now = new Date().toISOString();
      const id = randomUUID();
      this.db.prepare(`INSERT INTO task_references (id,task_id,kind,title,body,url,fetch_status,fetch_error_code,fetch_mode,operation_key,request_hash,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, taskId, input.kind, input.kind === 'NOTE' ? input.title : '', input.kind === 'NOTE' ? input.body : '', input.kind === 'URL' ? input.url : null,
          input.kind === 'URL' ? 'FAILED' : null, input.kind === 'URL' ? 'INTERRUPTED' : null, input.kind === 'URL' ? 'live' : null, operationKey, hash, now, now);
      return this.require(taskId, id);
    }).immediate();
  }
  list(taskId: string): Reference[] {
    this.recover(taskId);
    return this.db.prepare('SELECT * FROM task_references WHERE task_id=? ORDER BY updated_at DESC, id').all(taskId).map(fromRow);
  }
  get(taskId: string, id: string): Reference | null {
    this.recover(taskId);
    const row = this.db.prepare('SELECT * FROM task_references WHERE task_id=? AND id=?').get(taskId, id);
    return row ? fromRow(row) : null;
  }
  require(taskId: string, id: string): Reference {
    const item = this.get(taskId, id);
    if (!item) throw new ReferenceError(404, '関連資料が見つかりません。');
    return item;
  }
  edit(taskId: string, id: string, raw: unknown): Reference {
    const input = noteEditSchema.parse(raw);
    const note = this.require(taskId, id);
    if (note.kind !== 'NOTE') throw new ReferenceError(422, 'メモだけ編集できます。');
    const changed = this.db.prepare("UPDATE task_references SET title=?,body=?,revision=revision+1,updated_at=? WHERE task_id=? AND id=? AND revision=? AND kind='NOTE'")
      .run(input.title, input.body, new Date().toISOString(), taskId, id, input.revision).changes;
    if (!changed) throw new ReferenceError(409, '更新されています。再読み込みして編集してください。');
    return this.require(taskId, id);
  }
  remove(taskId: string, id: string): void {
    if (!this.db.prepare('DELETE FROM task_references WHERE task_id=? AND id=?').run(taskId, id).changes) throw new ReferenceError(404, '関連資料が見つかりません。');
  }
  beginFetch(taskId: string, id: string, mode: 'live' | 'fixture'): string {
    return this.db.transaction(() => {
      const item = this.require(taskId, id);
      if (item.kind !== 'URL') throw new ReferenceError(422, 'URLだけ再取得できます。');
      if (item.fetchStatus === 'FETCHING') throw new ReferenceError(409, '取得中です。しばらく待ってください。');
      const attempt = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare("UPDATE task_references SET fetch_status='FETCHING',fetch_error_code=NULL,fetch_attempt_id=?,fetch_started_at=?,fetch_mode=?,updated_at=?,revision=revision+1 WHERE task_id=? AND id=?")
        .run(attempt, now, mode, now, taskId, id);
      return attempt;
    }).immediate();
  }
  finishFetch(taskId: string, id: string, attempt: string, result: FetchResult): void {
    const now = new Date().toISOString();
    if (result.ok) {
      this.db.prepare(`UPDATE task_references SET title=?,body=?,final_url=?,content_type=?,truncated=?,fetch_status='SUCCEEDED',fetch_error_code=NULL,fetched_at=?,updated_at=?,revision=revision+1
        WHERE task_id=? AND id=? AND fetch_attempt_id=? AND fetch_status='FETCHING'`)
        .run(result.title, result.body, result.finalUrl, result.contentType, Number(result.truncated), now, now, taskId, id, attempt);
    } else {
      this.db.prepare(`UPDATE task_references SET fetch_status='FAILED',fetch_error_code=?,updated_at=?,revision=revision+1 WHERE task_id=? AND id=? AND fetch_attempt_id=? AND fetch_status='FETCHING'`)
        .run(result.code, now, taskId, id, attempt);
    }
  }
  hasOperation(taskId: string, key: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM task_references WHERE task_id=? AND operation_key=?').get(taskId, key)); }
  close(): void { this.db.close(); }
  private recover(taskId: string): void {
    this.db.prepare("UPDATE task_references SET fetch_status='FAILED',fetch_error_code='INTERRUPTED',fetch_attempt_id=NULL,revision=revision+1 WHERE task_id=? AND fetch_status='FETCHING' AND fetch_started_at < ?")
      .run(taskId, new Date(Date.now() - 30_000).toISOString());
  }
}
function fromRow(raw: unknown): Reference {
  const row = rowSchema.parse(raw);
  return referenceSchema.parse({ id: row.id, taskId: row.task_id, kind: row.kind, title: row.title, body: row.body, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at, url: row.url, finalUrl: row.final_url, fetchStatus: row.fetch_status,
    fetchErrorCode: row.fetch_error_code, fetchMode: row.fetch_mode, fetchedAt: row.fetched_at, contentType: row.content_type, truncated: Boolean(row.truncated) });
}
