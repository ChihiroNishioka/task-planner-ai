import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BreakdownStore } from './breakdown-store';
import { TaskStore } from './task-store';
import { InputStore } from './input-store';
import { PreparationStore } from './preparation-store';
import { MockAiAdapter, type PreparationAdapter } from './mock-ai';
import { aiMode } from './ai-config';
import { CliAiAdapter, createCliRunnerFromEnv, FallbackAiAdapter } from './cli-ai';
import { ScheduleStore } from './scheduling';
import { MockCalendarAdapter } from './mock-calendar';
import { ReviewStore } from './review-store';
import { WorkerStatusStore } from './worker-status';

const databasePath = resolve(process.env.DATABASE_PATH || 'data/task-planner.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });

declare global {
  var __breakdownStore: BreakdownStore | undefined;
  var __taskStore: TaskStore | undefined;
  var __inputStore: InputStore | undefined;
  var __preparationStore: PreparationStore | undefined;
  var __scheduleStore: ScheduleStore | undefined;
  var __reviewStore: ReviewStore | undefined;
  var __workerStatusStore: WorkerStatusStore | undefined;
}

export const taskStore = globalThis.__taskStore ??= new TaskStore(databasePath);
export const inputStore = globalThis.__inputStore ??= new InputStore(databasePath, resolve(process.env.BLOB_DIRECTORY || 'data/blobs'));
export const preparationStore = globalThis.__preparationStore ??= new PreparationStore(databasePath, resolve(process.env.ARTIFACT_DIRECTORY || 'data/artifacts'));
export const mockAiAdapter = new MockAiAdapter();
export { aiMode };
/** AI_MODE=cli のときはサブスクCLIの実AIを使い、失敗時はモックに戻す。 */
export const preparationAdapter: PreparationAdapter = aiMode === 'cli'
  ? new FallbackAiAdapter(new CliAiAdapter(createCliRunnerFromEnv()), mockAiAdapter)
  : mockAiAdapter;
export const scheduleStore = globalThis.__scheduleStore ??= new ScheduleStore(databasePath);
export const mockCalendarAdapter = new MockCalendarAdapter();
export const reviewStore = globalThis.__reviewStore ??= new ReviewStore(databasePath);
export const workerStatusStore = globalThis.__workerStatusStore ??= new WorkerStatusStore(databasePath);

export const breakdownStore = globalThis.__breakdownStore ??= new BreakdownStore(databasePath);
