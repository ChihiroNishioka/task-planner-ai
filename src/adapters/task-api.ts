import { z } from 'zod';
import { taskStatusSchema } from '../domain/task';
import { statusLabel } from '../domain/labels';
import { calculateSchedule, scheduleInputSchema } from '../domain/scheduling';
import { TaskStatusError, type TaskStore } from './task-store';
import { TaskNotActiveError, type ScheduleStore } from './scheduling';

const updateSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  status: taskStatusSchema.optional(),
  expectedStatus: taskStatusSchema.optional(),
  deadline: z.string().date().nullable().optional(),
}).refine(input => input.status !== undefined
  ? input.title === undefined && input.deadline === undefined
  : input.expectedStatus === undefined);
const scheduleRequestSchema = scheduleInputSchema.omit({ now: true });
const notFound = () => Response.json({ error: 'タスクが見つかりません。', code: 'NOT_FOUND' }, { status: 404 });

export function taskHandlers({ tasks, schedules }: { tasks: TaskStore; schedules: ScheduleStore }) {
  return {
    GET(_request: Request, id: string): Response {
      const task = tasks.get(id);
      return task ? Response.json({ task }) : notFound();
    },
    async PATCH(request: Request, id: string): Promise<Response> {
      if (!tasks.get(id)) return notFound();
      try {
        const input = updateSchema.parse(await request.json());
        if (input.status !== undefined) {
          const result = tasks.changeStatus(id, input.status, { expectedStatus: input.expectedStatus });
          return result ? Response.json({ ...result, label: 'モック' }) : notFound();
        }
        const task = input.deadline !== undefined ? tasks.postpone(id, input.deadline)
          : input.title ? tasks.rename(id, input.title) : tasks.get(id);
        return task ? Response.json({ task }) : notFound();
      } catch (error) {
        if (error instanceof TaskStatusError) return Response.json({
          error: `別の画面で状態が「${statusLabel(error.task.status)}」に変わりました。内容を確認して、もう一度操作してください。`,
          code: error.code, task: error.task,
        }, { status: 409 });
        if (error instanceof z.ZodError) return Response.json({ error: '入力を確認してください。', code: 'INVALID_INPUT' }, { status: 422 });
        return Response.json({ error: '要求を処理できませんでした。' }, { status: 400 });
      }
    },
    scheduleGET(_request: Request, id: string): Response {
      if (!tasks.get(id)) return notFound();
      return Response.json({ schedule: schedules.current(id), label: 'モック' });
    },
    async schedulePOST(request: Request, id: string): Promise<Response> {
      if (!tasks.get(id)) return notFound();
      try {
        const input = scheduleRequestSchema.parse(await request.json());
        const schedule = calculateSchedule({ ...input, now: new Date() });
        const date = input.deadline ? tokyoDate(input.deadline) : null;
        const record = schedules.scheduleForActiveTask(id, schedule, date);
        return record ? Response.json({ schedule: record, label: 'モック' }, { status: 201 }) : notFound();
      } catch (error) {
        if (error instanceof TaskNotActiveError) return Response.json({
          error: '完了・中止したタスクには期限と通知を設定できません。再開してから設定してください。', code: error.code,
        }, { status: 409 });
        return Response.json({ error: 'スケジュールを確認してください。' }, { status: 422 });
      }
    },
  };
}

function tokyoDate(value: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
