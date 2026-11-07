'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { z } from 'zod';
import { taskResponseSchema } from '../../../domain/task';
import { preparationJobSchema } from '../../../domain/preparation';

type Task = { id: string; title: string; description: string; originalInput: string; deadline: string | null; status: string; aiStatus: string; category: string; taskType: string; revision: number };
const inputListSchema = z.object({ inputs: z.array(z.object({ id: z.string(), name: z.string(), type: z.enum(['AUDIO', 'IMAGE', 'PDF']), mode: z.literal('mock') })) });
const queuedJobSchema = z.object({ job: preparationJobSchema, label: z.literal('モック') });

export default function TaskDetail({ params }: { params: Promise<{ id: string }> }) {
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [inputs, setInputs] = useState<z.infer<typeof inputListSchema>['inputs']>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState('');
  const [jobMessage, setJobMessage] = useState('');
  const [preparing, setPreparing] = useState(false);
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
      const artifactsBody: unknown = await artifactsResponse.json();
      const artifactCount = z.object({ artifacts: z.array(z.object({ id: z.string() })) }).parse(artifactsBody).artifacts.length;
      if (active) { setTask(value); setInputs(data.inputs); setJobMessage(artifactCount ? `${artifactCount}件のモック成果物があります。` : ''); }
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'エラーが発生しました。'); }).finally(() => { if (active) setLoading(false); }));
    return () => { active = false; };
  }, [params]);
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
    } catch (cause) {
      setJobMessage(cause instanceof Error ? cause.message : '準備ジョブを開始できませんでした。');
    } finally { setPreparing(false); }
  }
  return <main className="shell"><header className="topbar"><Link href="/" className="back-link">← タスク一覧</Link><span className="mock-label">モック</span></header>
    {loading ? <p className="state" role="status">読み込み中…</p> : error ? <div className="state error" role="alert">{error}</div> : task ? <article className="detail-card"><p className="eyebrow">タスク詳細</p><h1>{task.title}</h1><p className="detail-label">元の入力</p><p>{task.originalInput || '入力なし'}</p><p className="detail-label">期限</p><p>{task.deadline ?? '期限なし'}</p><p className="detail-label">状態</p><p>{task.status} / AI {task.aiStatus}</p><button className="primary-button" disabled={preparing} onClick={() => void prepareTask()}>{preparing ? '準備中…' : 'AI準備を依頼'}</button><p role="status">{jobMessage}</p><p className="detail-label">カテゴリ・種別</p><p>{task.category} / {task.taskType}</p><section className="input-section"><h2>関連資料</h2><p>画像・PDF・音声ファイルを添付できます。解析はモックのため行いません。</p><form onSubmit={addFiles}><label htmlFor="task-files">ファイルを選択</label><input id="task-files" name="files" type="file" accept="image/*,application/pdf,audio/*" multiple /><button className="secondary-button" disabled={uploading}>{uploading ? '保存中…' : '添付を保存'}</button></form><p role="status">{uploadMessage}</p><ul>{inputs.map((input) => <li key={input.id}>{input.type}・{input.name}・モック</li>)}</ul></section><p className="detail-label">版履歴</p><p>{jobMessage.includes('成果物') ? jobMessage : 'ドラフトはまだありません。'}</p><Link className="primary-button link-button" href={`/tasks/${task.id}/review`}>ドラフトレビュー</Link></article> : null}
  </main>;
}
