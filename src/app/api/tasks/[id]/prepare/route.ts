import { NextResponse } from 'next/server';
import { aiMode, preparationStore, taskStore } from '../../../../../adapters/runtime';

export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const task = taskStore.get(id);
  if (!task) return NextResponse.json({ error: 'タスクが見つかりません。' }, { status: 404 });
  try {
    const operationKey = request.headers.get('idempotency-key') ?? undefined;
    const job = preparationStore.enqueue(task, operationKey);
    return NextResponse.json({ job, aiMode, label: aiMode === 'cli' ? 'AI生成（失敗時はモック）' : 'モック' }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '準備を開始できません。' }, { status: 409 });
  }
}
