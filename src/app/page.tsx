'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { taskListResponseSchema } from '../domain/task';

type Task = {
  id: string;
  title: string;
  description: string;
  deadline: string | null;
  status: string;
  aiStatus: string;
  category: string;
};

const filters = ['すべて', '今日', '明日以降', '期限超過', 'AI準備完了', 'AI実行中', '完了'] satisfies readonly string[];

export default function Home() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState('');
  const [deadline, setDeadline] = useState('');
  const [filter, setFilter] = useState<(typeof filters)[number]>('すべて');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [aiReal, setAiReal] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch('/api/services').then(async (response) => {
      if (!response.ok) return;
      const body: unknown = await response.json();
      const services = typeof body === 'object' && body !== null && 'services' in body && Array.isArray(body.services) ? body.services as unknown[] : [];
      const real = services.some((service) => typeof service === 'object' && service !== null && 'name' in service && 'mode' in service && service.name === 'AI' && service.mode === 'cli');
      if (active) setAiReal(real);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  async function loadTasks() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/tasks');
      if (!response.ok) throw new Error('タスクを読み込めませんでした。');
      const data = taskListResponseSchema.parse(await response.json());
      setTasks(data.tasks);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'タスクを読み込めませんでした。');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void fetch('/api/tasks').then(async (response) => {
      if (!response.ok) throw new Error('タスクを読み込めませんでした。');
      return taskListResponseSchema.parse(await response.json());
    }).then((data) => { if (active) setTasks(data.tasks); }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'タスクを読み込めませんでした。');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ title, originalInput: title, deadline: deadline || null }),
      });
      if (!response.ok) throw new Error('タスクを登録できませんでした。');
      setTitle('');
      setDeadline('');
      await loadTasks();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'タスクを登録できませんでした。');
    } finally {
      setBusy(false);
    }
  }

  async function completeTask(id: string) {
    const response = await fetch(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'COMPLETED' }) });
    if (!response.ok) setError('状態を更新できませんでした。');
    await loadTasks();
  }

  const visibleTasks = useMemo(() => tasks.filter((task) => {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    if (filter === '今日') return task.deadline === today && task.status !== 'COMPLETED';
    if (filter === '明日以降') return Boolean(task.deadline && task.deadline > today) && task.status !== 'COMPLETED';
    if (filter === '期限超過') return Boolean(task.deadline && task.deadline < today) && task.status !== 'COMPLETED';
    if (filter === 'AI準備完了') return task.aiStatus === 'READY';
    if (filter === 'AI実行中') return ['QUEUED', 'RUNNING'].includes(task.aiStatus);
    if (filter === '完了') return task.status === 'COMPLETED';
    return task.status !== 'CANCELLED';
  }), [tasks, filter]);

  return <main className="shell">
    <header className="topbar"><div><p className="eyebrow">TASK PLANNER AI</p><h1>タスク</h1></div><Link className="secondary-button" href="/settings">設定</Link></header>
    <p className="mock-banner" role="status">{aiReal ? 'AIはサブスクCLIで生成します（失敗時はモック）。ほかの外部サービスはモックです' : '外部サービスはすべてモックです'}</p>
    <form className="task-form" onSubmit={createTask}>
      <label htmlFor="task-title">新しいタスク</label>
      <textarea id="task-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="やることを入力" rows={2} />
      <div className="form-row"><label htmlFor="deadline">期限</label><input id="deadline" type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></div>
      <button className="primary-button" disabled={busy}>{busy ? '登録中…' : 'タスクを追加'}</button>
    </form>
    <nav className="filter-list" aria-label="タスクの絞り込み">{filters.map((value) => <button key={value} className={filter === value ? 'filter active' : 'filter'} onClick={() => setFilter(value)}>{value}</button>)}</nav>
    {loading ? <p className="state" role="status">読み込み中…</p> : error ? <div className="state error" role="alert"><p>{error}</p><button className="secondary-button" onClick={() => void loadTasks()}>再試行</button></div> : visibleTasks.length === 0 ? <div className="state empty"><h2>タスクはありません</h2><p>上のフォームから追加できます。</p></div> : <section className="task-list" aria-label="タスク一覧">{visibleTasks.map((task) => <article className="task-card" key={task.id}>
      <div className="task-copy"><Link href={`/tasks/${task.id}`} className="task-title">{task.title}</Link><p>{task.deadline ? `期限 ${task.deadline}` : '期限なし'}</p><div className="badges"><span>{statusLabel(task.status)}</span><span>AI {aiStatusLabel(task.aiStatus)}</span><span>同期 モック</span></div></div>
      {task.status !== 'COMPLETED' && <button className="complete-button" onClick={() => void completeTask(task.id)} aria-label={`${task.title}を完了`}>完了</button>}
    </article>)}</section>}
  </main>;
}

const statusLabels: Record<string, string> = { OPEN: '未着手', IN_PROGRESS: '進行中', COMPLETED: '完了', CANCELLED: '中止' };
const aiStatusLabels: Record<string, string> = { NOT_REQUIRED: '準備なし', WAITING_CONFIRMATION: '確認待ち', QUEUED: '待機中', RUNNING: '実行中', READY: '準備完了', FAILED: '失敗', CANCELLED: '中止' };

function statusLabel(status: string): string { return statusLabels[status] ?? status; }
function aiStatusLabel(status: string): string { return aiStatusLabels[status] ?? status; }
