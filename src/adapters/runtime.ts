import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { TaskStore } from './task-store';

const databasePath = resolve(process.env.DATABASE_PATH || 'data/task-planner.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });

declare global {
  var __taskStore: TaskStore | undefined;
}

export const taskStore = globalThis.__taskStore ??= new TaskStore(databasePath);
