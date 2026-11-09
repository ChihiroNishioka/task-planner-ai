import { NextResponse } from 'next/server';
import { taskStore, scheduleStore } from '../../../../adapters/runtime';
import { taskHandlers } from '../../../../adapters/task-api';

export const runtime = 'nodejs';
const handlers = taskHandlers({ tasks: taskStore, schedules: scheduleStore });

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handlers.GET(request, (await context.params).id);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return handlers.PATCH(request, (await context.params).id);
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return taskStore.delete(id)
    ? new Response(null, { status: 204 })
    : NextResponse.json({ error: 'タスクが見つかりません。' }, { status: 404 });
}
