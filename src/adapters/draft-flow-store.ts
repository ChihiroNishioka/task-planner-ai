import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PreparationAdapter } from './mock-ai';
import type { TaskStore } from './task-store';
import { type StoredArtifact } from './preparation-store';
import { breakdownStepsSchema, breakdownVersionSchema, breakdownGenerationSchema, type BreakdownVersion } from '../domain/breakdown';
import { draftFlowSnapshotSchema, draftJobSchema, draftJobMessage, DraftFlowError, type DraftFlowSnapshot, type DraftJob } from '../domain/draft-flow';
import { generationSchema, modeLabel, preparationJobSchema, type PreparationJob, type Generation } from '../domain/preparation';

const stateSchema = z.object({ status: z.string(), revision: z.number(), deleted_at: z.string().nullable() });
const jobRowSchema = z.object({ id: z.string(), task_id: z.string(), status: draftJobSchema.shape.status, error_code: z.string().nullable(), breakdown_version_id: z.string(), request_key: z.string(), task_revision: z.number(), created_at: z.string(), updated_at: z.string() });
type JobRow = z.infer<typeof jobRowSchema>;
const closed = (status: string) => ['COMPLETED', 'CANCELLED'].includes(status);

export class DraftFlowStore {
  private readonly db: Database.Database;
  constructor(path: string, private readonly artifactDirectory: string) {
    mkdirSync(artifactDirectory, { recursive: true });
    this.db = new Database(path);
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS draft_version_links (
      artifact_version_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
      breakdown_version_id TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS draft_version_links_task ON draft_version_links(task_id, created_at);
    CREATE TABLE IF NOT EXISTS draft_jobs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT,
      breakdown_version_id TEXT NOT NULL, request_key TEXT NOT NULL, task_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(task_id, request_key)
    );
    CREATE INDEX IF NOT EXISTS draft_queue ON draft_jobs(status, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS draft_jobs_one_active ON draft_jobs(task_id) WHERE status IN ('QUEUED','RUNNING');`);
  }

  artifactSource(taskId: string, versionId: string): 'CREATE' | 'REVISE' | null {
    const row = z.object({ source: z.enum(['CREATE', 'REVISE']) }).nullable().parse(
      this.db.prepare('SELECT source FROM draft_version_links WHERE task_id=? AND artifact_version_id=?').get(taskId, versionId) ?? null);
    return row?.source ?? null;
  }

  snapshot(taskId: string): DraftFlowSnapshot {
    return this.db.transaction(() => {
      const state = this.taskState(taskId);
      const versions = this.versions(taskId);
      const latest = versions.at(-1);
      const preparationActive = this.active('preparation_jobs', taskId);
      const busy = this.active('breakdown_jobs', taskId);
      const row = this.latestArtifact(taskId);
      const tracking = row ? this.tracking(taskId, row.versionId, versions) : null;
      const job = jobRowSchema.nullable().parse(this.db.prepare('SELECT * FROM draft_jobs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(taskId) ?? null);
      const blockReason: DraftFlowSnapshot['blockReason'] = state.deleted_at || closed(state.status) ? 'TASK_NOT_RUNNABLE'
        : this.active('draft_jobs', taskId) ? 'DRAFT_JOB_ACTIVE'
        : preparationActive ? 'PREPARING' : busy ? 'BREAKDOWN_BUSY'
        : !latest ? 'NO_BREAKDOWN' : !latest.steps.length ? 'EMPTY_BREAKDOWN'
        : !breakdownStepsSchema.safeParse(latest.steps).success ? 'INVALID_BREAKDOWN' : null;
      return draftFlowSnapshotSchema.parse({ preparationActive, hasRelatedMaterials: this.hasRelatedMaterials(taskId),
        breakdown: { latestVersionId: latest?.id ?? null, latestNumber: latest?.number ?? 0, stepCount: latest?.steps.length ?? 0, busy },
        draft: row && tracking ? { versionId: row.versionId, version: row.version, createdAt: row.createdAt, mode: row.mode, modeLabel: modeLabel(row.mode, row.fallbackReason), basedOnVersionId: tracking.base?.id ?? null, basedOnNumber: tracking.base?.number ?? null, tracking: tracking.kind } : null,
        stale: Boolean(tracking?.base && latest && JSON.stringify(tracking.base.steps) !== JSON.stringify(latest.steps)),
        job: job ? toJob(job) : null, canCreate: blockReason === null, blockReason,
      });
    })();
  }

  enqueue(taskId: string, breakdownVersionId: string, requestKey: string): DraftJob {
    z.string().min(1).max(128).parse(requestKey);
    return this.db.transaction(() => {
      const state = this.taskState(taskId);
      if (state.deleted_at) throw new DraftFlowError('NOT_FOUND');
      const prior = jobRowSchema.nullable().parse(this.db.prepare('SELECT * FROM draft_jobs WHERE task_id = ? AND request_key = ?').get(taskId, requestKey) ?? null);
      if (prior) { if (prior.breakdown_version_id !== breakdownVersionId) throw new DraftFlowError('CONFLICT'); return toJob(prior); }
      if (closed(state.status)) throw new DraftFlowError('TASK_NOT_RUNNABLE');
      if (this.active('draft_jobs', taskId)) throw new DraftFlowError('DRAFT_JOB_ACTIVE');
      if (this.active('preparation_jobs', taskId) || this.active('breakdown_jobs', taskId)) throw new DraftFlowError('BREAKDOWN_BUSY');
      const latest = this.versions(taskId).at(-1);
      if (!latest || latest.steps.length === 0) throw new DraftFlowError('BREAKDOWN_EMPTY');
      if (latest.id !== breakdownVersionId) throw new DraftFlowError('BREAKDOWN_CHANGED');
      if (!breakdownStepsSchema.safeParse(latest.steps).success) throw new DraftFlowError('BREAKDOWN_INVALID');
      const now = new Date().toISOString(); const id = randomUUID();
      this.db.prepare("INSERT INTO draft_jobs(id,task_id,status,error_code,breakdown_version_id,request_key,task_revision,created_at,updated_at) VALUES (?,?,'QUEUED',NULL,?,?,?,?,?)")
        .run(id, taskId, latest.id, requestKey, state.revision, now, now);
      return this.getJob(id);
    }).immediate();
  }

  cancel(taskId: string, jobId: string): DraftJob {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT id FROM draft_jobs WHERE id = ? AND task_id = ?').get(jobId, taskId);
      if (!row) throw new DraftFlowError('NOT_FOUND');
      this.db.prepare("UPDATE draft_jobs SET status='CANCELLED', updated_at=? WHERE id=? AND status IN ('QUEUED','RUNNING')").run(new Date().toISOString(), jobId);
      return this.getJob(jobId);
    }).immediate();
  }

  async runNextPreparation(tasks: TaskStore, adapter: PreparationAdapter): Promise<PreparationJob | null> {
    const row = this.db.transaction(() => {
      const job = z.object({ id: z.string(), task_id: z.string() }).nullable().parse(this.db.prepare("SELECT id,task_id FROM preparation_jobs WHERE status='QUEUED' ORDER BY created_at,rowid LIMIT 1").get() ?? null);
      if (job) this.db.prepare("UPDATE preparation_jobs SET status='RUNNING',updated_at=? WHERE id=?").run(new Date().toISOString(), job.id);
      return job;
    }).immediate();
    if (!row) return null;
    const finish = (status: PreparationJob['status'], code: string | null) => {
      const now = new Date().toISOString();
      this.db.prepare('UPDATE preparation_jobs SET status=?,error_code=?,updated_at=? WHERE id=?').run(status, code, now, row.id);
      this.db.prepare('UPDATE tasks SET ai_status=?,revision=revision+1,updated_at=? WHERE id=? AND deleted_at IS NULL').run(status === 'SUCCEEDED' ? 'READY' : status === 'CANCELLED' ? 'CANCELLED' : 'FAILED', now, row.task_id);
    };
    const task = tasks.get(row.task_id);
    if (!task || closed(task.status)) finish('CANCELLED', 'TASK_NOT_RUNNABLE');
    else {
      const base = this.versions(task.id).at(-1)?.id ?? null;
      tasks.updateAiStatus(task.id, 'RUNNING');
      try {
        if (!adapter.initialBreakdown) throw new Error('初回分解非対応');
        const generation = breakdownGenerationSchema.parse(await adapter.initialBreakdown(task));
        this.db.transaction(() => {
          const state = stateSchema.nullable().parse(this.db.prepare('SELECT status,revision,deleted_at FROM tasks WHERE id=?').get(task.id) ?? null);
          if (!state || state.deleted_at) { finish('CANCELLED', 'TASK_NOT_RUNNABLE'); return; }
          if ((this.versions(task.id).at(-1)?.id ?? null) !== base) { finish('FAILED', 'BREAKDOWN_CHANGED'); return; }
          const previous = this.versions(task.id).at(-1);
          const version = breakdownVersionSchema.parse({ id: randomUUID(), taskId: task.id, number: (previous?.number ?? 0) + 1, parentVersion: previous?.id ?? null, kind: 'ai', steps: generation.steps, mode: generation.mode, fallbackReason: generation.fallbackReason, comment: '', sourceVersion: null, createdAt: new Date().toISOString() });
          this.db.prepare('INSERT INTO breakdown_versions(id,task_id,number,data_json,source_artifact) VALUES (?,?,?,?,NULL)').run(version.id, task.id, version.number, JSON.stringify(version));
          finish('SUCCEEDED', null);
        }).immediate();
      } catch { finish('FAILED', 'GENERATION_FAILED'); }
    }
    const result = z.object({ id: z.string(), task_id: z.string(), status: preparationJobSchema.shape.status, created_at: z.string(), updated_at: z.string(), error_code: z.string().nullable() }).parse(this.db.prepare('SELECT * FROM preparation_jobs WHERE id=?').get(row.id));
    return preparationJobSchema.parse({ id: result.id, taskId: result.task_id, status: result.status, mode: 'mock', createdAt: result.created_at, updatedAt: result.updated_at, errorCode: result.error_code });
  }

  async runNextDraft(tasks: TaskStore, adapter: PreparationAdapter): Promise<DraftJob | null> {
    const queued = this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare("UPDATE draft_jobs SET status='FAILED',error_code='WORKER_INTERRUPTED',updated_at=? WHERE status='RUNNING' AND updated_at < ?").run(now, new Date(Date.now() - 15 * 60_000).toISOString());
      const job = jobRowSchema.nullable().parse(this.db.prepare("SELECT * FROM draft_jobs WHERE status='QUEUED' ORDER BY created_at,rowid LIMIT 1").get() ?? null);
      if (job) this.db.prepare("UPDATE draft_jobs SET status='RUNNING',updated_at=? WHERE id=?").run(now, job.id);
      return job;
    }).immediate();
    if (!queued) return null;
    const validate = () => {
      const state = stateSchema.nullable().parse(this.db.prepare('SELECT status,revision,deleted_at FROM tasks WHERE id=?').get(queued.task_id) ?? null);
      if (!state || state.deleted_at || closed(state.status)) { this.finishDraft(queued.id, 'CANCELLED', 'TASK_NOT_RUNNABLE'); return false; }
      if (state.revision !== queued.task_revision) { this.finishDraft(queued.id, 'FAILED', 'TASK_CHANGED'); return false; }
      if (this.versions(queued.task_id).at(-1)?.id !== queued.breakdown_version_id) { this.finishDraft(queued.id, 'FAILED', 'BREAKDOWN_CHANGED'); return false; }
      return this.getJob(queued.id).status === 'RUNNING';
    };
    try {
      const valid = this.db.transaction(validate).immediate();
      if (!valid) return this.getJob(queued.id);
      const task = tasks.get(queued.task_id);
      if (!task) { this.finishDraft(queued.id, 'CANCELLED', 'TASK_NOT_RUNNABLE'); return this.getJob(queued.id); }
      const steps = this.versions(task.id).at(-1)!.steps;
      if (!adapter.createDraft) throw new Error('ドラフト作成非対応');
      const generation = generationSchema.parse(await adapter.createDraft(task, steps));
      let written: string | null = null;
      try {
        this.db.transaction(() => {
          if (!validate()) return;
          this.saveArtifact(task.id, { ...generation, plan: { ...generation.plan, steps } }, queued.breakdown_version_id, 'CREATE', queued.id, null, file => { written = file; });
          this.finishDraft(queued.id, 'SUCCEEDED', null);
        }).immediate();
      } catch (error) { if (written) this.removeUnrecordedFile(written); throw error; }
    } catch { this.db.prepare("UPDATE draft_jobs SET status='FAILED',error_code='GENERATION_FAILED',updated_at=? WHERE id=? AND status='RUNNING'").run(new Date().toISOString(), queued.id); }
    return this.getJob(queued.id);
  }

  async reviseDraft(taskId: string, rawFeedback: string, tasks: TaskStore, adapter: PreparationAdapter): Promise<StoredArtifact> {
    const feedback = z.string().trim().min(1).max(20_000).parse(rawFeedback);
    if (this.active('draft_jobs', taskId)) throw new DraftFlowError('DRAFT_JOB_ACTIVE');
    const task = tasks.get(taskId); const previous = this.latestArtifact(taskId);
    if (!task || !previous) throw new Error('改訂する成果物がありません。');
    if (closed(task.status)) throw new Error('完了または中止したタスクは改訂できません。');
    if (!adapter.reviseDraft) throw new Error('このAIアダプターは改訂に対応していません。');
    const versions = this.versions(taskId); const latestSteps = versions.at(-1)?.steps ?? [];
    const tracking = this.tracking(taskId, previous.versionId, versions);
    const generation = generationSchema.parse(await adapter.reviseDraft(task, previous.content, feedback, latestSteps));
    let written: string | null = null;
    try {
      this.db.transaction(() => {
        const state = this.taskState(taskId);
        if (state.deleted_at) throw new Error('改訂中にタスクが削除されたため、修正版を保存しませんでした。');
        if (closed(state.status)) throw new Error('改訂中にタスクが完了または中止されたため、修正版を保存しませんでした。');
        if (state.revision !== task.revision) throw new Error('改訂中にタスクが変更されたため、修正版を保存しませんでした。もう一度お試しください。');
        if (this.active('draft_jobs', taskId)) throw new DraftFlowError('DRAFT_JOB_ACTIVE');
        if (this.latestArtifact(taskId)?.versionId !== previous.versionId) throw new Error('改訂中に別の版が作成されたため、修正版を保存しませんでした。最新の版を確認してください。');
        this.saveArtifact(taskId, { ...generation, plan: { ...generation.plan, steps: latestSteps.length ? latestSteps : previous.plan.steps } }, tracking.base?.id ?? null, 'REVISE', null, { previous, feedback }, file => { written = file; });
      }).immediate();
    } catch (error) { if (written) this.removeUnrecordedFile(written); throw error; }
    return this.latestArtifact(taskId) ?? (() => { throw new Error('改訂版を再取得できません。'); })();
  }

  private saveArtifact(taskId: string, generation: Generation, base: string | null, source: 'CREATE' | 'REVISE', jobId: string | null, revision: { previous: StoredArtifact; feedback: string } | null, onWritten: (path: string) => void) {
    const previous = this.latestArtifact(taskId); const id = previous?.id ?? randomUUID(); const version = (previous?.version ?? 0) + 1; const versionId = randomUUID(); const now = new Date().toISOString(); const fileName = `${id}-v${version}.md`; const path = join(this.artifactDirectory, fileName);
    if (this.db.prepare('SELECT id FROM artifact_versions WHERE file_name=? LIMIT 1').get(fileName)) throw new Error('記録済みのドラフトファイルは置換できません。');
    // immediate トランザクション内で、停止時に残った未記録ファイルだけを置換する。
    rmSync(path, { force: true });
    writeFileSync(path, generation.markdown, { flag: 'wx' }); onWritten(path);
    if (previous) this.db.prepare('UPDATE artifacts SET current_version=? WHERE id=?').run(version, id);
    else this.db.prepare('INSERT INTO artifacts(id,task_id,current_version,created_at) VALUES (?,?,?,?)').run(id, taskId, version, now);
    this.db.prepare("INSERT INTO artifact_versions(id,artifact_id,version_number,parent_version_id,content,file_name,change_summary,created_at,mode,fallback_reason,job_id,save_status,plan_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,'MOCK_SAVED',?)").run(versionId, id, version, revision?.previous.versionId ?? null, generation.markdown, fileName, generation.changeSummary, now, generation.meta?.mode ?? 'mock', generation.meta?.fallbackReason ?? null, jobId, JSON.stringify(generation.plan));
    this.db.prepare('INSERT INTO draft_version_links(artifact_version_id,task_id,breakdown_version_id,source,created_at) VALUES (?,?,?,?,?)').run(versionId, taskId, base, source, now);
    if (revision) this.db.prepare('INSERT INTO feedback(id,artifact_version_id,content,applied_to_version_id,created_at) VALUES (?,?,?,?,?)').run(randomUUID(), revision.previous.versionId, revision.feedback, versionId, now);
  }
  private removeUnrecordedFile(path: string) {
    this.db.transaction(() => {
      // ロールバック後に同じ次版を確定した別の保存処理を保護する。
      if (!this.db.prepare('SELECT id FROM artifact_versions WHERE file_name=? LIMIT 1').get(basename(path))) rmSync(path, { force: true });
    }).immediate();
  }
  private latestArtifact(taskId: string): StoredArtifact | null {
    const row = z.object({ id: z.string(), artifact_id: z.string(), version_number: z.number(), parent_version_id: z.string().nullable(), file_name: z.string(), mode: z.enum(['mock', 'ai', 'mock_fallback']), fallback_reason: z.string().nullable(), job_id: z.string().nullable(), content: z.string(), change_summary: z.string(), created_at: z.string(), plan_json: z.string() }).nullable().parse(this.db.prepare('SELECT av.* FROM artifact_versions av JOIN artifacts a ON a.id=av.artifact_id WHERE a.task_id=? ORDER BY av.version_number DESC LIMIT 1').get(taskId) ?? null);
    if (!row) return null;
    return { id: row.artifact_id, versionId: row.id, parentVersionId: row.parent_version_id, taskId, version: row.version_number, path: join(this.artifactDirectory, row.file_name), mode: row.mode, fallbackReason: row.fallback_reason, jobId: row.job_id, saveStatus: 'MOCK_SAVED', createdAt: row.created_at, plan: generationSchema.shape.plan.parse(JSON.parse(row.plan_json)), content: row.content, changeSummary: row.change_summary };
  }
  private tracking(taskId: string, artifactId: string, versions: BreakdownVersion[]) {
    const link = z.object({ breakdown_version_id: z.string().nullable() }).nullable().parse(this.db.prepare('SELECT breakdown_version_id FROM draft_version_links WHERE artifact_version_id=? AND task_id=?').get(artifactId, taskId) ?? null);
    if (link) { const base = versions.find(version => version.id === link.breakdown_version_id) ?? null; return { kind: base ? 'TRACKED' : 'UNKNOWN', base }; }
    const imported = z.object({ id: z.string() }).nullable().parse(this.db.prepare('SELECT id FROM breakdown_versions WHERE task_id=? AND source_artifact=?').get(taskId, artifactId) ?? null);
    const base = versions.find(version => version.id === imported?.id) ?? null;
    return { kind: base ? 'INFERRED' : 'UNKNOWN', base };
  }
  private versions(taskId: string) { return z.array(z.object({ data_json: z.string() })).parse(this.db.prepare('SELECT data_json FROM breakdown_versions WHERE task_id=? ORDER BY number').all(taskId)).map(row => breakdownVersionSchema.parse(JSON.parse(row.data_json))); }
  private taskState(taskId: string) { const row = stateSchema.nullable().parse(this.db.prepare('SELECT status,revision,deleted_at FROM tasks WHERE id=?').get(taskId) ?? null); if (!row) throw new DraftFlowError('NOT_FOUND'); return row; }
  private active(table: 'preparation_jobs' | 'breakdown_jobs' | 'draft_jobs', taskId: string) {
    if (table === 'preparation_jobs') return Boolean(this.db.prepare("SELECT id FROM preparation_jobs WHERE task_id=? AND (status='QUEUED' OR (status='RUNNING' AND updated_at >= ?)) LIMIT 1").get(taskId, new Date(Date.now() - 15 * 60_000).toISOString()));
    return Boolean(this.db.prepare(`SELECT id FROM ${table} WHERE task_id=? AND status IN ('QUEUED','RUNNING') LIMIT 1`).get(taskId));
  }
  private hasRelatedMaterials(taskId: string) {
    return (['task_references', 'task_inputs'] as const).some(table =>
      Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) &&
      Boolean(this.db.prepare(`SELECT id FROM ${table} WHERE task_id=? LIMIT 1`).get(taskId)));
  }
  private getJob(id: string): DraftJob { return toJob(jobRowSchema.parse(this.db.prepare('SELECT * FROM draft_jobs WHERE id=?').get(id))); }
  private finishDraft(id: string, status: DraftJob['status'], code: string | null) { this.db.prepare("UPDATE draft_jobs SET status=?,error_code=?,updated_at=? WHERE id=? AND status='RUNNING'").run(status, code, new Date().toISOString(), id); }
  close() { this.db.close(); }
}
function toJob(row: JobRow): DraftJob { return { id: row.id, status: row.status, errorCode: row.error_code, message: draftJobMessage(row.error_code), breakdownVersionId: row.breakdown_version_id, createdAt: row.created_at }; }
