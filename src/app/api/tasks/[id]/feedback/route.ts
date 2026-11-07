import { NextResponse } from 'next/server';
import { z } from 'zod';
import { mockAiAdapter, preparationStore, taskStore } from '../../../../../adapters/runtime';

export const runtime = 'nodejs';
const feedbackSchema = z.object({ content: z.string().trim().min(1).max(20_000) });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!taskStore.get(id)) return NextResponse.json({ error: 'タスクが見つかりません。' }, { status: 404 });
  try {
    const feedback = feedbackSchema.parse(await request.json());
    const artifact = await preparationStore.revise(id, feedback.content, taskStore, mockAiAdapter);
    return NextResponse.json({ artifact: publicArtifact(artifact), label: 'モック' }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '修正指示を確認してください。' }, { status: 422 });
  }
}

function publicArtifact(artifact: ReturnType<typeof preparationStore.listArtifacts>[number]) {
  return {
    id: artifact.id, versionId: artifact.versionId, parentVersionId: artifact.parentVersionId,
    taskId: artifact.taskId, version: artifact.version, mode: artifact.mode, saveStatus: artifact.saveStatus,
    createdAt: artifact.createdAt, plan: artifact.plan, content: artifact.content, changeSummary: artifact.changeSummary,
  };
}
