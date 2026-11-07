'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

const artifactSchema = z.object({
  id: z.string(), versionId: z.string(), parentVersionId: z.string().nullable(), taskId: z.string(), version: z.number(),
  mode: z.literal('mock'), saveStatus: z.literal('MOCK_SAVED'), createdAt: z.string(),
  plan: z.object({ objective: z.string(), steps: z.array(z.string()), requiredInputs: z.array(z.string()), humanCheckpoints: z.array(z.string()), assumptions: z.array(z.string()) }),
  content: z.string(), changeSummary: z.string(), rating: z.enum(['UNRATED', 'GOOD', 'BAD']), approval: z.enum(['UNAPPROVED', 'APPROVED', 'REVOKED']),
});
const responseSchema = z.object({
  artifacts: z.array(artifactSchema),
  feedbackHistory: z.array(z.object({ sourceVersionId: z.string(), content: z.string(), appliedToVersionId: z.string().nullable(), createdAt: z.string() })),
  label: z.literal('モック'),
});
type Artifact = z.infer<typeof artifactSchema>;
type ReviewData = z.infer<typeof responseSchema>;

export default function Review({ params }: { params: Promise<{ id: string }> }) {
  const [data, setData] = useState<ReviewData>({ artifacts: [], feedbackHistory: [], label: 'モック' });
  const [taskId, setTaskId] = useState('');
  const [feedback, setFeedback] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async (id: string) => {
    const response = await fetch(`/api/tasks/${id}/artifacts`);
    if (!response.ok) throw new Error('版を読み込めませんでした。');
    setData(responseSchema.parse(await response.json()));
  }, []);

  useEffect(() => {
    let active = true;
    void params.then(async ({ id }) => {
      const response = await fetch(`/api/tasks/${id}/artifacts`);
      if (!response.ok) throw new Error('版を読み込めませんでした。');
      const result = responseSchema.parse(await response.json());
      if (active) { setTaskId(id); setData(result); }
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : '版を読み込めませんでした。'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [params]);

  async function revise(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/tasks/${taskId}/feedback`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: feedback }),
      });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error('修正指示を保存できませんでした。');
      artifactSchema.parse(z.object({ artifact: z.unknown() }).parse(result).artifact);
      setFeedback('');
      await load(taskId);
      setMessage('新しいモック版を保存しました。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '修正できませんでした。');
    } finally { setBusy(false); }
  }

  async function reviewVersion(versionId: string, action: 'GOOD' | 'BAD' | 'APPROVED' | 'REVOKED') {
    setBusy(true);
    setError('');
    try {
      const approval = action === 'APPROVED' || action === 'REVOKED';
      const response = await fetch(`/api/artifact-versions/${versionId}/${approval ? 'approval' : 'rating'}`, {
        method: approval ? action === 'REVOKED' ? 'DELETE' : 'POST' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: approval ? undefined : JSON.stringify({ rating: action }),
      });
      if (!response.ok) throw new Error('評価または承認を保存できませんでした。');
      await load(taskId);
      setMessage('レビュー状態を保存しました。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'レビュー状態を保存できませんでした。');
    } finally { setBusy(false); }
  }

  const current = data.artifacts.at(-1);
  return <main className="shell"><header className="topbar"><Link href={taskId ? `/tasks/${taskId}` : '/'} className="back-link">← タスク詳細</Link><span className="mock-label">モック</span></header><section className="detail-card"><p className="eyebrow">ドラフト比較</p><h1>成果物レビュー</h1>
    {loading ? <p className="state" role="status">読み込み中…</p> : error && data.artifacts.length === 0 ? <div className="state error" role="alert">{error}</div> : !current ? <div className="state empty"><h2>ドラフトはありません</h2><p>タスク詳細からモックAI準備を依頼できます。</p></div> : <>
      <p>保存状態 MOCK_SAVED・サービス モック</p>
      <div className="version-grid">{data.artifacts.map((artifact) => <VersionCard key={artifact.versionId} artifact={artifact} busy={busy} onAction={reviewVersion} />)}</div>
      <section className="plan-section"><h2>作業計画</h2><p>{current.plan.objective}</p><ol>{current.plan.steps.map((step) => <li key={step}>{step}</li>)}</ol><p>人の確認: {current.plan.humanCheckpoints.join('、')}</p></section>
      <form className="feedback-form" onSubmit={(event) => void revise(event)}><label htmlFor="feedback">修正指示</label><textarea id="feedback" rows={3} value={feedback} onChange={(event) => setFeedback(event.target.value)} maxLength={20_000} required /><button className="primary-button" disabled={busy}>{busy ? '保存中…' : '修正版を作る（モック）'}</button></form>
      <section className="feedback-history"><h2>修正履歴</h2>{data.feedbackHistory.length === 0 ? <p>履歴はありません。</p> : <ul>{data.feedbackHistory.map((entry) => <li key={`${entry.sourceVersionId}-${entry.createdAt}`}>v{data.artifacts.find((item) => item.versionId === entry.sourceVersionId)?.version} → v{data.artifacts.find((item) => item.versionId === entry.appliedToVersionId)?.version}: {entry.content}</li>)}</ul>}</section>
    </>}
    {error && data.artifacts.length > 0 && <p className="error" role="alert">{error}</p>}<p role="status">{message}</p>
  </section></main>;
}

function VersionCard({ artifact, busy, onAction }: { artifact: Artifact; busy: boolean; onAction: (versionId: string, action: 'GOOD' | 'BAD' | 'APPROVED' | 'REVOKED') => Promise<void> }) {
  return <article className="version-card"><h2>v{artifact.version}</h2><p>{artifact.changeSummary}</p><pre>{artifact.content}</pre><p>評価 {artifact.rating}・最終版 {artifact.approval}</p><div className="review-actions"><button className="secondary-button" disabled={busy} onClick={() => void onAction(artifact.versionId, 'GOOD')}>Good</button><button className="secondary-button" disabled={busy} onClick={() => void onAction(artifact.versionId, 'BAD')}>Bad</button>{artifact.approval === 'APPROVED' ? <button className="secondary-button" disabled={busy} onClick={() => void onAction(artifact.versionId, 'REVOKED')}>承認を取消</button> : <button className="secondary-button" disabled={busy} onClick={() => void onAction(artifact.versionId, 'APPROVED')}>最終版として承認</button>}</div></article>;
}
