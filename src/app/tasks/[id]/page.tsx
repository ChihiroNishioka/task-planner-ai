'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { taskResponseSchema } from '../../../domain/task';
import { preparationJobSchema } from '../../../domain/preparation';
import { scheduleRecordSchema } from '../../../domain/scheduling';

type Task = { id: string; title: string; description: string; originalInput: string; deadline: string | null; status: string; aiStatus: string; category: string; taskType: string; revision: number };
const inputListSchema = z.object({ inputs: z.array(z.object({ id: z.string(), name: z.string(), type: z.enum(['AUDIO', 'IMAGE', 'PDF']), mode: z.literal('mock') })) });
const queuedJobSchema = z.object({ job: preparationJobSchema, label: z.string() });
const latestArtifactSchema = z.object({ artifacts: z.array(z.object({
  versionId: z.string(), version: z.number(), mode: z.enum(['ai', 'mock', 'mock_fallback']), fallbackReason: z.string().nullable(), modeLabel: z.string(),
  plan: z.object({ steps: z.array(z.string()) }), content: z.string(),
})) });
type LatestArtifact = z.infer<typeof latestArtifactSchema>['artifacts'][number];
const POLL_MS = 2000;
const POLL_LIMIT = 180;
const scheduleResponseSchema = z.object({ schedule: scheduleRecordSchema.nullable(), label: z.literal('モック') });

export default function TaskDetail({ params }: { params: Promise<{ id: string }> }) {
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [inputs, setInputs] = useState<z.infer<typeof inputListSchema>['inputs']>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState('');
  const [jobMessage, setJobMessage] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [deadlineTime, setDeadlineTime] = useState('');
  const [scheduleMessage, setScheduleMessage] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const [latest, setLatest] = useState<LatestArtifact | null>(null);
  const [generating, setGenerating] = useState(false);
  const loadLatest = useCallback(async (taskId: string) => {
    const response = await fetch(`/api/tasks/${taskId}/artifacts`);
    if (!response.ok) throw new Error('成果物を読み込めませんでした。');
    const artifacts = latestArtifactSchema.parse(await response.json()).artifacts;
    setLatest(artifacts.at(-1) ?? null);
    return artifacts.length;
  }, []);
  const waitForGeneration = useCallback(async (taskId: string) => {
    setGenerating(true);
    try {
      for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const response = await fetch(`/api/tasks/${taskId}`);
        if (!response.ok) continue;
        const { task: value } = taskResponseSchema.parse(await response.json());
        setTask((current) => current ? { ...current, aiStatus: value.aiStatus } : current);
        if (value.aiStatus === 'READY') { const count = await loadLatest(taskId); setJobMessage(`${count}件の成果物があります。`); return; }
        if (value.aiStatus === 'FAILED' || value.aiStatus === 'CANCELLED') { setJobMessage('準備ジョブが失敗しました。もう一度依頼してください。'); return; }
      }
      setJobMessage('まだ作成中です。しばらくしてから再読み込みしてください。');
    } catch {
      setJobMessage('状態を確認できませんでした。再読み込みしてください。');
    } finally { setGenerating(false); }
  }, [loadLatest]);
  useEffect(() => {
    let active = true;
    void params.then(({ id }) => fetch(`/api/tasks/${id}`).then(async (response) => {
      if (!response.ok) throw new Error('タスクを読み込めませんでした。');
      return taskResponseSchema.parse(await response.json());
    }).then(async ({ task: value }) => {
      const response = await fetch(`/api/tasks/${value.id}/inputs`);
      if (!response.ok) throw new Error('添付を読み込めませんでした。');
      const data = inputListSchema.parse(await response.json());
      const artifactsResponse = await fetch(`/api/tasks/${value.id}/artifacts`);
      if (!artifactsResponse.ok) throw new Error('成果物を読み込めませんでした。');
      const artifactList = latestArtifactSchema.parse(await artifactsResponse.json()).artifacts;
      const artifactCount = artifactList.length;
      const scheduleResponse = await fetch(`/api/tasks/${value.id}/schedule`);
      if (!scheduleResponse.ok) throw new Error('スケジュールを読み込めませんでした。');
      const scheduleData = scheduleResponseSchema.parse(await scheduleResponse.json());
      if (active) {
        setTask(value);
        setInputs(data.inputs);
        setLatest(artifactList.at(-1) ?? null);
        setJobMessage(artifactCount ? `${artifactCount}件の成果物があります。` : '');
        if (['QUEUED', 'RUNNING'].includes(value.aiStatus)) void waitForGeneration(value.id);
        const deadline = scheduleData.schedule?.deadline;
        if (deadline) setDeadlineTime(tokyoDateTimeInput(deadline));
      }
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'エラーが発生しました。'); }).finally(() => { if (active) setLoading(false); }));
    return () => { active = false; };
  }, [params, waitForGeneration]);
  async function addFiles(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const { id } = await params;
    const data = new FormData(form);
    setUploading(true);
    setUploadMessage('');
    try {
      const response = await fetch(`/api/tasks/${id}/inputs`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: data });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error('添付を確認してください。');
      const saved = inputListSchema.parse(result);
      setInputs((current) => [...current, ...saved.inputs]);
      setUploadMessage('添付をモック領域へ保存しました。解析は未実行です。');
      form.reset();
    } catch (cause) {
      setUploadMessage(cause instanceof Error ? cause.message : '添付を保存できませんでした。');
    } finally { setUploading(false); }
  }
  async function prepareTask() {
    if (!task) return;
    setPreparing(true);
    setJobMessage('');
    try {
      const response = await fetch(`/api/tasks/${task.id}/prepare`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() } });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error('準備ジョブを開始できませんでした。');
      const queued = queuedJobSchema.parse(result);
      setJobMessage(`準備ジョブ ${queued.job.status}・${queued.label}。ワーカーが処理します。`);
      setTask({ ...task, aiStatus: 'QUEUED' });
      setLatest(null);
      void waitForGeneration(task.id);
    } catch (cause) {
      setJobMessage(cause instanceof Error ? cause.message : '準備ジョブを開始できませんでした。');
    } finally { setPreparing(false); }
  }
  async function saveSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!task) return;
    setScheduling(true);
    setScheduleMessage('');
    try {
      const deadline = deadlineTime ? `${deadlineTime}:00+09:00` : null;
      const response = await fetch(`/api/tasks/${task.id}/schedule`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deadline, estimatedAiMinutes: 30, estimatedHumanMinutes: 60 }),
      });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error('期限の日時を確認してください。');
      const scheduled = scheduleResponseSchema.parse(result).schedule;
      setScheduleMessage(scheduled
        ? `通知 ${scheduled.remindAt ?? 'なし'}・準備開始 ${scheduled.startAt}・モック`
        : '期限なしのため準備をすぐに開始する予定です。通知はモックです。');
      setTask({ ...task, deadline: deadline ? deadline.slice(0, 10) : null });
    } catch (cause) {
      setScheduleMessage(cause instanceof Error ? cause.message : 'スケジュールを保存できませんでした。');
    } finally { setScheduling(false); }
  }
  return <main className="shell"><header className="topbar"><Link href="/" className="back-link">← タスク一覧</Link><span className="mock-label">モック</span></header>
    {loading ? <p className="state" role="status">読み込み中…</p> : error ? <div className="state error" role="alert">{error}</div> : task ? <article className="detail-card"><p className="eyebrow">タスク詳細</p><h1>{task.title}</h1><p className="detail-label">元の入力</p><p>{task.originalInput || '入力なし'}</p><p className="detail-label">期限</p><p>{task.deadline ?? '期限なし'}</p><p className="detail-label">状態</p><p>{task.status} / AI {task.aiStatus}</p><button className="primary-button" disabled={preparing || generating} onClick={() => void prepareTask()}>{preparing ? '準備中…' : generating ? 'AIが作成中…' : latest ? 'AIでもう一度作る' : 'AI準備を依頼'}</button><p role="status">{jobMessage}</p>{generating ? <p className="state ai-loading" role="status">AIが作成中…（タスク分解とドラフト。1〜2分かかることがあります）</p> : null}{latest ? <AiResult artifact={latest} /> : null}<form className="schedule-form" onSubmit={saveSchedule}><label htmlFor="task-deadline-time">締切日時（日本時間）</label><input id="task-deadline-time" type="datetime-local" value={deadlineTime} onChange={(event) => setDeadlineTime(event.target.value)} /><button className="secondary-button" disabled={scheduling}>{scheduling ? '保存中…' : '期限と通知を設定'}</button><p role="status">{scheduleMessage}</p></form><p className="detail-label">カテゴリ・種別</p><p>{task.category} / {task.taskType}</p><section className="input-section"><h2>関連資料</h2><p>画像・PDF・音声ファイルを添付できます。解析はモックのため行いません。</p><form onSubmit={addFiles}><label htmlFor="task-files">ファイルを選択</label><input id="task-files" name="files" type="file" accept="image/*,application/pdf,audio/*" multiple /><button className="secondary-button" disabled={uploading}>{uploading ? '保存中…' : '添付を保存'}</button></form><p role="status">{uploadMessage}</p><ul>{inputs.map((input) => <li key={input.id}>{input.type}・{input.name}・モック</li>)}</ul></section><p className="detail-label">版履歴</p><p>{latest ? `最新 v${latest.version}・${latest.modeLabel}` : 'ドラフトはまだありません。'}</p><Link className="primary-button link-button" href={`/tasks/${task.id}/review`}>ドラフトレビュー</Link></article> : null}
  </main>;
}

function AiResult({ artifact }: { artifact: LatestArtifact }) {
  const fallback = artifact.mode !== 'ai';
  return <section className="ai-result" aria-label="AIの準備結果"><p className={fallback ? 'mode-badge mode-fallback' : 'mode-badge mode-ai'} data-mode={artifact.mode}>{artifact.modeLabel}</p>
    {fallback && artifact.mode === 'mock_fallback' ? <p className="fallback-note">実AIが使えなかったため、固定のモック内容を表示しています。CLIのログイン状態と設定を確認して「AIでもう一度作る」を押してください。<span className="reason-code">（理由コード {artifact.fallbackReason ?? '不明'}）</span></p> : null}
    <h2>タスク分解</h2><ol className="ai-steps">{artifact.plan.steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol>
    <h2>ドラフト v{artifact.version}</h2><pre className="ai-draft">{artifact.content}</pre></section>;
}

function tokyoDateTimeInput(value: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}
