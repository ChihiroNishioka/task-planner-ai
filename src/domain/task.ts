import { z } from 'zod';

export const taskStatusSchema = z.enum(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export const isClosedTaskStatus = (status: TaskStatus): boolean => status === 'COMPLETED' || status === 'CANCELLED';
export const scheduleEffectSchema = z.enum(['NONE', 'STOPPED', 'RESCHEDULED', 'NOTIFICATION_RESTORED', 'DEADLINE_PASSED']);
export type ScheduleEffect = z.infer<typeof scheduleEffectSchema>;
export const aiStatusSchema = z.enum(['NOT_REQUIRED', 'WAITING_CONFIRMATION', 'QUEUED', 'RUNNING', 'READY', 'FAILED', 'CANCELLED']);
export const taskTypeSchema = z.enum(['SOLUTION_DESIGN', 'EMAIL_REPLY', 'ASSIGNMENT', 'GENERAL']);
export const taskCategorySchema = z.enum(['WORK', 'PERSONAL', 'STUDY']);

export const taskInputSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().max(20_000).default(''),
  originalInput: z.string().max(20_000).default(''),
  deadline: z.string().date().nullable().default(null),
  category: taskCategorySchema.default('PERSONAL'),
  taskType: taskTypeSchema.default('GENERAL'),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH']).default('NORMAL'),
  aiPreparationRequired: z.boolean().default(false),
});

export type TaskInput = z.infer<typeof taskInputSchema>;

export const taskSchema = taskInputSchema.extend({
  id: z.string().uuid(),
  status: taskStatusSchema,
  aiStatus: aiStatusSchema,
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable().default(null),
  syncStatus: z.literal('PENDING_MOCK'),
});

export const taskResponseSchema = z.object({ task: taskSchema });
export const taskListResponseSchema = z.object({ tasks: z.array(taskSchema) });
export type Task = z.infer<typeof taskSchema>;

export function extractTaskCandidates({ text, now }: { text: string; now: Date }): TaskInput[] {
  return text
    .split(/、|。|\n|あと/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const deadline = relativeDeadline(part, now);
      const title = part
        .replace(/明日(?:までに|まで|締切|が締切)/g, '')
        .replace(/(?:今週)?金曜日?(?:までに|まで|締切|が締切)/g, '')
        .replace(/までに/g, '')
        .replace(/^[、\s]+|[、\s]+$/g, '')
        .trim();
      const taskType = /構想|ソリューション|仕組み/.test(title)
        ? 'SOLUTION_DESIGN'
        : /返信|返事/.test(title)
          ? 'EMAIL_REPLY'
          : /課題|宿題/.test(title)
            ? 'ASSIGNMENT'
            : 'GENERAL';
      return taskInputSchema.parse({ title: title || part, deadline, taskType, originalInput: part });
    });
}

function relativeDeadline(text: string, now: Date): string | null {
  const tokyoOffset = 9 * 60 * 60 * 1000;
  const tokyoNow = new Date(now.getTime() + tokyoOffset);
  const year = tokyoNow.getUTCFullYear();
  const month = tokyoNow.getUTCMonth();
  const day = tokyoNow.getUTCDate();
  if (/明日/.test(text)) return calendarDay(year, month, day + 1);
  if (/金曜日?|金曜/.test(text)) {
    const weekday = new Date(Date.UTC(year, month, day)).getUTCDay();
    return calendarDay(year, month, day + ((5 - weekday + 7) % 7 || 7));
  }
  return null;
}

function calendarDay(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}
