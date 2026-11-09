import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { breakdownVersionLabel, breakdownGenerationSchema, breakdownCommandSchema, breakdownJobSchema, breakdownSnapshotSchema, storedBreakdownStepsSchema, breakdownVersionSchema, BreakdownError, type BreakdownSnapshot, type BreakdownVersion } from '../domain/breakdown';
import type { TaskStore } from './task-store';
import type { PreparationStore } from './preparation-store';
import type { PreparationAdapter } from './mock-ai';

const taskStateSchema = z.object({ status: z.string(), revision: z.number(), deleted_at: z.string().nullable() });
const jobRowSchema = z.object({ id: z.string(), task_id: z.string(), status: breakdownJobSchema.shape.status, error_code: z.string().nullable(), base_version: z.string().nullable(), created_at: z.string(), command_json: z.string(), task_revision: z.number() });

export class BreakdownStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS breakdown_versions (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, number INTEGER NOT NULL, data_json TEXT NOT NULL,
      source_artifact TEXT UNIQUE, UNIQUE(task_id, number)
    );
    CREATE TABLE IF NOT EXISTS breakdown_requests (
      task_id TEXT NOT NULL, request_key TEXT NOT NULL, content_hash TEXT NOT NULL, result_json TEXT NOT NULL,
      PRIMARY KEY(task_id, request_key)
    );
    CREATE TABLE IF NOT EXISTS breakdown_jobs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT,
      base_version TEXT, task_revision INTEGER NOT NULL, command_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS breakdown_queue ON breakdown_jobs(status, created_at);
    CREATE TABLE IF NOT EXISTS draft_version_links (
      artifact_version_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
      breakdown_version_id TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS draft_version_links_task ON draft_version_links(task_id, created_at);`);
  }

  snapshot(taskId: string): BreakdownSnapshot {
    const rows = z.array(z.object({ data_json: z.string() })).parse(this.db.prepare('SELECT data_json FROM breakdown_versions WHERE task_id = ? ORDER BY number').all(taskId));
    const jobs = z.array(jobRowSchema).parse(this.db.prepare('SELECT * FROM breakdown_jobs WHERE task_id = ? ORDER BY created_at, id').all(taskId));
    return breakdownSnapshotSchema.parse({ versions: rows.map((row) => { const version = breakdownVersionSchema.parse(JSON.parse(row.data_json)); return { ...version, label: breakdownVersionLabel(version) }; }), jobs: jobs.map((row) => { const command = breakdownCommandSchema.parse(JSON.parse(row.command_json)); if (command.action !== 'regenerate') throw new Error('無効な分解ジョブ'); return { inputSteps: command.steps, comment: command.comment, id: row.id, taskId: row.task_id, status: row.status, errorCode: row.error_code, baseVersion: row.base_version, createdAt: row.created_at }; }) });
  }

  syncArtifacts(taskId: string, preparations: PreparationStore): void {
    const artifacts = preparations.listArtifacts(taskId);
    this.db.transaction(() => {
      const task = this.taskState(taskId);
      if (task.deleted_at) return;
      for (const artifact of artifacts) {
        if (this.db.prepare('SELECT id FROM breakdown_versions WHERE source_artifact = ?').get(artifact.versionId)) continue;
        if (this.db.prepare('SELECT artifact_version_id FROM draft_version_links WHERE artifact_version_id = ?').get(artifact.versionId)) continue;
        const steps = storedBreakdownStepsSchema.parse(artifact.plan.steps);
        this.append(taskId, { kind: 'import', steps, mode: artifact.mode, fallbackReason: artifact.fallbackReason, comment: '', sourceVersion: null }, artifact.versionId);
      }
    }).immediate();
  }

  mutate(taskId: string, raw: unknown): BreakdownSnapshot {
    const command = breakdownCommandSchema.parse(raw);
    return this.db.transaction(() => {
      this.assertRunnable(taskId);
      const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      const prior = z.object({ content_hash: z.string(), result_json: z.string() }).nullable().parse(this.db.prepare('SELECT * FROM breakdown_requests WHERE task_id = ? AND request_key = ?').get(taskId, command.requestKey) ?? null);
      if (prior) {
        if (prior.content_hash !== hash) throw new BreakdownError('CONFLICT');
        return breakdownSnapshotSchema.parse(JSON.parse(prior.result_json));
      }
      if (command.action === 'cancel') {
        const job = this.snapshot(taskId).jobs.find((item) => item.id === command.jobId);
        if (!job) throw new BreakdownError('NOT_FOUND');
        if (job.status === 'SUCCEEDED' || job.status === 'FAILED') throw new BreakdownError('CONFLICT');
        this.db.prepare("UPDATE breakdown_jobs SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND status IN ('QUEUED', 'RUNNING')")
          .run(new Date().toISOString(), job.id);
      } else {
        this.assertBase(taskId, command.baseVersion);
      }
      if (command.action === 'regenerate') {
        if (this.snapshot(taskId).jobs.some((job) => job.status === 'QUEUED' || job.status === 'RUNNING')) throw new BreakdownError('CONFLICT');
        const now = new Date().toISOString();
        this.db.prepare(`INSERT INTO breakdown_jobs(id, task_id, status, base_version, task_revision, command_json, created_at, updated_at)
          VALUES (?, ?, 'QUEUED', ?, ?, ?, ?, ?)`).run(randomUUID(), taskId, command.baseVersion, this.taskState(taskId).revision, JSON.stringify(command), now, now);
      } else if (command.action === 'save') {
        this.append(taskId, { kind: 'user', steps: command.steps, mode: null, fallbackReason: null, comment: '', sourceVersion: null });
      } else if (command.action === 'restore') {
        const source = this.snapshot(taskId).versions.find((v) => v.id === command.sourceVersion);
        if (!source) throw new BreakdownError('NOT_FOUND');
        this.append(taskId, { kind: 'restore', steps: source.steps, mode: source.mode, fallbackReason: source.fallbackReason, comment: '', sourceVersion: source.id });
      }
      const result = this.snapshot(taskId);
      this.db.prepare('INSERT INTO breakdown_requests VALUES (?, ?, ?, ?)').run(taskId, command.requestKey, hash, JSON.stringify(result));
      return result;
    }).immediate();
  }

  async runNext(tasks: TaskStore, preparations: PreparationStore, adapter: PreparationAdapter) {
    const queued = this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare("UPDATE breakdown_jobs SET status = 'FAILED', error_code = 'WORKER_INTERRUPTED', updated_at = ? WHERE status = 'RUNNING' AND updated_at < ?")
        .run(now, new Date(Date.now() - 10 * 60_000).toISOString());
      const row = jobRowSchema.nullable().parse(this.db.prepare("SELECT * FROM breakdown_jobs WHERE status = 'QUEUED' ORDER BY created_at, id LIMIT 1").get() ?? null);
      if (row) this.db.prepare("UPDATE breakdown_jobs SET status = 'RUNNING', updated_at = ? WHERE id = ?").run(now, row.id);
      return row;
    }).immediate();
    if (!queued) return null;
    try {
      this.syncArtifacts(queued.task_id, preparations);
      const command = breakdownCommandSchema.parse(JSON.parse(queued.command_json));
      if (command.action !== 'regenerate') throw new Error('無効な生成ジョブ');
      const check = () => {
        this.assertRunnable(queued.task_id);
        this.assertBase(queued.task_id, command.baseVersion);
        if (this.taskState(queued.task_id).revision !== queued.task_revision) throw new BreakdownError('CONFLICT');
      };
      check();
      const task = tasks.get(queued.task_id);
      if (!task) throw new BreakdownError('NOT_FOUND');
      if (!adapter.breakdown) throw new Error('分解の再生成非対応');
      const generation = breakdownGenerationSchema.parse(await adapter.breakdown(task, command.steps, command.comment));
      const steps = generation.steps;
      this.db.transaction(() => {
        const active = z.object({ status: z.string() }).parse(this.db.prepare('SELECT status FROM breakdown_jobs WHERE id = ?').get(queued.id));
        if (active.status !== 'RUNNING') throw new BreakdownError('CONFLICT');
        this.syncArtifacts(queued.task_id, preparations);
        check();
        this.append(queued.task_id, { kind: 'ai', steps, mode: generation.mode, fallbackReason: generation.fallbackReason, comment: command.comment, sourceVersion: null });
        this.db.prepare("UPDATE breakdown_jobs SET status = 'SUCCEEDED', updated_at = ? WHERE id = ?").run(new Date().toISOString(), queued.id);
      }).immediate();
    } catch (error) {
      this.db.prepare("UPDATE breakdown_jobs SET status = 'FAILED', error_code = ?, updated_at = ? WHERE id = ? AND status = 'RUNNING'")
        .run(error instanceof BreakdownError ? error.code : 'GENERATION_FAILED', new Date().toISOString(), queued.id);
    }
    return this.snapshot(queued.task_id).jobs.find((job) => job.id === queued.id) ?? null;
  }

  private taskState(taskId: string) {
    const row = taskStateSchema.nullable().parse(this.db.prepare('SELECT status, revision, deleted_at FROM tasks WHERE id = ?').get(taskId) ?? null);
    if (!row) throw new BreakdownError('NOT_FOUND');
    return row;
  }
  private assertRunnable(taskId: string) {
    const row = this.taskState(taskId);
    if (row.deleted_at) throw new BreakdownError('NOT_FOUND');
    if (['COMPLETED', 'CANCELLED'].includes(row.status)) throw new BreakdownError('TASK_NOT_RUNNABLE');
  }
  private assertBase(taskId: string, baseVersion: string | null) {
    if ((this.snapshot(taskId).versions.at(-1)?.id ?? null) !== baseVersion) throw new BreakdownError('CONFLICT');
  }
  private append(taskId: string, data: Pick<BreakdownVersion, 'kind' | 'steps' | 'comment' | 'sourceVersion'> & { mode: unknown; fallbackReason: unknown }, sourceArtifact: string | null = null) {
    const previous = this.snapshot(taskId).versions.at(-1);
    const version = breakdownVersionSchema.parse({ ...data, id: randomUUID(), taskId, number: (previous?.number ?? 0) + 1, parentVersion: previous?.id ?? null, createdAt: new Date().toISOString() });
    this.db.prepare('INSERT INTO breakdown_versions VALUES (?, ?, ?, ?, ?)').run(version.id, taskId, version.number, JSON.stringify(version), sourceArtifact);
    return version;
  }
  close() { this.db.close(); }
}
