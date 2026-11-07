import { NextResponse } from 'next/server';
import { taskStore, scheduleStore } from '../../../adapters/runtime';

export function GET(request: Request) {
  const taskId = new URL(request.url).searchParams.get('taskId');
  if (!taskId || !taskStore.get(taskId)) return NextResponse.json({ error: 'taskIdを確認してください。' }, { status: 422 });
  return NextResponse.json({ notifications: scheduleStore.notifications(taskId), mode: 'mock', label: 'モック' });
}
