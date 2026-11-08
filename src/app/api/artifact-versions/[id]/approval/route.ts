import { NextResponse } from 'next/server';
import { reviewStore } from '../../../../../adapters/runtime';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    reviewStore.approveFinal(id);
    return NextResponse.json({ approval: reviewStore.approval(id) });
  } catch {
    return NextResponse.json({ error: '保存済みの版を承認できません。' }, { status: 422 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    reviewStore.revokeApproval(id);
    return NextResponse.json({ approval: reviewStore.approval(id) });
  } catch {
    return NextResponse.json({ error: '承認を取り消せません。' }, { status: 422 });
  }
}
