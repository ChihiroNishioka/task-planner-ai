import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InputStore, validateInputBatch, type NewInput } from '../src/adapters/input-store';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const pdf = Buffer.from('%PDF-1.7\n');
const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00]);
function input(type: NewInput['type'], bytes: Buffer, name = 'attachment'): NewInput {
  const mime = type === 'IMAGE' ? 'image/png' : type === 'PDF' ? 'application/pdf' : 'audio/webm';
  return { type, mime, name, bytes };
}

describe('Phase 2 file inputs', () => {
  let directory: string;
  let store: InputStore;
  const taskId = '8e985dc0-2b0b-44d5-93a7-f2a8bd934019';

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'task-planner-inputs-'));
    store = new InputStore(join(directory, 'tasks.sqlite'), join(directory, 'blobs'));
  });
  afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  it('T-04-01 stores three ordered images and one PDF under the selected task', () => {
    const saved = store.addBatch(taskId, [input('IMAGE', png), input('IMAGE', png), input('IMAGE', png), input('PDF', pdf)], 'bundle');
    expect(saved.map((entry) => entry.type)).toEqual(['IMAGE', 'IMAGE', 'IMAGE', 'PDF']);
    expect(saved.every((entry) => entry.taskId === taskId && entry.mode === 'mock')).toBe(true);
    expect(saved.map((entry) => readFileSync(entry.path))).toEqual([png, png, png, pdf]);
  });

  it('T-04-02 rejects MIME mismatches, corrupt files, files over 10 MiB, and more than ten inputs', () => {
    expect(() => validateInputBatch([input('IMAGE', pdf)])).toThrow();
    expect(() => validateInputBatch([input('IMAGE', Buffer.from('not an image'))])).toThrow();
    expect(() => validateInputBatch([input('IMAGE', Buffer.alloc(10 * 1024 * 1024 + 1, 0))])).toThrow();
    expect(() => validateInputBatch(Array.from({ length: 11 }, () => input('IMAGE', png)))).toThrow();
  });

  it('T-04-03 accepts ten inputs at the 10 MiB limit', () => {
    const exact = Buffer.alloc(10 * 1024 * 1024);
    png.copy(exact);
    const files = Array.from({ length: 10 }, () => input('IMAGE', exact));
    expect(validateInputBatch(files)).toHaveLength(10);
  });

  it('T-04-04 preserves ordered input metadata when reopened under another host timezone', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'UTC';
    store.addBatch(taskId, [input('AUDIO', audio)], 'timezone');
    store.close();
    process.env.TZ = 'Asia/Tokyo';
    store = new InputStore(join(directory, 'tasks.sqlite'), join(directory, 'blobs'));
    expect(store.list(taskId)[0]).toMatchObject({ taskId, type: 'AUDIO', mode: 'mock' });
    process.env.TZ = previous;
  });

  it('T-04-05 returns the same saved inputs for concurrent retries with one key', async () => {
    store.addBatch(taskId, Array.from({ length: 9 }, () => input('IMAGE', png)), 'first-nine');
    const results = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve(store.addBatch(taskId, [input('PDF', pdf)], 'same-upload'))));
    expect(new Set(results.map((items) => items[0]?.id)).size).toBe(1);
    expect(store.list(taskId)).toHaveLength(10);
  });

  it('T-04-06 recovers input metadata and blob after the store restarts', () => {
    store.addBatch(taskId, [input('PDF', pdf)], 'restart');
    store.close();
    store = new InputStore(join(directory, 'tasks.sqlite'), join(directory, 'blobs'));
    expect(readFileSync(store.list(taskId)[0]!.path)).toEqual(pdf);
  });
});
