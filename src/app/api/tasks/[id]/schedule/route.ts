import { NextResponse } from 'next/server';
import { scheduleInputSchema, calculateSchedule } from '../../../../../domain/scheduling';
import { scheduleStore, taskStore } from '../../../../../adapters/runtime';

export const runtime = 'nodejs';
const requestSchema = scheduleInputSchema.omit({ now: true });

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!taskStore.get(id)) return NextResponse.json({ error: 'タスクが見つかりません。' }, { status: 404 });
  return NextResponse.json({ schedule: scheduleStore.current(id), label: 'モック' });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!taskStore.get(id)) return NextResponse.json({ error: 'タスクが見つかりません。' }, { status: 404 });
  let raw: unknown;
  try {
    raw = await request.json();
    const input = requestSchema.parse(raw);
    const schedule = calculateSchedule({ ...input, now: new Date() });
    const date = input.deadline ? tokyoDate(input.deadline) : null;
    taskStore.postpone(id, date);
    const record = scheduleStore.schedule(id, schedule);
    return NextResponse.json({ schedule: record, label: 'モック' }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'スケジュールを確認してください。' }, { status: 422 });
  }
}

function tokyoDate(value: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
