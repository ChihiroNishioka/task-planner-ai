/** 画面に出す状態ラベル。内部のenum値はそのまま保ち、表示だけ日本語にする。 */
const statusLabels: Record<string, string> = { OPEN: '未着手', IN_PROGRESS: '進行中', COMPLETED: '完了', CANCELLED: '中止' };
const aiStatusLabels: Record<string, string> = { NOT_REQUIRED: '準備なし', WAITING_CONFIRMATION: '確認待ち', QUEUED: '待機中', RUNNING: '実行中', READY: '準備完了', FAILED: '失敗', CANCELLED: '中止' };
const jobStatusLabels: Record<string, string> = { QUEUED: '待機中', RUNNING: '実行中', SUCCEEDED: '完了', FAILED: '失敗', CANCELLED: '中止' };
const taskTypeLabels: Record<string, string> = { SOLUTION_DESIGN: '構想・設計', EMAIL_REPLY: 'メール返信', ASSIGNMENT: '課題', GENERAL: '一般' };
const categoryLabels: Record<string, string> = { WORK: '仕事', PERSONAL: '個人', STUDY: '学習' };
const inputTypeLabels: Record<string, string> = { AUDIO: '音声', IMAGE: '画像', PDF: 'PDF資料' };
const ratingLabels: Record<string, string> = { UNRATED: '未評価', GOOD: '良い', BAD: '悪い' };
const approvalLabels: Record<string, string> = { UNAPPROVED: '未承認', APPROVED: '承認済み', REVOKED: '承認取消' };
const saveStatusLabels: Record<string, string> = { MOCK_SAVED: 'ローカル保存済み（モック）' };
const UNKNOWN = '不明';

const pick = (labels: Record<string, string>, value: string) => labels[value] ?? UNKNOWN;

export const statusLabel = (value: string) => pick(statusLabels, value);
export const aiStatusLabel = (value: string) => pick(aiStatusLabels, value);
export const jobStatusLabel = (value: string) => pick(jobStatusLabels, value);
export const taskTypeLabel = (value: string) => pick(taskTypeLabels, value);
export const categoryLabel = (value: string) => pick(categoryLabels, value);
export const inputTypeLabel = (value: string) => pick(inputTypeLabels, value);
export const reviewRatingLabel = (value: string) => pick(ratingLabels, value);
export const reviewApprovalLabel = (value: string) => pick(approvalLabels, value);
export const saveStatusLabel = (value: string) => pick(saveStatusLabels, value);

/** 画面に出してよいのは日本語の文だけ。fetch失敗やzodの英語メッセージは代替文に置き換える。 */
export function userMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && /[぀-ヿ一-鿿]/.test(cause.message) && !cause.message.startsWith('[') ? cause.message : fallback;
}

/** 初版（ワーカー）と修正版（Web）は別プロセスで作るため、モードが違い得ることを事前に伝える。 */
export function revisionModeNotice(webMode: 'cli' | 'mock', workerMode: 'cli' | 'mock' | null): string {
  const first = workerMode === 'cli' ? 'AI生成（失敗時はモック）' : workerMode === 'mock' ? 'モック' : '不明（ワーカー未確認）';
  const revision = webMode === 'cli' ? '修正版はWeb側の設定でAI（サブスクCLI。失敗時はモック）に依頼します。' : '修正版はモックで作成します（AIは使いません）。';
  return `初版はワーカーの設定（${first}）、${revision}`;
}

/** 実AIが使えずモックになった版への次の操作の案内。初版の再生成と、修正指示の再送を区別する。 */
export function fallbackGuidance(version: number): string {
  return version <= 1
    ? 'CLIのログイン状態と設定を確認して「この分解でドラフトを作る」を押してください。'
    : 'この版には修正指示がAIで反映されていません。CLIのログイン状態と設定を確認して、ドラフトレビュー画面から修正指示をもう一度送ってください。';
}
