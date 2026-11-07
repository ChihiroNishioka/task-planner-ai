import { NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { taskStore } from '../../../../adapters/runtime';

export const runtime = 'nodejs';
const updateSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
  deadline: z.string().date().nullable().optional(),
});

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const task = taskStore.get(id);
  return task ? NextResponse.json({ task }) : NextResponse.json({ error: 'タスクが見つかりません。' }, { status: 404 });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const input = updateSchema.parse(await request.json());
    const task = input.status
      ? taskStore.updateStatus(id, input.status)
      : input.deadline !== undefined
        ? taskStore.postpone(id, input.deadline)
        : input.title
          ? taskStore.rename(id, input.title)
          : taskStore.get(id);
    return task ? NextResponse.json({ task }) : NextResponse.json({ error: 'タスクが見つかりません。' }, { status: 404 });
  } catch (error) {
    if (error instanceof ZodError) return NextResponse.json({ error: '入力を確認してください。' }, { status: 422 });
    return NextResponse.json({ error: '要求を処理できませんでした。' }, { status: 400 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return taskStore.delete(id)
    ? new Response(null, { status: 204 })
    : NextResponse.json({ error: 'タスクが見つかりません。' }, { status: 404 });
}
