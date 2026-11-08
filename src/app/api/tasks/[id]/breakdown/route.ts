import { breakdownStore, preparationStore, taskStore } from '../../../../../adapters/runtime';
import { breakdownHandlers } from '../../../../../adapters/breakdown-api';

export const runtime = 'nodejs';
const handle = breakdownHandlers({ breakdown: breakdownStore, preparations: preparationStore, tasks: taskStore });
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, (await context.params).id);
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, (await context.params).id);
}
