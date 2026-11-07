'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';

const artifactSchema = z.object({
  id: z.string(), taskId: z.string(), version: z.number(), mode: z.literal('mock'), saveStatus: z.literal('MOCK_SAVED'),
  createdAt: z.string(), plan: z.object({ objective: z.string(), steps: z.array(z.string()), requiredInputs: z.array(z.string()), humanCheckpoints: z.array(z.string()), assumptions: z.array(z.string()) }),
  content: z.string(), changeSummary: z.string(),
});
const responseSchema = z.object({ artifacts: z.array(artifactSchema), label: z.literal('モック') });
type Artifact = z.infer<typeof artifactSchema>;

export default function Review({ params }: { params: Promise<{ id: string }> }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [taskId, setTaskId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void params.then(async ({ id }) => {
      const response = await fetch(`/api/tasks/${id}/artifacts`);
      if (!response.ok) throw new Error('版を読み込めませんでした。');
      const result = responseSchema.parse(await response.json());
      if (active) { setTaskId(id); setArtifacts(result.artifacts); }
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : '版を読み込めませんでした。'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [params]);
  const previous = artifacts.at(-2);
  const current = artifacts.at(-1);
  return <main className="shell"><header className="topbar"><Link href={taskId ? `/tasks/${taskId}` : '/'} className="back-link">← タスク詳細</Link><span className="mock-label">モック</span></header><section className="detail-card"><p className="eyebrow">ドラフト比較</p><h1>成果物レビュー</h1>
    {loading ? <p className="state" role="status">読み込み中…</p> : error ? <div className="state error" role="alert">{error}</div> : !current ? <div className="state empty"><h2>ドラフトはありません</h2><p>タスク詳細からモックAI準備を依頼できます。</p></div> : <><p>保存状態 {current.saveStatus}・モード {current.mode}</p><div className="version-grid"><VersionCard heading={previous ? `v${previous.version}` : '前の版'} content={previous?.content ?? '前の版はありません'} summary={previous?.changeSummary ?? ''} /><VersionCard heading={`v${current.version}`} content={current.content} summary={current.changeSummary} /></div><section><h2>作業計画</h2><p>{current.plan.objective}</p><ol>{current.plan.steps.map((step) => <li key={step}>{step}</li>)}</ol><p>確認点: {current.plan.humanCheckpoints.join('、')}</p></section><p>評価・最終版承認はPhase 5で追加します。</p></>}
  </section></main>;
}

function VersionCard({ heading, content, summary }: { heading: string; content: string; summary: string }) {
  return <article className="version-card"><h2>{heading}</h2>{summary && <p>{summary}</p>}<pre>{content}</pre></article>;
}
