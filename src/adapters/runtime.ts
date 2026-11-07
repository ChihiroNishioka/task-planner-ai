import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { TaskStore } from './task-store';
import { InputStore } from './input-store';

const databasePath = resolve(process.env.DATABASE_PATH || 'data/task-planner.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });

declare global {
  var __taskStore: TaskStore | undefined;
  var __inputStore: InputStore | undefined;
}

export const taskStore = globalThis.__taskStore ??= new TaskStore(databasePath);
export const inputStore = globalThis.__inputStore ??= new InputStore(databasePath, resolve(process.env.BLOB_DIRECTORY || 'data/blobs'));
