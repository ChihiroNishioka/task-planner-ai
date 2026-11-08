import Database from 'better-sqlite3';
import { z } from 'zod';

/** ワーカーはこの間隔でheartbeatを書く。WORKER_STALE_MS を超えて更新が無ければ応答なしとみなす。 */
export const WORKER_BEAT_MS = 5_000;
export const WORKER_STALE_MS = 20_000;

const rowSchema = z.object({ mode: z.enum(['cli', 'mock']), pid: z.number().int(), heartbeat_at: z.string(), stopped_at: z.string().nullable() });
export type WorkerRecord = { mode: 'cli' | 'mock'; pid: number; heartbeatAt: string; stoppedAt: string | null };
export type WorkerView = { state: 'running' | 'stale' | 'stopped' | 'never'; mode: 'cli' | 'mock' | null; lastMode: 'cli' | 'mock' | null; heartbeatAt: string | null; label: string };

/** ワーカーが自分の実行モードをDBに書き、Webはそれを読む。Web側の環境変数は真実として扱わない。 */
export class WorkerStatusStore {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 3000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS worker_status (
      id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL, pid INTEGER NOT NULL, heartbeat_at TEXT NOT NULL, stopped_at TEXT
    );`);
  }

  beat(mode: 'cli' | 'mock', pid: number, at: Date = new Date()): void {
    this.db.prepare(`INSERT INTO worker_status(id, mode, pid, heartbeat_at, stopped_at) VALUES (1, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, pid = excluded.pid, heartbeat_at = excluded.heartbeat_at, stopped_at = NULL`).run(mode, pid, at.toISOString());
  }

  markStopped(pid: number, at: Date = new Date()): void {
    this.db.prepare('UPDATE worker_status SET stopped_at = ? WHERE id = 1 AND pid = ?').run(at.toISOString(), pid);
  }

  read(): WorkerRecord | null {
    const row = this.db.prepare('SELECT mode, pid, heartbeat_at, stopped_at FROM worker_status WHERE id = 1').get();
    if (!row) return null;
    const parsed = rowSchema.parse(row);
    return { mode: parsed.mode, pid: parsed.pid, heartbeatAt: parsed.heartbeat_at, stoppedAt: parsed.stopped_at };
  }

  close(): void { this.db.close(); }
}

const modeName = { cli: 'AI生成（サブスクCLI）', mock: 'モック' } as const;

export function describeWorker(record: WorkerRecord | null, now: Date = new Date()): WorkerView {
  if (!record) return { state: 'never', mode: null, lastMode: null, heartbeatAt: null, label: 'ワーカー未起動（AIの実行モードは不明）' };
  const base = { lastMode: record.mode, heartbeatAt: record.heartbeatAt };
  if (record.stoppedAt) return { ...base, state: 'stopped', mode: null, label: `ワーカー停止中（最後の実行モード: ${modeName[record.mode]}）` };
  const age = now.getTime() - new Date(record.heartbeatAt).getTime();
  if (!(age <= WORKER_STALE_MS)) return { ...base, state: 'stale', mode: null, label: `ワーカーが停止または応答なし（最後の実行モード: ${modeName[record.mode]}）` };
  return { ...base, state: 'running', mode: record.mode, label: record.mode === 'cli' ? 'AI生成（サブスクCLI・失敗時はモック）' : 'モック（ワーカーはモックで稼働中）' };
}
