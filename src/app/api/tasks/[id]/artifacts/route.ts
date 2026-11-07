import { NextResponse } from 'next/server';
import { preparationStore, taskStore } from '../../../../../adapters/runtime';

export function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => {
    if (!taskStore.get(id)) return NextResponse.json({ error: 'タスクが見つかりません。' }, { status: 404 });
    const artifacts = preparationStore.listArtifacts(id).map((artifact) => ({
      id: artifact.id, taskId: artifact.taskId, version: artifact.version, mode: artifact.mode,
      saveStatus: artifact.saveStatus, createdAt: artifact.createdAt, plan: artifact.plan,
      content: artifact.content, changeSummary: artifact.changeSummary,
    }));
    return NextResponse.json({ artifacts, label: 'モック' });
  });
}
