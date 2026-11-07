import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { TaskStore } from './task-store';
import { InputStore } from './input-store';
import { PreparationStore } from './preparation-store';
import { MockAiAdapter } from './mock-ai';
import { ScheduleStore } from './scheduling';
import { MockCalendarAdapter } from './mock-calendar';

const databasePath = resolve(process.env.DATABASE_PATH || 'data/task-planner.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });

declare global {
  var __taskStore: TaskStore | undefined;
  var __inputStore: InputStore | undefined;
  var __preparationStore: PreparationStore | undefined;
  var __scheduleStore: ScheduleStore | undefined;
}

export const taskStore = globalThis.__taskStore ??= new TaskStore(databasePath);
export const inputStore = globalThis.__inputStore ??= new InputStore(databasePath, resolve(process.env.BLOB_DIRECTORY || 'data/blobs'));
export const preparationStore = globalThis.__preparationStore ??= new PreparationStore(databasePath, resolve(process.env.ARTIFACT_DIRECTORY || 'data/artifacts'));
export const mockAiAdapter = new MockAiAdapter();
export const scheduleStore = globalThis.__scheduleStore ??= new ScheduleStore(databasePath);
export const mockCalendarAdapter = new MockCalendarAdapter();
