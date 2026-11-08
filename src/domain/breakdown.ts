import { z } from 'zod';
import { artifactModeSchema, fallbackReasonSchema, modeLabel } from './preparation';

export const storedBreakdownStepsSchema = z.array(z.string().min(1));
export const breakdownStepsSchema = z.array(z.string().trim().min(1).max(300)).max(50);
const base = { baseVersion: z.string().uuid().nullable(), requestKey: z.string().min(1).max(128) };
export const breakdownCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('save'), steps: breakdownStepsSchema }).strict(),
  z.object({ ...base, action: z.literal('regenerate'), steps: breakdownStepsSchema, comment: z.string().trim().min(1).max(20_000) }).strict(),
  z.object({ ...base, action: z.literal('restore'), sourceVersion: z.string().uuid() }).strict(),
  z.object({ action: z.literal('cancel'), jobId: z.string().uuid(), requestKey: base.requestKey }).strict(),
]);
export const breakdownVersionSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), number: z.number().int().positive(), parentVersion: z.string().uuid().nullable(),
  kind: z.enum(['user', 'ai', 'restore', 'import']), steps: storedBreakdownStepsSchema,
  mode: artifactModeSchema.nullable(), fallbackReason: fallbackReasonSchema.nullable(),
  label: z.string().default(''), comment: z.string(), sourceVersion: z.string().uuid().nullable(), createdAt: z.string(),
});
export const breakdownJobSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']),
  inputSteps: breakdownStepsSchema, comment: z.string(), errorCode: z.string().nullable(), baseVersion: z.string().uuid().nullable(), createdAt: z.string(),
});
export const breakdownSnapshotSchema = z.object({ versions: z.array(breakdownVersionSchema), jobs: z.array(breakdownJobSchema) });
export type BreakdownCommand = z.infer<typeof breakdownCommandSchema>;
export type BreakdownVersion = z.infer<typeof breakdownVersionSchema>;
export type BreakdownSnapshot = z.infer<typeof breakdownSnapshotSchema>;
export type BreakdownTracking = { id: string; revision: number; preserveInput: boolean };

export function nextBreakdownTracking(data: BreakdownSnapshot, previous: BreakdownTracking | null, revision: number, dirty: boolean): BreakdownTracking | null {
  const active = data.jobs.find(job => job.status === 'QUEUED' || job.status === 'RUNNING');
  if (!active) return null;
  return active.id === previous?.id ? previous : { id: active.id, revision, preserveInput: dirty };
}

export function breakdownConflictMessage(code: string | undefined, action: BreakdownCommand['action'], status: BreakdownSnapshot['jobs'][number]['status'] | undefined): { message: string; compare: boolean } {
  if (code === 'TASK_NOT_RUNNABLE') return { compare: false, message: '完了・中止したタスクは変更できません。入力は保持しています。タスクの状態を確認してください。' };
  if (action === 'cancel') {
    const reason = status === 'SUCCEEDED' ? 'この作り直しは成功済みのため取り消せません。' : status === 'FAILED' ? 'この作り直しは失敗済みのため取り消せません。' : '作り直しの状態が変わったため取り消せませんでした。';
    return { compare: false, message: `${reason}入力は保持しています。最新のジョブ状態を確認してください。` };
  }
  if (code === 'CONFLICT' && (action === 'save' || action === 'restore')) return { compare: true, message: '別の変更があります。入力は保持しています。最新の版と比較し、載せ替えてから保存してください。' };
  return { compare: false, message: '作り直しの受付状態またはタスクの状態が変わりました。入力は保持しています。最新の状態を確認してから再操作してください。' };
}

export class BreakdownError extends Error {
  constructor(readonly code: 'CONFLICT' | 'NOT_FOUND' | 'TASK_NOT_RUNNABLE') { super(code); }
}

export const breakdownGenerationSchema = z.object({ steps: breakdownStepsSchema, mode: artifactModeSchema, fallbackReason: fallbackReasonSchema.nullable() });
export type BreakdownGeneration = z.infer<typeof breakdownGenerationSchema>;

export function breakdownVersionLabel(version: BreakdownVersion): string {
  const kinds = { user: 'ユーザー編集', ai: '作り直し', restore: '復元', import: '成果物から取込' };
  return `分解 v${version.number}・${kinds[version.kind]}${version.mode ? `・${modeLabel(version.mode, version.fallbackReason)}` : ''}`;
}
