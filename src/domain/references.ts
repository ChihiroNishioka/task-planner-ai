import { z } from 'zod';

export const referenceLimits = { noteBody: 20_000, noteTitle: 200, url: 2048, count: 50, bytes: 2_097_152, body: 50_000, title: 300, timeoutMs: 10_000 };
export const fetchErrors = {
  BLOCKED_URL: '安全上の理由で取得できません', DNS_FAILED: '名前解決に失敗しました',
  TIMEOUT: '取得が時間切れになりました', NETWORK_ERROR: 'ページを取得できませんでした',
  HTTP_ERROR: 'ページがエラーを返しました', TOO_MANY_REDIRECTS: '転送回数が上限を超えました',
  UNSUPPORTED_TYPE: 'HTML またはテキスト以外は取得できません', TOO_LARGE: 'ページが大きすぎます(2MB まで)',
  EMPTY_CONTENT: '本文を読み取れませんでした', DECODE_FAILED: '本文を読み取れませんでした',
  INTERRUPTED: '取得が中断されました', FETCH_DISABLED: 'URL取得は無効に設定されています',
} as const;
export type FetchErrorCode = keyof typeof fetchErrors;
export const noteInputSchema = z.object({ kind: z.literal('NOTE'), title: z.string().trim().max(200).default(''), body: z.string().trim().min(1).max(20_000) });
export const urlInputSchema = z.object({ kind: z.literal('URL'), url: z.string().trim().min(1).max(2048).refine(value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; } }) });
export const referenceInputSchema = z.discriminatedUnion('kind', [noteInputSchema, urlInputSchema]);
export const noteEditSchema = noteInputSchema.omit({ kind: true }).extend({ revision: z.number().int().positive() });
const base = z.object({ id: z.string(), taskId: z.string(), title: z.string(), body: z.string(), revision: z.number(), createdAt: z.string(), updatedAt: z.string() });
export const referenceSchema = z.discriminatedUnion('kind', [
  base.extend({ kind: z.literal('NOTE') }),
  base.extend({ kind: z.literal('URL'), url: z.string(), finalUrl: z.string().nullable(), fetchStatus: z.enum(['FETCHING', 'SUCCEEDED', 'FAILED']), fetchErrorCode: z.enum(Object.keys(fetchErrors) as [FetchErrorCode, ...FetchErrorCode[]]).nullable(), fetchMode: z.enum(['live', 'fixture']), fetchedAt: z.string().nullable(), contentType: z.string().nullable(), truncated: z.boolean() }),
]);
export type Reference = z.infer<typeof referenceSchema>;
export type ReferenceInput = z.infer<typeof referenceInputSchema>;
export type FetchResult = { ok: true; title: string; body: string; finalUrl: string; contentType: string; truncated: boolean } | { ok: false; code: FetchErrorCode };
export class ReferenceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
