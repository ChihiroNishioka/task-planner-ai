import { z } from 'zod';

export const workPlanSchema = z.object({
  objective: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  requiredInputs: z.array(z.string()),
  humanCheckpoints: z.array(z.string()),
  assumptions: z.array(z.string()),
});

export const artifactModeSchema = z.enum(['ai', 'mock', 'mock_fallback']);
export const fallbackReasonSchema = z.enum(['CLI_NOT_FOUND', 'CLI_EXIT', 'CLI_TIMEOUT', 'INVALID_OUTPUT']);

export const generationSchema = z.object({
  plan: workPlanSchema,
  markdown: z.string().min(1),
  changeSummary: z.string().min(1),
  meta: z.object({ mode: artifactModeSchema, fallbackReason: fallbackReasonSchema.nullable() }).optional(),
});

const fallbackReasonLabels: Record<z.infer<typeof fallbackReasonSchema>, string> = {
  CLI_NOT_FOUND: 'AIのCLIが見つかりません',
  CLI_EXIT: 'AIのCLIがエラーで終了しました',
  CLI_TIMEOUT: 'AIの応答が時間内に返りませんでした',
  INVALID_OUTPUT: 'AIの出力形式が不正でした',
};

export function modeLabel(mode: ArtifactMode, reason: string | null): string {
  if (mode === 'ai') return 'AI生成';
  if (mode === 'mock') return 'モック';
  const parsed = fallbackReasonSchema.safeParse(reason);
  return `モック（AI失敗: ${parsed.success ? fallbackReasonLabels[parsed.data] : '理由不明'}）`;
}

export const preparationJobSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']),
  mode: z.literal('mock'), createdAt: z.string().datetime(), updatedAt: z.string().datetime(), errorCode: z.string().nullable(),
});

export type ArtifactMode = z.infer<typeof artifactModeSchema>;
export type FallbackReason = z.infer<typeof fallbackReasonSchema>;
export type WorkPlan = z.infer<typeof workPlanSchema>;
export type Generation = z.infer<typeof generationSchema>;
export type PreparationJob = z.infer<typeof preparationJobSchema>;
