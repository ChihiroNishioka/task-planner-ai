import { z } from 'zod';

export const referenceLimits = { noteBody: 20_000, noteTitle: 200, url: 2048, count: 50, bytes: 2_097_152, body: 50_000, title: 300, timeoutMs: 20_000 };
export const fetchErrors = {
  BLOCKED_URL: '安全上の理由で取得できませんでした。再取得しても直らない場合は、内容をメモに貼り付けてください。',
  DNS_FAILED: 'サイトの場所を確認できませんでした。URLを確認するか、時間をおいて再取得してください。',
  TIMEOUT: '時間内にページを取得できませんでした。時間をおいて再取得してください。',
  NETWORK_ERROR: 'ページに接続できませんでした。時間をおいて再取得してください。',
  HTTP_ERROR: 'ページがエラーを返しました。時間をおいて再取得してください。',
  TOO_MANY_REDIRECTS: '転送が多すぎて取得できませんでした。転送先のURLを直接お試しください。',
  UNSUPPORTED_TYPE: 'HTML またはテキストのページだけ取り込めます。内容はメモに貼り付けて追加できます。',
  TOO_LARGE: 'ページが大きすぎて取り込めません（2MB まで）。必要な部分をメモに貼り付けてください。',
  EMPTY_CONTENT: '本文を読み取れませんでした。内容が必要なら、メモに貼り付けて追加できます。',
  DECODE_FAILED: '本文を読み取れませんでした。内容が必要なら、メモに貼り付けて追加できます。',
  INTERRUPTED: '取得が中断されました。再取得してください。',
  FETCH_DISABLED: 'URLの取得は現在オフになっています。内容はメモに貼り付けて追加できます。',
} as const;
export const referenceUserAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 TaskPlannerAI/1.0';
export const fetchFailureReasonSchema = z.enum(['DNS_NOT_FOUND','DNS_UNAVAILABLE','BLOCKED_ADDRESS','BLOCKED_URL_FORM','HTTP_REFUSED','HTTP_NOT_FOUND','HTTP_SERVER','HTTP_OTHER']);
export type FetchFailureReason = z.infer<typeof fetchFailureReasonSchema>;
export const contentHintSchema = z.enum(['SHORT_BODY','PAYWALL_HINT']);
export type ContentHint = z.infer<typeof contentHintSchema>;
export type FetchErrorCode = keyof typeof fetchErrors;
export const noteInputSchema = z.object({ kind: z.literal('NOTE'), title: z.string().trim().max(200).default(''), body: z.string().trim().min(1).max(20_000) });
export const urlInputSchema = z.object({ kind: z.literal('URL'), url: z.string().trim().min(1).max(2048).refine(value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; } }) });
export const referenceInputSchema = z.discriminatedUnion('kind', [noteInputSchema, urlInputSchema]);
export const noteEditSchema = noteInputSchema.omit({ kind: true }).extend({ revision: z.number().int().positive() });
const base = z.object({ id: z.string(), taskId: z.string(), title: z.string(), body: z.string(), revision: z.number(), createdAt: z.string(), updatedAt: z.string() });
export const referenceSchema = z.discriminatedUnion('kind', [
  base.extend({ kind: z.literal('NOTE') }),
  base.extend({ kind: z.literal('URL'), url: z.string(), finalUrl: z.string().nullable(), fetchStatus: z.enum(['FETCHING', 'SUCCEEDED', 'FAILED']), fetchErrorCode: z.enum(Object.keys(fetchErrors) as [FetchErrorCode, ...FetchErrorCode[]]).nullable(), fetchMode: z.enum(['live', 'fixture']), fetchedAt: z.string().nullable(), contentType: z.string().nullable(), truncated: z.boolean(), fetchFailureReason: fetchFailureReasonSchema.nullable().optional(), contentHint: contentHintSchema.nullable().optional() }),
]);
export type Reference = z.infer<typeof referenceSchema>;
export type ReferenceInput = z.infer<typeof referenceInputSchema>;
export type FetchResult = { ok: true; title: string; body: string; finalUrl: string; contentType: string; truncated: boolean; contentHint?:ContentHint|null } | { ok: false; code: FetchErrorCode; reason?:FetchFailureReason; httpStatus?:number };
export class ReferenceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const failureDetails:Record<FetchFailureReason,{code:FetchErrorCode;message:string}> = {
  DNS_NOT_FOUND:{code:'DNS_FAILED',message:'サイトが見つかりませんでした。URLに誤りがないか確認してください。'},
  DNS_UNAVAILABLE:{code:'DNS_FAILED',message:'サイトの場所を確認できませんでした。時間をおいて再取得してください。'},
  BLOCKED_ADDRESS:{code:'BLOCKED_URL',message:'安全上の理由で取得を止めました。公開されていない宛先の可能性があります。公開サイトでも、サーバーの名前解決の設定で止まることがあります。続く場合は管理者に伝えてください。内容が必要なら、メモに貼り付けて追加できます。'},
  BLOCKED_URL_FORM:{code:'BLOCKED_URL',message:'安全上の理由で取得できない形式のURLです。ポート番号やユーザー名を付けない http / https のURLでお試しください。'},
  HTTP_REFUSED:{code:'HTTP_ERROR',message:'サイトに取得を断られました。時間をおいて再取得するか、内容をメモに貼り付けてください。'},
  HTTP_NOT_FOUND:{code:'HTTP_ERROR',message:'ページが見つかりませんでした。URLを確認してください。'},
  HTTP_SERVER:{code:'HTTP_ERROR',message:'サイト側でエラーが起きています。時間をおいて再取得してください。'},
  HTTP_OTHER:{code:'HTTP_ERROR',message:fetchErrors.HTTP_ERROR},
};
export function fetchErrorMessage(code:FetchErrorCode, reason?:FetchFailureReason|null):string {
  const detail=reason?failureDetails[reason]:undefined;
  return detail?.code===code ? detail.message : fetchErrors[code];
}
export function getReferenceCompleteness(item:Reference):'TRUNCATED'|'PARTIAL'|ContentHint|null {
  if(item.kind!=='URL' || item.fetchStatus==='FETCHING' || !item.body)return null;
  if(item.truncated)return Array.from(item.body).length>=referenceLimits.body ? 'TRUNCATED' : 'PARTIAL';
  return item.contentHint??null;
}
const completenessMessages = {
  TRUNCATED:'一部のみ取り込みました（先頭の5万字まで）。続きが必要なら、必要な部分をメモに貼り付けてください。',
  PARTIAL:'一部のみ取得しました。解析の上限などで本文が欠けています。必要な部分はメモに貼り付けてください。',
  SHORT_BODY:'一部のみ取得の可能性があります（本文が短いページです）。必要な部分はメモに貼り付けてください。',
  PAYWALL_HINT:'一部のみ取得の可能性があります（ログインや有料の続きがあるページかもしれません）。必要な部分はメモに貼り付けてください。',
};
export function getReferenceCompletenessMessage(item:Reference):string|null {
  const kind=getReferenceCompleteness(item);
  return kind?completenessMessages[kind]:null;
}
