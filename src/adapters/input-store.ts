import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  analysisStatus: 'NOT_PROCESSED';
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
    return rows.map((row) => toStoredInput(row, this.blobDirectory));
  }

  close(): void { this.db.close(); }

  private listBatch(taskId: string, operationKey: string): StoredInput[] {
    const rows = z.array(inputRowSchema).parse(this.db.prepare('SELECT * FROM task_inputs WHERE task_id = ? AND operation_key = ? ORDER BY sort_order').all(taskId, operationKey));
    return rows.map((row) => toStoredInput(row, this.blobDirectory));
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
