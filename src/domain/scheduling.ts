import { z } from 'zod';

export const scheduleInputSchema = z.object({
  deadline: z.string().nullable(),
  now: z.date(),
  estimatedAiMinutes: z.number().int().nonnegative().default(30),
  estimatedHumanMinutes: z.number().int().nonnegative().default(60),
});

export const taskScheduleSchema = z.object({
  deadline: z.string().nullable(),
  remindAt: z.string().datetime({ offset: true }).nullable(),
  prepareBy: z.string().datetime({ offset: true }),
  reviewBy: z.string().datetime({ offset: true }).nullable(),
  startAt: z.string().datetime({ offset: true }),
  immediate: z.boolean(),
  overdue: z.boolean(),
  estimatedAiMinutes: z.number().int().nonnegative(),
  estimatedHumanMinutes: z.number().int().nonnegative(),
});

export const scheduleRecordSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), revision: z.number().int().positive(),
  deadline: z.string().datetime().nullable(), remindAt: z.string().datetime({ offset: true }).nullable(),
  prepareBy: z.string().datetime({ offset: true }), reviewBy: z.string().datetime({ offset: true }).nullable(),
  startAt: z.string().datetime({ offset: true }), immediate: z.boolean(), overdue: z.boolean(),
  estimatedAiMinutes: z.number().int().nonnegative(), estimatedHumanMinutes: z.number().int().nonnegative(),
  status: z.enum(['SCHEDULED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']),
});

export type TaskSchedule = z.infer<typeof taskScheduleSchema>;
export type ScheduleRecord = z.infer<typeof scheduleRecordSchema>;

export function calculateSchedule(rawInput: z.input<typeof scheduleInputSchema>): TaskSchedule {
  const input = scheduleInputSchema.parse(rawInput);
  if (!input.deadline) {
    const immediateAt = input.now.toISOString();
    return taskScheduleSchema.parse({ deadline: null, remindAt: null, prepareBy: immediateAt, reviewBy: null, startAt: immediateAt, immediate: true, overdue: false, estimatedAiMinutes: input.estimatedAiMinutes, estimatedHumanMinutes: input.estimatedHumanMinutes });
  }
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.deadline) || !Number.isFinite(Date.parse(input.deadline))) {
    throw new Error('期限はタイムゾーン付きの日時で指定してください。');
  }
  const deadlineTime = Date.parse(input.deadline);
  const localDate = tokyoDate(new Date(deadlineTime));
  const remindAt = tokyoDateTime(addCalendarDays(localDate, -1), 9, 0);
  const prepareDate = new Date(Date.parse(remindAt) - 30 * 60_000);
  const prepareBy = formatTokyoDateTime(prepareDate);
  const startDate = new Date(prepareDate.getTime() - input.estimatedAiMinutes * 60_000);
  const startAt = formatTokyoDateTime(startDate);
  return taskScheduleSchema.parse({
    deadline: new Date(deadlineTime).toISOString(), remindAt, prepareBy, reviewBy: remindAt,
    startAt, immediate: Date.parse(startAt) <= input.now.getTime(), overdue: deadlineTime < input.now.getTime(),
    estimatedAiMinutes: input.estimatedAiMinutes, estimatedHumanMinutes: input.estimatedHumanMinutes,
  });
}

function tokyoDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

function tokyoDateTime(date: string, hour: number, minute: number): string {
  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`;
}

function formatTokyoDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:00+09:00`;
}
