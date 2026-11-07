import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { Task } from '../domain/task';
import type { TaskStore } from './task-store';
import type { PreparationAdapter } from './mock-ai';
import { generationSchema, preparationJobSchema, workPlanSchema, type PreparationJob, type WorkPlan } from '../domain/preparation';

type JobRow = z.infer<typeof jobRowSchema>;
const jobRowSchema = z.object({
  id: z.string().uuid(), task_id: z.string().uuid(), status: preparationJobSchema.shape.status,
  created_at: z.string(), updated_at: z.string(), error_code: z.string().nullable(), operation_key: z.string(),
});

export type StoredArtifact = {
  id: string;
  versionId: string;
  parentVersionId: string | null;
  taskId: string;
  version: number;
  path: string;
  mode: 'mock';
  saveStatus: 'MOCK_SAVED';
  createdAt: string;
  plan: WorkPlan;
  content: string;
  changeSummary: string;
};

export class PreparationStore {
  private readonly db: Database.Database;

  constructor(databasePath: string, private readonly artifactDirectory: string) {
    mkdirSync(artifactDirectory, { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS preparation_jobs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, error_code TEXT, operation_key TEXT NOT NULL, UNIQUE(task_id, operation_key)
    );
    CREATE INDEX IF NOT EXISTS preparation_queue ON preparation_jobs(status, created_at);
    CREATE TABLE IF NOT EXISTS work_plans (
      task_id TEXT NOT NULL, revision INTEGER NOT NULL, plan_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(task_id, revision)
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, current_version INTEGER NOT NULL, created_at TEXT NOT NULL,
      approved_version_id TEXT
    );
    CREATE TABLE IF NOT EXISTS artifact_versions (
      id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, version_number INTEGER NOT NULL, parent_version_id TEXT, content TEXT NOT NULL,
      file_name TEXT NOT NULL, change_summary TEXT NOT NULL, created_at TEXT NOT NULL, mode TEXT NOT NULL,
      save_status TEXT NOT NULL, plan_json TEXT NOT NULL, UNIQUE(artifact_id, version_number)
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY, artifact_version_id TEXT NOT NULL, content TEXT NOT NULL,
      applied_to_version_id TEXT, created_at TEXT NOT NULL
    );`);
    this.ensureColumn('artifacts', 'approved_version_id', 'TEXT');
    this.ensureColumn('artifact_versions', 'parent_version_id', 'TEXT');
  }

  enqueue(task: Task, operationKey: string = randomUUID()): PreparationJob {
    if (task.deletedAt || ['COMPLETED', 'CANCELLED'].includes(task.status)) throw new Error('このタスクは準備を開始できません。');
    const prior = this.db.prepare('SELECT * FROM preparation_jobs WHERE task_id = ? AND operation_key = ?').get(task.id, operationKey);
    if (prior) return toJob(jobRowSchema.parse(prior));
    const now = new Date().toISOString();
    const job = preparationJobSchema.parse({ id: randomUUID(), taskId: task.id, status: 'QUEUED', mode: 'mock', createdAt: now, updatedAt: now, errorCode: null });
    this.db.prepare('INSERT INTO preparation_jobs(id, task_id, status, created_at, updated_at, error_code, operation_key) VALUES (?, ?, ?, ?, ?, NULL, ?)')
      .run(job.id, task.id, job.status, now, now, operationKey);
    this.db.prepare('UPDATE tasks SET ai_status = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
      .run('QUEUED', now, task.id);
    return job;
  }

  async runNext(tasks: TaskStore, adapter: PreparationAdapter): Promise<PreparationJob | null> {
    const queued = this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM preparation_jobs WHERE status = 'QUEUED' ORDER BY created_at LIMIT 1").get();
      if (!row) return null;
      const job = jobRowSchema.parse(row);
      const updated = this.db.prepare("UPDATE preparation_jobs SET status = 'RUNNING', updated_at = ? WHERE id = ? AND status = 'QUEUED'")
        .run(new Date().toISOString(), job.id);
      return updated.changes ? job : null;
    }).immediate();
    if (!queued) return null;
    const task = tasks.get(queued.task_id);
    if (!task || ['COMPLETED', 'CANCELLED'].includes(task.status)) return this.finish(queued.id, tasks, 'CANCELLED', 'TASK_NOT_RUNNABLE');
    tasks.updateAiStatus(task.id, 'RUNNING');
    try {
      const generation = generationSchema.parse(await adapter.generate(task));
      return this.save(jobRowSchema.parse(queued), task, generation, tasks);
    } catch {
      return this.finish(queued.id, tasks, 'FAILED', 'GENERATION_FAILED');
    }
  }

  getJob(id: string): PreparationJob | null {
    const row = this.db.prepare('SELECT * FROM preparation_jobs WHERE id = ?').get(id);
    return row ? toJob(jobRowSchema.parse(row)) : null;
  }

  listArtifacts(taskId: string): StoredArtifact[] {
    const rows = z.array(z.object({
      id: z.string().uuid(), artifact_id: z.string().uuid(), version_number: z.number(), parent_version_id: z.string().uuid().nullable(), content: z.string(),
      file_name: z.string(), change_summary: z.string(), created_at: z.string(), mode: z.literal('mock'),
      save_status: z.literal('MOCK_SAVED'), plan_json: z.string(),
    })).parse(this.db.prepare(`SELECT av.* FROM artifact_versions av
      JOIN artifacts a ON a.id = av.artifact_id WHERE a.task_id = ? ORDER BY av.version_number`).all(taskId));
    return rows.map((row) => ({
      id: row.artifact_id, versionId: row.id, parentVersionId: row.parent_version_id,
      taskId, version: row.version_number, path: join(this.artifactDirectory, row.file_name),
      mode: row.mode, saveStatus: row.save_status, createdAt: row.created_at,
      plan: workPlanSchema.parse(JSON.parse(row.plan_json)), content: row.content, changeSummary: row.change_summary,
    }));
  }

  close(): void { this.db.close(); }

  async revise(taskId: string, rawFeedback: string, tasks: TaskStore, adapter: PreparationAdapter): Promise<StoredArtifact> {
    const feedback = z.string().trim().min(1).max(20_000).parse(rawFeedback);
    const task = tasks.get(taskId);
    const previous = this.listArtifacts(taskId).at(-1);
    if (!task || !previous) throw new Error('改訂する成果物がありません。');
    if (!adapter.revise) throw new Error('このAIアダプターは改訂に対応していません。');
    const generation = generationSchema.parse(await adapter.revise(task, previous.content, feedback));
    const version = previous.version + 1;
    const versionId = randomUUID();
    const fileName = `${previous.id}-v${version}.md`;
    writeFileSync(join(this.artifactDirectory, fileName), generation.markdown, { flag: 'wx' });
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare('UPDATE artifacts SET current_version = ? WHERE id = ?').run(version, previous.id);
      this.db.prepare(`INSERT INTO artifact_versions(id, artifact_id, version_number, parent_version_id, content,
        file_name, change_summary, created_at, mode, save_status, plan_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'mock', 'MOCK_SAVED', ?)`)
        .run(versionId, previous.id, version, previous.versionId, generation.markdown, fileName,
          generation.changeSummary, now, JSON.stringify(generation.plan));
      this.db.prepare('INSERT INTO feedback(id, artifact_version_id, content, applied_to_version_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), previous.versionId, feedback, versionId, now);
    }).immediate();
    tasks.updateAiStatus(taskId, 'READY');
    return this.listArtifacts(taskId).at(-1) ?? (() => { throw new Error('改訂版を再取得できません。'); })();
  }

  feedbackHistory(taskId: string): Array<{ sourceVersionId: string; content: string; appliedToVersionId: string | null; createdAt: string }> {
    const rows = z.array(z.object({
      artifact_version_id: z.string().uuid(), content: z.string(), applied_to_version_id: z.string().uuid().nullable(), created_at: z.string(),
    })).parse(this.db.prepare(`SELECT feedback.artifact_version_id, feedback.content, feedback.applied_to_version_id, feedback.created_at
      FROM feedback JOIN artifact_versions ON artifact_versions.id = feedback.artifact_version_id
      JOIN artifacts ON artifacts.id = artifact_versions.artifact_id WHERE artifacts.task_id = ? ORDER BY feedback.created_at`).all(taskId));
    return rows.map((row) => ({ sourceVersionId: row.artifact_version_id, content: row.content, appliedToVersionId: row.applied_to_version_id, createdAt: row.created_at }));
  }

  private save(job: JobRow, task: Task, generation: ReturnType<typeof generationSchema.parse>, tasks: TaskStore): PreparationJob {
    const existing = this.db.prepare('SELECT id, current_version FROM artifacts WHERE task_id = ?').get(task.id);
    const artifactRecord = z.object({ id: z.string().uuid(), current_version: z.number().int() }).nullable().parse(existing ?? null);
    const artifactId = artifactRecord?.id ?? randomUUID();
    const version = (artifactRecord?.current_version ?? 0) + 1;
    const fileName = `${artifactId}-v${version}.md`;
    writeFileSync(join(this.artifactDirectory, fileName), generation.markdown, { flag: 'wx' });
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      if (artifactRecord) this.db.prepare('UPDATE artifacts SET current_version = ? WHERE id = ?').run(version, artifactId);
      else this.db.prepare('INSERT INTO artifacts(id, task_id, current_version, created_at) VALUES (?, ?, ?, ?)').run(artifactId, task.id, version, now);
      this.db.prepare('INSERT INTO artifact_versions(id, artifact_id, version_number, parent_version_id, content, file_name, change_summary, created_at, mode, save_status, plan_json) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), artifactId, version, generation.markdown, fileName, generation.changeSummary, now, 'mock', 'MOCK_SAVED', JSON.stringify(generation.plan));
      this.db.prepare('INSERT OR REPLACE INTO work_plans(task_id, revision, plan_json, created_at) VALUES (?, ?, ?, ?)')
        .run(task.id, task.revision + 1, JSON.stringify(generation.plan), now);
      this.db.prepare("UPDATE preparation_jobs SET status = 'SUCCEEDED', updated_at = ?, error_code = NULL WHERE id = ?").run(now, job.id);
    });
    transaction();
    tasks.updateAiStatus(task.id, 'READY');
    const completed = this.getJob(job.id);
    if (!completed) throw new Error('準備ジョブを再取得できません。');
    return completed;
  }

  private finish(id: string, tasks: TaskStore, status: PreparationJob['status'], errorCode: string): PreparationJob {
    const row = jobRowSchema.parse(this.db.prepare('SELECT * FROM preparation_jobs WHERE id = ?').get(id));
    const now = new Date().toISOString();
    this.db.prepare('UPDATE preparation_jobs SET status = ?, updated_at = ?, error_code = ? WHERE id = ?').run(status, now, errorCode, id);
    tasks.updateAiStatus(row.task_id, status === 'CANCELLED' ? 'CANCELLED' : 'FAILED');
    const finished = this.getJob(id);
    if (!finished) throw new Error('準備ジョブを再取得できません。');
    return finished;
  }

  private ensureColumn(table: string, name: string, declaration: string): void {
    const columns = z.array(z.object({ name: z.string() })).parse(this.db.prepare(`PRAGMA table_info(${table})`).all());
    if (!columns.some((column) => column.name === name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  }
}

function toJob(row: JobRow): PreparationJob {
  return preparationJobSchema.parse({
    id: row.id, taskId: row.task_id, status: row.status, mode: 'mock', createdAt: row.created_at,
    updatedAt: row.updated_at, errorCode: row.error_code,
  });
}
