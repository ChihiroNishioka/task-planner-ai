import { NextResponse } from 'next/server';
import { reviewStore } from '../../../../adapters/runtime';

export function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get('query') ?? '';
  const category = url.searchParams.get('category') ?? '';
  try {
    return NextResponse.json({ results: reviewStore.searchGood(query, category), mode: 'mock', label: 'モック' });
  } catch {
    return NextResponse.json({ error: '検索条件を確認してください。' }, { status: 422 });
  }
}
