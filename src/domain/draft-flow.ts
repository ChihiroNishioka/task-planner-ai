import { z } from 'zod';
import { artifactModeSchema } from './preparation';

export const draftCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), breakdownVersionId: z.string().uuid(), requestKey: z.string().min(1).max(128) }).strict(),
  z.object({ action: z.literal('cancel'), jobId: z.string().uuid() }).strict(),
]);
export const draftErrorMessages = {
  NOT_FOUND: '対象が見つかりません。',
  BREAKDOWN_EMPTY: '分解の項目を1件以上保存してからドラフトを作ってください。',
  BREAKDOWN_INVALID: '分解の項目は1〜300字、最大50件にして保存し直してください。',
  BREAKDOWN_CHANGED: '分解が更新されました。最新の分解を確認してからもう一度押してください。',
  BREAKDOWN_BUSY: 'AIが分解を作成中です。完了してからドラフトを作ってください。',
  DRAFT_JOB_ACTIVE: 'ドラフトを作成中です。完了までお待ちください。',
  TASK_NOT_RUNNABLE: '完了・中止したタスクではドラフトを作れません。',
  CONFLICT: 'この操作は別の内容で受け付け済みです。画面を読み込み直してください。',
};
export type DraftErrorCode = keyof typeof draftErrorMessages;
export class DraftFlowError extends Error {
  constructor(readonly code: DraftErrorCode) { super(draftErrorMessages[code]); }
}
export function draftJobMessage(code: string | null): string | null {
  switch (code) {
    case 'BREAKDOWN_CHANGED': return 'ドラフトの作成中に分解が変わったため、結果を保存しませんでした。今の分解でもう一度作ってください。';
    case 'TASK_NOT_RUNNABLE': return '完了・中止されたタスクのため、ドラフトを作りませんでした。';
    case 'TASK_CHANGED': return 'ドラフトの作成中にタスクが変更されたため、結果を保存しませんでした。もう一度作ってください。';
    case 'GENERATION_FAILED': return 'ドラフトを作成できませんでした。もう一度お試しください。';
    case 'WORKER_INTERRUPTED': return 'ドラフトの作成が途中で中断されました。もう一度お試しください。';
    default: return null;
  }
}
export const draftJobSchema = z.object({
  id: z.string(), status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']),
  errorCode: z.string().nullable(), message: z.string().nullable(), breakdownVersionId: z.string(), createdAt: z.string(),
});
export const draftFlowSnapshotSchema = z.object({
  preparationActive: z.boolean(),
  hasRelatedMaterials: z.boolean(),
  breakdown: z.object({ latestVersionId: z.string().nullable(), latestNumber: z.number(), stepCount: z.number(), busy: z.boolean() }),
  draft: z.object({ versionId: z.string(), version: z.number(), createdAt: z.string(), mode: artifactModeSchema, modeLabel: z.string(), basedOnVersionId: z.string().nullable(), basedOnNumber: z.number().nullable(), tracking: z.enum(['TRACKED', 'INFERRED', 'UNKNOWN']) }).nullable(),
  stale: z.boolean(), job: draftJobSchema.nullable(), canCreate: z.boolean(),
  blockReason: z.enum(['NO_BREAKDOWN', 'EMPTY_BREAKDOWN', 'INVALID_BREAKDOWN', 'PREPARING', 'BREAKDOWN_BUSY', 'DRAFT_JOB_ACTIVE', 'TASK_NOT_RUNNABLE']).nullable(),
});
export type DraftJob = z.infer<typeof draftJobSchema>;
export type DraftFlowSnapshot = z.infer<typeof draftFlowSnapshotSchema>;
