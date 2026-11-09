import { scheduleStore, taskStore } from '../../../../../adapters/runtime';
import { taskHandlers } from '../../../../../adapters/task-api';

export const runtime = 'nodejs';
const handlers = taskHandlers({ tasks: taskStore, schedules: scheduleStore });

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handlers.scheduleGET(request, (await context.params).id);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handlers.schedulePOST(request, (await context.params).id);
}
