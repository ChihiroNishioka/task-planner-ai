'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { taskResponseSchema } from '../../../domain/task';

type Task = { id: string; title: string; description: string; originalInput: string; deadline: string | null; status: string; aiStatus: string; category: string; taskType: string; revision: number };

export default function TaskDetail({ params }: { params: Promise<{ id: string }> }) {
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void params.then(({ id }) => fetch(`/api/tasks/${id}`).then(async (response) => {
      if (!response.ok) throw new Error('タスクを読み込めませんでした。');
      return taskResponseSchema.parse(await response.json());
    }).then(({ task: value }) => { if (active) setTask(value); }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'エラーが発生しました。'); }).finally(() => { if (active) setLoading(false); }));
    return () => { active = false; };
  }, [params]);
  return <main className="shell"><header className="topbar"><Link href="/" className="back-link">← タスク一覧</Link><span className="mock-label">モック</span></header>
    {loading ? <p className="state" role="status">読み込み中…</p> : error ? <div className="state error" role="alert">{error}</div> : task ? <article className="detail-card"><p className="eyebrow">タスク詳細</p><h1>{task.title}</h1><p className="detail-label">元の入力</p><p>{task.originalInput || '入力なし'}</p><p className="detail-label">期限</p><p>{task.deadline ?? '期限なし'}</p><p className="detail-label">状態</p><p>{task.status} / AI {task.aiStatus}</p><p className="detail-label">カテゴリ・種別</p><p>{task.category} / {task.taskType}</p><p className="detail-label">版履歴</p><p>ドラフトはまだありません。</p><Link className="primary-button link-button" href={`/tasks/${task.id}/review`}>ドラフトレビュー</Link></article> : null}
  </main>;
}
