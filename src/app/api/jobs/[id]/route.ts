import { NextResponse } from 'next/server';
import { preparationStore } from '../../../../adapters/runtime';

export function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => {
    const job = preparationStore.getJob(id);
    return job ? NextResponse.json({ job, label: 'モック' }) : NextResponse.json({ error: 'ジョブが見つかりません。' }, { status: 404 });
  });
}
