import { NextResponse } from 'next/server';
import { z } from 'zod';
import { preparationAdapter, preparationStore, reviewStore, taskStore, breakdownStore, draftFlowStore } from '../../../../../adapters/runtime';
import { modeLabel } from '../../../../../domain/preparation';
import { DraftFlowError } from '../../../../../domain/draft-flow';

export const runtime = 'nodejs';
const feedbackSchema = z.object({ content: z.string().trim().min(1).max(20_000) });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!taskStore.get(id)) return NextResponse.json({ error: 'タスクが見つかりません。' }, { status: 404 });
  try {
    const feedback = feedbackSchema.parse(await request.json());
    breakdownStore.syncArtifacts(id, preparationStore);
    const artifact = await draftFlowStore.reviseDraft(id, feedback.content, taskStore, preparationAdapter);
    return NextResponse.json({ artifact: publicArtifact(artifact), label: modeLabel(artifact.mode, artifact.fallbackReason) }, { status: 201 });
  } catch (error) {
    if (error instanceof DraftFlowError && error.code === 'DRAFT_JOB_ACTIVE') return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    return NextResponse.json({ error: error instanceof Error && /[\u3040-\u30ff\u4e00-\u9fff]/.test(error.message) ? error.message : '修正指示を確認してください。' }, { status: 422 });
  }
}

function publicArtifact(artifact: ReturnType<typeof preparationStore.listArtifacts>[number]) {
  return {
    id: artifact.id, versionId: artifact.versionId, parentVersionId: artifact.parentVersionId,
    taskId: artifact.taskId, version: artifact.version, mode: artifact.mode, fallbackReason: artifact.fallbackReason, saveStatus: artifact.saveStatus,
    createdAt: artifact.createdAt, plan: artifact.plan, content: artifact.content, changeSummary: artifact.changeSummary,
    modeLabel: modeLabel(artifact.mode, artifact.fallbackReason),
    rating: reviewStore.rating(artifact.versionId), approval: reviewStore.approval(artifact.versionId),
  };
}
