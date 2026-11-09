'use client';

import Link from 'next/link';
import Image from 'next/image';
import { ReferencePanel } from './reference-panel';
import { BreakdownEditor } from './breakdown-editor';
import { StatusControl } from './status-control';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { isClosedTaskStatus, taskResponseSchema, type Task } from '../../../domain/task';
import { preparationJobSchema } from '../../../domain/preparation';
import { scheduleRecordSchema } from '../../../domain/scheduling';
import { aiStatusLabel, categoryLabel, fallbackGuidance, inputTypeLabel, jobStatusLabel, statusLabel, taskTypeLabel, userMessage } from '../../../domain/labels';

const inputListSchema = z.object({ inputs: z.array(z.object({ id: z.string(), name: z.string(), type: z.enum(['AUDIO', 'IMAGE', 'PDF']), mode: z.literal('mock'), analysisStatus: z.enum(['NOT_PROCESSED', 'EXTRACTED']).default('NOT_PROCESSED') })) });
const queuedJobSchema = z.object({ job: preparationJobSchema, label: z.string() });
const latestArtifactSchema = z.object({ artifacts: z.array(z.object({
  versionId: z.string(), version: z.number(), source: z.enum(['CREATE', 'REVISE']).nullable().optional(), mode: z.enum(['ai', 'mock', 'mock_fallback']), fallbackReason: z.string().nullable(), modeLabel: z.string(),
  plan: z.object({ steps: z.array(z.string()) }), content: z.string(),
})) });
type LatestArtifact = z.infer<typeof latestArtifactSchema>['artifacts'][number];
const breakdownReadyMessage = '分解ができました。内容を確認して「この分解でドラフトを作る」を押してください。';
const POLL_MS = 2000;
const POLL_LIMIT = 180;
const scheduleResponseSchema = z.object({ schedule: scheduleRecordSchema.nullable(), label: z.literal('モック') });

export default function TaskDetail({ params }: { params: Promise<{ id: string }> }) {
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [inputs, setInputs] = useState<z.infer<typeof inputListSchema>['inputs']>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState('添付を読み込み中…');
  const [jobMessage, setJobMessage] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [deadlineTime, setDeadlineTime] = useState('');
  const [scheduledDeadline, setScheduledDeadline] = useState<string | null>(null);
  const [scheduleMessage, setScheduleMessage] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const [latest, setLatest] = useState<LatestArtifact | null>(null);
  const [breakdownVersionId, setBreakdownVersionId] = useState<string | null>(null);
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
        if (value.aiStatus === 'READY') { const count = await loadLatest(taskId); setJobMessage(count ? `${count}件の成果物があります。` : breakdownReadyMessage); return; }
        if (value.aiStatus === 'CANCELLED') { setJobMessage('タスクの完了・中止により AI 準備を止めました。'); return; }
        if (value.aiStatus === 'FAILED') { setJobMessage('準備ジョブが失敗しました。もう一度依頼してください。'); return; }
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
      const artifactsResponse = await fetch(`/api/tasks/${value.id}/artifacts`);
      if (!artifactsResponse.ok) throw new Error('成果物を読み込めませんでした。');
      const artifactList = latestArtifactSchema.parse(await artifactsResponse.json()).artifacts;
      const artifactCount = artifactList.length;
      const scheduleResponse = await fetch(`/api/tasks/${value.id}/schedule`);
      if (!scheduleResponse.ok) throw new Error('スケジュールを読み込めませんでした。');
      const scheduleData = scheduleResponseSchema.parse(await scheduleResponse.json());
      if (active) {
        setTask(value);
        setLatest(artifactList.at(-1) ?? null);
        setJobMessage(artifactCount ? `${artifactCount}件の成果物があります。` : value.aiStatus === 'READY' ? breakdownReadyMessage : '');
        if (['QUEUED', 'RUNNING'].includes(value.aiStatus)) void waitForGeneration(value.id);
        const deadline = scheduleData.schedule?.deadline;
        setScheduledDeadline(deadline ?? null);
        if (deadline) setDeadlineTime(tokyoDateTimeInput(deadline));
      }
    }).catch((cause: unknown) => { if (active) setError(userMessage(cause, 'タスクを読み込めませんでした。')); }).finally(() => { if (active) setLoading(false); }));
    return () => { active = false; };
  }, [params, waitForGeneration]);
  const loadFiles = useCallback(async (taskId: string) => {
    try {
      const response = await fetch(`/api/tasks/${taskId}/inputs`);
      if (!response.ok) throw new Error('添付を読み込めませんでした。');
      setInputs(inputListSchema.parse(await response.json()).inputs);
      setUploadMessage('');
    } catch { setUploadMessage('添付を読み込めませんでした。再読み込みしてください。'); }
  }, []);
  useEffect(() => {
    if (!task?.id) return;
    const taskId = task.id;
    let cancelled = false;
    async function fetchFiles() {
      try {
        const response = await fetch(`/api/tasks/${taskId}/inputs`);
        if (!response.ok) throw new Error('添付を読み込めませんでした。');
        const data = inputListSchema.parse(await response.json());
        if (!cancelled) { setInputs(data.inputs); setUploadMessage(''); }
      } catch {
        if (!cancelled) setUploadMessage('添付を読み込めませんでした。再読み込みしてください。');
      }
    }
    void fetchFiles();
    return () => { cancelled = true; };
  }, [task?.id]);
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
      setUploadMessage(userMessage(cause, '添付を保存できませんでした。'));
    } finally { setUploading(false); }
  }
  async function prepareTask() {
    if (!task || isClosedTaskStatus(task.status)) return;
    setPreparing(true);
    setJobMessage('');
    try {
      const response = await fetch(`/api/tasks/${task.id}/prepare`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() } });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error('準備ジョブを開始できませんでした。');
      const queued = queuedJobSchema.parse(result);
      setJobMessage(`準備ジョブ ${jobStatusLabel(queued.job.status)}・${queued.label}。ワーカーが処理します。`);
      setTask(current => current ? { ...current, aiStatus: 'QUEUED' } : current);
      setLatest(null);
      void waitForGeneration(task.id);
    } catch (cause) {
      setJobMessage(userMessage(cause, '準備ジョブを開始できませんでした。'));
    } finally { setPreparing(false); }
  }
  async function saveSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!task || isClosedTaskStatus(task.status)) return;
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
      setScheduledDeadline(scheduled?.deadline ?? null);
      setScheduleMessage(scheduled
        ? `通知 ${scheduled.remindAt ?? 'なし'}・準備開始 ${scheduled.startAt}・モック`
        : '期限なしのため準備をすぐに開始する予定です。通知はモックです。');
      setTask(current => current ? { ...current, deadline: deadline ? deadline.slice(0, 10) : null } : current);
    } catch (cause) {
      setScheduleMessage(userMessage(cause, 'スケジュールを保存できませんでした。'));
    } finally { setScheduling(false); }
  }
  return <main className="shell"><header className="topbar"><Link href="/" className="back-link">← タスク一覧</Link><span className="mock-label">モック</span></header>
    {loading ? <p className="state" role="status">読み込み中…</p> : error ? <div className="state error" role="alert">{error}</div> : task ? <article className="detail-card"><p className="eyebrow">タスク詳細</p><h1>{task.title}</h1><p className="detail-label">元の入力</p><p>{task.originalInput || '入力なし'}</p><p className="detail-label">期限</p><p>{task.deadline ?? '期限なし'}</p><p className="detail-label">状態</p><p>{statusLabel(task.status)} / AI {aiStatusLabel(task.aiStatus)}</p><StatusControl key={task.id} task={task} deadline={scheduledDeadline ?? task.deadline} onTask={setTask} /><button className="primary-button" aria-describedby={isClosedTaskStatus(task.status) ? 'closed-task-guidance' : undefined} disabled={preparing || generating || isClosedTaskStatus(task.status)} onClick={() => void prepareTask()}>{preparing ? '準備中…' : generating ? 'AIが分解を作成中…' : latest || breakdownVersionId ? 'AIで分解を作り直す' : 'AI準備を依頼'}</button><p role="status">{jobMessage}</p>{isClosedTaskStatus(task.status) ? <p id="closed-task-guidance">完了・中止のタスクは、AI準備と期限の設定ができません。上の「状態」で未着手か進行中に戻すと使えます。</p> : null}{generating ? <p className="state ai-loading" role="status">AIが分解を作成中…（1〜2分かかることがあります）</p> : null}<BreakdownEditor onLatestVersion={setBreakdownVersionId} taskId={task.id} artifactVersion={latest?.versionId ?? null} disabled={isClosedTaskStatus(task.status)} />{latest ? <AiResult artifact={latest} /> : null}<form className="schedule-form" aria-describedby={isClosedTaskStatus(task.status) ? 'closed-task-guidance closed-schedule-guidance' : undefined} onSubmit={saveSchedule}><label htmlFor="task-deadline-time">締切日時（日本時間）</label>{isClosedTaskStatus(task.status) ? <p id="closed-schedule-guidance">完了・中止のため設定できません。</p> : null}<input id="task-deadline-time" aria-describedby={isClosedTaskStatus(task.status) ? 'closed-task-guidance closed-schedule-guidance' : undefined} disabled={isClosedTaskStatus(task.status) || scheduling} type="datetime-local" value={deadlineTime} onChange={(event) => setDeadlineTime(event.target.value)} /><button className="secondary-button" aria-describedby={isClosedTaskStatus(task.status) ? 'closed-task-guidance closed-schedule-guidance' : undefined} disabled={scheduling || isClosedTaskStatus(task.status)}>{scheduling ? '保存中…' : '期限と通知を設定'}</button><p role="status">{scheduleMessage}</p></form><p className="detail-label">カテゴリ・種別</p><p>{categoryLabel(task.category)} / {taskTypeLabel(task.taskType)}</p><ReferencePanel taskId={task.id}><p>画像・PDF・音声ファイルを添付できます。画像から作成したタスクの読み取り結果は、分解とドラフトの参考に使います。通常の添付は解析未実行です。</p><form onSubmit={addFiles}><label htmlFor="task-files">ファイルを選択</label><input id="task-files" name="files" type="file" accept="image/*,.heic,.heif,application/pdf,audio/*" multiple /><button className="secondary-button" disabled={uploading}>{uploading ? '保存中…' : '添付を保存'}</button></form><p role="status">{uploadMessage}</p>{uploadMessage.startsWith('添付を読み込めません') ? <button type="button" className="secondary-button" onClick={() => void loadFiles(task.id)}>添付を再読み込み</button> : null}{!uploadMessage && !inputs.length ? <p>ファイルはまだありません。</p> : null}<ul>{inputs.map((input) => <li key={input.id}>{input.type === 'IMAGE' ? <><Image unoptimized src={`/api/tasks/${task.id}/inputs/${input.id}/content`} alt={`添付画像: ${input.name}`} width={96} height={96} style={{ objectFit: 'contain', maxWidth: '100%' }} /><span>{inputTypeLabel(input.type)}・{input.name}・{input.analysisStatus === 'EXTRACTED' ? 'AIが読み取り済み' : '解析未実行'}</span></> : <>{inputTypeLabel(input.type)}・{input.name}・解析未実行</>}</li>)}</ul></ReferencePanel><p className="detail-label">版履歴</p><p>{latest ? `最新 v${latest.version}・${latest.modeLabel}` : 'ドラフトはまだありません。'}</p><Link className="primary-button link-button" href={`/tasks/${task.id}/review`}>ドラフトレビュー</Link></article> : null}
  </main>;
}

function AiResult({ artifact }: { artifact: LatestArtifact }) {
  const fallback = artifact.mode !== 'ai';
  return <section className="ai-result" aria-label="AIの準備結果"><p className={fallback ? 'mode-badge mode-fallback' : 'mode-badge mode-ai'} data-mode={artifact.mode}>{artifact.modeLabel}</p>
    {fallback && artifact.mode === 'mock_fallback' ? <p className="fallback-note">実AIが使えなかったため、固定のモック内容を表示しています。{fallbackGuidance(artifact.version, artifact.source)}<span className="reason-code">（理由コード {artifact.fallbackReason ?? '不明'}）</span></p> : null}
    <h2>ドラフト v{artifact.version}</h2><pre className="ai-draft">{artifact.content}</pre></section>;
}

function tokyoDateTimeInput(value: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}
