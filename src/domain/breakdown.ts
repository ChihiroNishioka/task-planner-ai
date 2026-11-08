import { z } from 'zod';
import { artifactModeSchema, fallbackReasonSchema, modeLabel } from './preparation';

export const storedBreakdownStepsSchema = z.array(z.string().min(1));
export const breakdownStepsSchema = z.array(z.string().trim().min(1).max(300)).max(50);
const base = { baseVersion: z.string().uuid().nullable(), requestKey: z.string().min(1).max(128) };
export const breakdownCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('save'), steps: breakdownStepsSchema }).strict(),
  z.object({ ...base, action: z.literal('regenerate'), steps: breakdownStepsSchema, comment: z.string().trim().min(1).max(20_000) }).strict(),
  z.object({ ...base, action: z.literal('restore'), sourceVersion: z.string().uuid() }).strict(),
]);
export const breakdownVersionSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), number: z.number().int().positive(), parentVersion: z.string().uuid().nullable(),
  kind: z.enum(['user', 'ai', 'restore', 'import']), steps: storedBreakdownStepsSchema,
  mode: artifactModeSchema.nullable(), fallbackReason: fallbackReasonSchema.nullable(),
  label: z.string().default(''), comment: z.string(), sourceVersion: z.string().uuid().nullable(), createdAt: z.string(),
});
export const breakdownJobSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']),
  inputSteps: breakdownStepsSchema, comment: z.string(), errorCode: z.string().nullable(), baseVersion: z.string().uuid().nullable(), createdAt: z.string(),
});
export const breakdownSnapshotSchema = z.object({ versions: z.array(breakdownVersionSchema), jobs: z.array(breakdownJobSchema) });
export type BreakdownCommand = z.infer<typeof breakdownCommandSchema>;
export type BreakdownVersion = z.infer<typeof breakdownVersionSchema>;
export type BreakdownSnapshot = z.infer<typeof breakdownSnapshotSchema>;
export class BreakdownError extends Error {
  constructor(readonly code: 'CONFLICT' | 'NOT_FOUND' | 'TASK_NOT_RUNNABLE') { super(code); }
}

export const breakdownGenerationSchema = z.object({ steps: breakdownStepsSchema, mode: artifactModeSchema, fallbackReason: fallbackReasonSchema.nullable() });
export type BreakdownGeneration = z.infer<typeof breakdownGenerationSchema>;

export function breakdownVersionLabel(version: BreakdownVersion): string {
  const kinds = { user: 'ユーザー編集', ai: '作り直し', restore: '復元', import: '成果物から取込' };
  return `分解 v${version.number}・${kinds[version.kind]}${version.mode ? `・${modeLabel(version.mode, version.fallbackReason)}` : ''}`;
}
