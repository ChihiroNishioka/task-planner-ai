import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { taskInputSchema, type TaskInput } from '../../../domain/task';
import { taskStore } from '../../../adapters/runtime';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({ tasks: taskStore.list() });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
    const input: TaskInput = taskInputSchema.parse(body);
    const operationKey = request.headers.get('idempotency-key') ?? undefined;
    return NextResponse.json({ task: taskStore.create(input, operationKey) }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) return NextResponse.json({ error: '入力を確認してください。' }, { status: 422 });
    return NextResponse.json({ error: '要求を処理できませんでした。' }, { status: 400 });
  }
}
