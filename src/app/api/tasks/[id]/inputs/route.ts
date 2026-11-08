import { NextResponse } from 'next/server';
import { inputStore } from '../../../../../adapters/runtime';
import type { NewInput } from '../../../../../adapters/input-store';
import { taskStore } from '../../../../../adapters/runtime';

export const runtime = 'nodejs';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!taskStore.get(id)) return NextResponse.json({ error: 'タスクが見つかりません。' }, { status: 404 });
  return NextResponse.json({ inputs: inputStore.list(id).map(publicInput) });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!taskStore.get(id)) return NextResponse.json({ error: 'タスクが見つかりません。' }, { status: 404 });
  try {
    const form = await request.formData();
    const rawFiles = form.getAll('files');
    if (!rawFiles.every((value): value is File => value instanceof File)) {
      return NextResponse.json({ error: '添付ファイルを確認してください。' }, { status: 422 });
    }
    const inputs: NewInput[] = await Promise.all(rawFiles.map(async (file) => ({
      type: file.type.startsWith('image/') ? 'IMAGE' : file.type === 'application/pdf' ? 'PDF' : 'AUDIO',
      mime: file.type,
      name: file.name,
      bytes: Buffer.from(await file.arrayBuffer()),
    })));
    const saved = inputStore.addBatch(id, inputs, request.headers.get('idempotency-key') ?? undefined);
    return NextResponse.json({ inputs: saved.map(publicInput) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '添付ファイルを保存できませんでした。' }, { status: 422 });
  }
}

function publicInput(input: ReturnType<typeof inputStore.list>[number]) {
  return {
    id: input.id, taskId: input.taskId, type: input.type, mime: input.mime, name: input.name,
    createdAt: input.createdAt, order: input.order, mode: input.mode, analysisStatus: input.analysisStatus,
  };
}
