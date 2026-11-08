import { NextResponse } from 'next/server';
import { preparationStore, reviewStore, taskStore } from '../../../../../adapters/runtime';
import { modeLabel } from '../../../../../domain/preparation';

export function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => {
    if (!taskStore.get(id)) return NextResponse.json({ error: 'タスクが見つかりません。' }, { status: 404 });
    const artifacts = preparationStore.listArtifacts(id).map((artifact) => ({
      id: artifact.id, taskId: artifact.taskId, version: artifact.version, mode: artifact.mode,
      fallbackReason: artifact.fallbackReason, modeLabel: modeLabel(artifact.mode, artifact.fallbackReason),
      versionId: artifact.versionId, parentVersionId: artifact.parentVersionId,
      saveStatus: artifact.saveStatus, createdAt: artifact.createdAt, plan: artifact.plan,
      content: artifact.content, changeSummary: artifact.changeSummary,
      rating: reviewStore.rating(artifact.versionId), approval: reviewStore.approval(artifact.versionId),
    }));
    return NextResponse.json({ artifacts, feedbackHistory: preparationStore.feedbackHistory(id), label: 'モック' });
  });
}
