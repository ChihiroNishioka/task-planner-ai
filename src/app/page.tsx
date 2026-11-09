'use client';

import Link from 'next/link';
import { z } from 'zod';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { isClosedTaskStatus, taskListResponseSchema, type Task } from '../domain/task';
import { useServices } from './use-services';
import { aiStatusLabel, statusLabel, userMessage } from '../domain/labels';

function bannerText(ai: { mode: string; label: string } | null, error: string): string {
  if (error) return `${error}AIの実行モードを確認できません。AI以外の連携はモックです`;
  if (!ai) return 'AIの実行モードを確認中…';
  if (ai.mode === 'cli') return 'AIはサブスクCLIで生成します（失敗時はモック）。AI以外の連携はモックです';
  if (ai.mode === 'mock') return 'AIもAI以外の連携もモックです';
  return `${ai.label}。AI以外の連携はモックです`;
}

const filters = ['すべて', '今日', '明日以降', '期限超過', 'AI準備完了', 'AI実行中', '完了', '中止'] satisfies readonly string[];

export default function Home() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState('');
  const [deadline, setDeadline] = useState('');
  const [filter, setFilter] = useState<(typeof filters)[number]>('すべて');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionErrorRequest, setActionErrorRequest] = useState(0);
  const actionErrorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (actionErrorRequest) {
      actionErrorRef.current?.focus();
      actionErrorRef.current?.scrollIntoView({ block: 'center' });
    }
  }, [actionErrorRequest]);
  const [busy, setBusy] = useState(false);
  const { services, error: servicesError, reload: reloadServices } = useServices();
  const ai = services?.find((service) => service.name === 'AI') ?? null;

  async function loadTasks() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/tasks');
      if (!response.ok) throw new Error('タスクを読み込めませんでした。');
      const data = taskListResponseSchema.parse(await response.json());
      setTasks(data.tasks);
    } catch (cause) {
      setError(userMessage(cause, 'タスクを読み込めませんでした。'));
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
      if (active) setError(userMessage(cause, 'タスクを読み込めませんでした。'));
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
      setError(userMessage(cause, 'タスクを登録できませんでした。'));
    } finally {
      setBusy(false);
    }
  }

  async function completeTask(task: Task) {
    setActionError('');
    let failure = '';
    try {
      const response = await fetch(`/api/tasks/${task.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'COMPLETED', expectedStatus: task.status }) });
      if (!response.ok) {
        const result: unknown = await response.json();
        const parsed = z.object({ error: z.string() }).safeParse(result);
        failure = parsed.success ? parsed.data.error : '状態を更新できませんでした。';
      }
    } catch { failure = '状態を更新できませんでした。'; }
    await loadTasks();
    if (failure) {
      setActionError(failure);
      setActionErrorRequest(value => value + 1);
    }
  }

  const visibleTasks = useMemo(() => tasks.filter((task) => {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    if (filter === '今日') return task.deadline === today && !isClosedTaskStatus(task.status);
    if (filter === '明日以降') return Boolean(task.deadline && task.deadline > today) && !isClosedTaskStatus(task.status);
    if (filter === '期限超過') return Boolean(task.deadline && task.deadline < today) && !isClosedTaskStatus(task.status);
    if (filter === 'AI準備完了') return task.aiStatus === 'READY';
    if (filter === 'AI実行中') return ['QUEUED', 'RUNNING'].includes(task.aiStatus);
    if (filter === '完了') return task.status === 'COMPLETED';
    if (filter === '中止') return task.status === 'CANCELLED';
    return task.status !== 'CANCELLED';
  }), [tasks, filter]);

  return <main className="shell">
    <header className="topbar"><div><p className="eyebrow">TASK PLANNER AI</p><h1>タスク</h1></div><Link className="secondary-button" href="/settings">設定</Link></header>
    <p className="mock-banner" role="status">{bannerText(ai, servicesError)}{servicesError ? <button type="button" className="secondary-button" onClick={reloadServices}>状態を再取得</button> : null}</p>
    <form className="task-form" onSubmit={createTask}>
      <label htmlFor="task-title">新しいタスク</label>
      <textarea id="task-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="やることを入力" rows={2} />
      <div className="form-row"><label htmlFor="deadline">期限</label><input id="deadline" type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></div>
      <button className="primary-button" disabled={busy}>{busy ? '登録中…' : 'タスクを追加'}</button>
    </form>
    <nav className="filter-list" aria-label="タスクの絞り込み">{filters.map((value) => <button key={value} className={filter === value ? 'filter active' : 'filter'} onClick={() => setFilter(value)}>{value}</button>)}</nav>
    {actionError ? <p ref={actionErrorRef} tabIndex={-1} className="state error" data-testid="task-action-error" role="alert">{actionError}</p> : null}
    {loading ? <p className="state" role="status">読み込み中…</p> : error ? <div className="state error" role="alert"><p>{error}</p><button className="secondary-button" onClick={() => void loadTasks()}>再試行</button></div> : visibleTasks.length === 0 ? <div className="state empty"><h2>タスクはありません</h2><p>上のフォームから追加できます。</p></div> : <section className="task-list" aria-label="タスク一覧">{visibleTasks.map((task) => <article className="task-card" key={task.id}>
      <div className="task-copy"><Link href={`/tasks/${task.id}`} className="task-title">{task.title}</Link><p>{task.deadline ? `期限 ${task.deadline}` : '期限なし'}</p><div className="badges"><span>{statusLabel(task.status)}</span><span>AI {aiStatusLabel(task.aiStatus)}</span><span>同期 モック</span></div></div>
      {!isClosedTaskStatus(task.status) && <button className="complete-button" onClick={() => void completeTask(task)} aria-label={`${task.title}を完了`}>完了</button>}
    </article>)}</section>}
  </main>;
}
