import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ratingSchema } from '../../../../../adapters/review-store';
import { reviewStore } from '../../../../../adapters/runtime';

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const input = z.object({ rating: ratingSchema }).parse(await request.json());
    reviewStore.rate(id, input.rating);
    return NextResponse.json({ rating: reviewStore.rating(id) });
  } catch {
    return NextResponse.json({ error: '評価を保存できません。' }, { status: 422 });
  }
}
