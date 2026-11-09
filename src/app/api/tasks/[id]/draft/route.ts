import { draftFlowStore, taskStore } from '../../../../../adapters/runtime';
import { draftHandlers } from '../../../../../adapters/draft-api';

export const runtime = 'nodejs';
const handle = draftHandlers({ drafts: draftFlowStore, tasks: taskStore });
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, (await context.params).id);
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, (await context.params).id);
}
