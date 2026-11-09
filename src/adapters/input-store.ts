import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync, openSync, closeSync, readFileSync, realpathSync, constants } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';

export const newInputSchema = z.object({
  type: z.enum(['AUDIO', 'IMAGE', 'PDF']),
  mime: z.string().min(1),
  name: z.string().min(1).max(255),
  bytes: z.instanceof(Buffer).refine((value) => value.length > 0),
  durationSeconds: z.number().nonnegative().optional(),
});
export type NewInput = z.infer<typeof newInputSchema>;

const inputRowSchema = z.object({
  id: z.string().uuid(), task_id: z.string(), input_type: z.enum(['AUDIO', 'IMAGE', 'PDF']),
  mime: z.string(), name: z.string(), blob_name: z.string(), content_hash: z.string(),
  created_at: z.string(), sort_order: z.number(), operation_key: z.string(),
});
export type StoredInput = {
  id: string;
  taskId: string;
  type: NewInput['type'];
  mime: string;
  name: string;
  path: string;
  createdAt: string;
  order: number;
  mode: 'mock';
  analysisStatus: 'NOT_PROCESSED' | 'EXTRACTED';
  extractedText?: string;
};

const maxFileBytes = 10 * 1024 * 1024;
const maxInputs = 10;

export function validateInputBatch(inputs: readonly NewInput[], alreadyStored = 0): NewInput[] {
  const parsed = inputs.map((input) => newInputSchema.parse(input));
  if (parsed.length === 0 || alreadyStored + parsed.length > maxInputs) throw new Error('添付は1件以上10件以下です。');
  for (const input of parsed) {
    if (input.bytes.length > maxFileBytes) throw new Error('ファイルは10MiB以下にしてください。');
    if (input.durationSeconds !== undefined && input.durationSeconds > 300) throw new Error('音声は5分以内にしてください。');
    if (!validMimeAndSignature(input)) throw new Error('ファイル形式と内容が一致しません。');
  }
  return parsed.slice();
}

export class InputStore {
  private readonly db: Database.Database;

  constructor(databasePath: string, private readonly blobDirectory: string) {
    mkdirSync(blobDirectory, { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS upload_batches (
      task_id TEXT NOT NULL, operation_key TEXT NOT NULL, request_hash TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(task_id, operation_key)
    );
    CREATE TABLE IF NOT EXISTS task_inputs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, input_type TEXT NOT NULL, mime TEXT NOT NULL, name TEXT NOT NULL,
      blob_name TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, sort_order INTEGER NOT NULL,
      operation_key TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_inputs_task_order ON task_inputs(task_id, sort_order);`);
    createImageTables(this.db);
  }

  addBatch(taskId: string, rawInputs: readonly NewInput[], operationKey: string = randomUUID()): StoredInput[] {
    const priorBatch = this.db.prepare('SELECT request_hash FROM upload_batches WHERE task_id = ? AND operation_key = ?').get(taskId, operationKey);
    if (priorBatch) {
      const inputs = validateInputBatch(rawInputs);
      const requestHash = hashInputs(inputs);
      const parsedPrior = z.object({ request_hash: z.string() }).parse(priorBatch);
      if (parsedPrior.request_hash !== requestHash) throw new Error('この操作キーは別の内容に使われています。');
      return this.listBatch(taskId, operationKey);
    }
    const inputs = validateInputBatch(rawInputs, this.list(taskId).length);
    const requestHash = hashInputs(inputs);
    const batchTime = new Date().toISOString();
    const fileRows = inputs.map((input, index) => ({
      id: randomUUID(), taskId, input, blobName: `${randomUUID()}.blob`,
      hash: createHash('sha256').update(input.bytes).digest('hex'), index,
    }));
    for (const file of fileRows) {
      const tempPath = join(this.blobDirectory, `${file.blobName}.tmp`);
      writeFileSync(tempPath, file.input.bytes, { flag: 'wx' });
      renameSync(tempPath, join(this.blobDirectory, file.blobName));
    }
    const save = this.db.transaction(() => {
      this.db.prepare('INSERT INTO upload_batches(task_id, operation_key, request_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(taskId, operationKey, requestHash, batchTime);
      const insert = this.db.prepare(`INSERT INTO task_inputs(
        id, task_id, input_type, mime, name, blob_name, content_hash, created_at, sort_order, operation_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const file of fileRows) insert.run(file.id, taskId, file.input.type, file.input.mime, file.input.name,
        file.blobName, file.hash, batchTime, file.index, operationKey);
    });
    save();
    return this.listBatch(taskId, operationKey);
  }

  list(taskId: string): StoredInput[] {
    const rows = z.array(inputRowSchema).parse(this.db.prepare('SELECT * FROM task_inputs WHERE task_id = ? ORDER BY created_at, sort_order').all(taskId));
    return rows.map((row) => this.withAnalysis(toStoredInput(row, this.blobDirectory)));
  }

  addProposalImage(taskId: string, proposalId: string, image: { bytes: Buffer; name: string }, afterWrite?: () => void): StoredInput {
    if (!uuidPattern.test(proposalId)) throw new Error('NOT_FOUND');
    const operationKey = `image-proposal:${proposalId}`;
    return this.db.transaction(() => {
      const existing = this.listBatch(taskId, operationKey)[0];
      if (existing) return existing;
      const blobName = `${proposalId}.blob`;
      const temporary = join(this.blobDirectory, `${blobName}.${randomUUID()}.tmp`);
      writeFileSync(temporary, image.bytes, {mode: 0o600, flag: 'wx'});
      renameSync(temporary, join(this.blobDirectory, blobName));
      afterWrite?.();
      const now = new Date().toISOString();
      const hash = createHash('sha256').update(image.bytes).digest('hex');
      this.db.prepare('INSERT INTO upload_batches(task_id, operation_key, request_hash, created_at) VALUES (?, ?, ?, ?)').run(taskId,operationKey,hash,now);
      this.db.prepare(`INSERT INTO task_inputs(id,task_id,input_type,mime,name,blob_name,content_hash,created_at,sort_order,operation_key)
        VALUES (?,?,'IMAGE','image/jpeg',?,?,?,?,0,?)`).run(randomUUID(),taskId,image.name,blobName,hash,now,operationKey);
      const result = this.listBatch(taskId,operationKey)[0];
      if (!result) throw new Error('保存した添付を取得できません。');
      return result;
    }).immediate();
  }

  addAnalysis(input: { inputId: string; taskId: string; mode: string; extractedText: string; proposalId: string }): void {
    if (input.mode !== 'ai' || !input.extractedText.trim()) return;
    this.db.prepare(`INSERT OR IGNORE INTO task_input_analyses(input_id,task_id,mode,extracted_text,proposal_id,created_at)
      VALUES (?,?,'ai',?,?,?)`).run(input.inputId,input.taskId,input.extractedText,input.proposalId,new Date().toISOString());
  }

  readImage(taskId: string, inputId: string): { bytes: Buffer; mime: string } | null {
    const raw = this.db.prepare("SELECT * FROM task_inputs WHERE task_id=? AND id=? AND input_type='IMAGE'").get(taskId,inputId);
    if (!raw) return null;
    const row = inputRowSchema.parse(raw);
    const bytes = readSafeImage(this.blobDirectory,row.blob_name,'blob');
    return bytes ? {bytes,mime:row.mime} : null;
  }

  private withAnalysis(input: StoredInput): StoredInput {
    const row = z.object({extracted_text:z.string()}).nullable().parse(this.db.prepare("SELECT extracted_text FROM task_input_analyses WHERE input_id=? AND task_id=? AND mode='ai'").get(input.id,input.taskId) ?? null);
    return row ? {...input,analysisStatus:'EXTRACTED',extractedText:row.extracted_text} : input;
  }

  close(): void { this.db.close(); }

  private listBatch(taskId: string, operationKey: string): StoredInput[] {
    const rows = z.array(inputRowSchema).parse(this.db.prepare('SELECT * FROM task_inputs WHERE task_id = ? AND operation_key = ? ORDER BY sort_order').all(taskId, operationKey));
    return rows.map((row) => this.withAnalysis(toStoredInput(row, this.blobDirectory)));
  }
}

function validMimeAndSignature(input: NewInput): boolean {
  const bytes = input.bytes;
  if (input.type === 'IMAGE') {
    if (input.mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (input.mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    return false;
  }
  if (input.type === 'PDF') return input.mime === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-';
  if (input.mime === 'audio/webm') return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (input.mime === 'audio/wav') return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE';
  if (input.mime === 'audio/mpeg') return bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 255 && (bytes[1]! & 224) === 224);
  return false;
}

function hashInputs(inputs: readonly NewInput[]): string {
  const hash = createHash('sha256');
  for (const input of inputs) hash.update(input.type).update('\0').update(input.mime).update('\0').update(input.bytes);
  return hash.digest('hex');
}

function toStoredInput(row: z.infer<typeof inputRowSchema>, blobDirectory: string): StoredInput {
  return {
    id: row.id, taskId: row.task_id, type: row.input_type, mime: row.mime, name: row.name,
    path: join(blobDirectory, row.blob_name), createdAt: row.created_at, order: row.sort_order,
    mode: 'mock', analysisStatus: 'NOT_PROCESSED',
  };
}

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function readSafeImage(directory: string, name: string, extension: 'jpg' | 'blob'): Buffer | null {
  if (!new RegExp(`^${uuidPattern.source.slice(1,-1)}\\.${extension}$`).test(name)) return null;
  let descriptor: number | undefined;
  try {
    const base = realpathSync(directory);
    const target = join(base,name);
    const resolved = realpathSync(target);
    const local = relative(base,resolved);
    if (!local || local.startsWith('..') || isAbsolute(local)) return null;
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    return readFileSync(descriptor);
  } catch { return null; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function createImageTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS image_proposals (
    id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
    status TEXT NOT NULL, original_name TEXT NOT NULL, stored_name TEXT NOT NULL,
    source_format TEXT NOT NULL, blob_name TEXT NOT NULL, content_hash TEXT NOT NULL,
    byte_size INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, note TEXT NOT NULL,
    mode TEXT, fallback_reason TEXT, result_json TEXT, attempt_token TEXT, lease_until TEXT,
    task_id TEXT, confirmed_json TEXT, confirmed_hash TEXT, create_token TEXT, create_lease_until TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS image_proposals_queue ON image_proposals(status, created_at);
  CREATE TABLE IF NOT EXISTS task_input_analyses (
    input_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, mode TEXT NOT NULL,
    extracted_text TEXT NOT NULL, proposal_id TEXT NOT NULL, created_at TEXT NOT NULL
  );`);
}
