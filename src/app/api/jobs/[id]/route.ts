import { NextResponse } from 'next/server';
import { preparationStore } from '../../../../adapters/runtime';
import { modeLabel } from '../../../../domain/preparation';

export function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => {
    const job = preparationStore.getJob(id);
    if (!job) return NextResponse.json({ error: 'ジョブが見つかりません。' }, { status: 404 });
    const artifact = job.status === 'SUCCEEDED' ? preparationStore.listArtifacts(job.taskId).at(-1) : undefined;
    return NextResponse.json({
      job,
      artifactMode: artifact?.mode ?? null,
      fallbackReason: artifact?.fallbackReason ?? null,
      label: artifact ? modeLabel(artifact.mode, artifact.fallbackReason) : 'モック',
    });
  });
}
