'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '@astryxdesign/core/Button';
import { ThemeContext } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { useServices } from '../../use-services';
import { draftFlowSnapshotSchema as snapshotSchema, type DraftFlowSnapshot as Snapshot } from '../../../domain/draft-flow';
import styles from './draft-flow.module.css';

const reasons: Record<string, string> = {
  NO_BREAKDOWN: '先に「AI準備を依頼」で分解を作るか、項目を追加して保存してください。',
  EMPTY_BREAKDOWN: '分解の項目を1件以上保存するとドラフトを作れます。',
  INVALID_BREAKDOWN: '分解の項目は1〜300字、最大50件にして保存し直してください。',
  PREPARING: 'AIが分解を作成しています。完了後にドラフトを作れます。',
  BREAKDOWN_BUSY: 'AIが分解を作り直しています。完了後にドラフトを作れます。',
  TASK_NOT_RUNNABLE: '完了・中止したタスクではドラフトを作れません。',
};

type Props = { taskId: string; dirty?: boolean; disabled?: boolean; savedVersionId?: string | null; onLatestVersion?: (id: string | null) => void; onCreated?: () => Promise<void>; staleOnly?: boolean };

export function DraftFlowPanel({ taskId, dirty = false, disabled = false, savedVersionId, onLatestVersion, onCreated, staleOnly = false }: Props) {
  const reasonId = useId();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [sending, setSending] = useState(false);
  const [completion, setCompletion] = useState('');
  const [pendingDisplay, setPendingDisplay] = useState(false);
  const createRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const retry = useRef<{ versionId: string; key: string } | null>(null);
  const tracked = useRef<string | null>(null);
  const pollingDelay = useRef(5000);
  const focus = useRef<'status' | 'create' | 'restored-status' | null>(null);
  const leaving = useRef(false);
  const stopPolling = useRef<(() => void) | null>(null);
  const mountedTask = useRef<string | null>(null);
  const receivedVersion = useRef<{ taskId: string; versionId: string } | null>(null);
  const latestCallback = useRef(onLatestVersion);
  const createdCallback = useRef(onCreated);
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    latestCallback.current = onLatestVersion;
    createdCallback.current = onCreated;
    dirtyRef.current = dirty;
  }, [onLatestVersion, onCreated, dirty]);
  const { services, error: serviceError } = useServices();
  const workerLabel = services?.find(service => service.name === 'AI')?.label;
  const reloadWithDraft = useCallback((versionId: string) => {
    if (leaving.current) return;
    sessionStorage.setItem(`draft-flow-created:${taskId}`, versionId);
    leaving.current = true;
    focus.current = null;
    stopPolling.current?.();
    window.location.reload();
  }, [taskId]);
  const apply = useCallback((next: Snapshot) => {
    if (leaving.current) return;
    const received = receivedVersion.current;
    receivedVersion.current = null;
    if (received?.taskId === taskId && received.versionId === next.draft?.versionId) {
      setCompletion(`ドラフト v${next.draft.version} を作成しました。`);
      focus.current = 'restored-status';
    }
    setSnapshot(next);
    setReadError('');
    pollingDelay.current = next.preparationActive || next.breakdown.busy || Boolean(next.job && ['QUEUED', 'RUNNING'].includes(next.job.status)) ? 2000 : 5000;
    latestCallback.current?.(next.breakdown.latestVersionId);
    if (next.job && ['QUEUED', 'RUNNING'].includes(next.job.status)) tracked.current = next.job.id;
    if (next.job?.id !== tracked.current || ['QUEUED', 'RUNNING'].includes(next.job.status)) return;
    tracked.current = null;
    if (next.job.status === 'SUCCEEDED' && next.draft) {
      const message = `ドラフト v${next.draft.version} を作成しました。`;
      if (createdCallback.current) {
        if (!staleOnly) { setCompletion(message); focus.current = 'status'; }
        void createdCallback.current().catch(() => {
          if (!leaving.current) setActionError('ドラフトは作成されましたが、表示を更新できませんでした。状態を再取得してください。');
        });
      } else if (dirtyRef.current) {
        setCompletion(`${message}編集中の分解は保持しています。`);
        setPendingDisplay(true);
      } else {
        reloadWithDraft(next.draft.versionId);
      }
    } else if (next.job.status === 'FAILED' || next.job.status === 'CANCELLED') {
      if (next.job.status === 'FAILED') setActionError(next.job.message ?? 'ドラフトを作成できませんでした。もう一度お試しください。');
      focus.current = 'create';
    }
  }, [taskId, reloadWithDraft, staleOnly]);
  const read = useCallback(async () => {
    if (leaving.current) return;
    try {
      const response = await fetch(`/api/tasks/${taskId}/draft`, { cache: 'no-store' });
      if (!response.ok) throw new Error('read');
      apply(snapshotSchema.parse(await response.json()));
    } catch { if (!leaving.current) setReadError('ドラフトの状態を取得できません。'); }
  }, [taskId, apply]);
  useEffect(() => {
    if (mountedTask.current === taskId) return;
    mountedTask.current = taskId;
    leaving.current = false;
    focus.current = null;
    const key = `draft-flow-created:${taskId}`;
    const versionId = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    receivedVersion.current = versionId ? { taskId, versionId } : null;
  }, [taskId]);
  useEffect(() => {
    if (leaving.current) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const stop = () => { active = false; clearTimeout(timer); controller.abort(); };
    stopPolling.current = stop;
    const poll = async () => {
      if (!active || leaving.current || document.visibilityState === 'hidden') return;
      try {
        const response = await fetch(`/api/tasks/${taskId}/draft`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('read');
        const next = snapshotSchema.parse(await response.json());
        if (active && !leaving.current) {
          apply(next);
        }
      } catch { if (active && !leaving.current) setReadError('ドラフトの状態を取得できません。'); }
      finally { if (active && !leaving.current && !document.hidden) timer = setTimeout(() => void poll(), pollingDelay.current); }
    };
    const visibility = () => { clearTimeout(timer); if (document.visibilityState !== 'hidden') void poll(); };
    void poll();
    document.addEventListener('visibilitychange', visibility);
    return () => { stop(); if (stopPolling.current === stop) stopPolling.current = null; document.removeEventListener('visibilitychange', visibility); };
  }, [taskId, apply, snapshot?.preparationActive, snapshot?.breakdown.busy, snapshot?.job?.status, savedVersionId]);
  const waitingForSaved = savedVersionId !== undefined && snapshot?.breakdown.latestVersionId !== savedVersionId;
  const activeJob = Boolean(snapshot?.job && ['QUEUED', 'RUNNING'].includes(snapshot.job.status));
  const blocked = !snapshot || Boolean(readError) || sending || dirty || disabled || waitingForSaved || !snapshot.canCreate;
  useEffect(() => {
    const target = focus.current;
    if (leaving.current) { focus.current = null; return; }
    if (!target) return;
    if (target === 'create' && sending) return;
    focus.current = null;
    if (target === 'create' && !blocked) createRef.current?.focus();
    if (target === 'status') statusRef.current?.focus();
    if (target === 'restored-status') {
      const current = document.activeElement;
      if (current === null || current === document.body || current === document.documentElement) statusRef.current?.focus();
    }
  }, [taskId, snapshot?.draft?.versionId, snapshot?.job?.id, snapshot?.job?.status, blocked, completion, sending]);
  async function submit(action: 'create' | 'cancel') {
    if (leaving.current || sending || !snapshot || (action === 'create' && blocked)) return;
    setSending(true); setActionError(''); setCompletion('');
    try {
      let body: object;
      if (action === 'cancel') body = { action, jobId: snapshot.job?.id };
      else {
        const versionId = snapshot.breakdown.latestVersionId;
        if (!versionId) return;
        if (!retry.current || retry.current.versionId !== versionId) retry.current = { versionId, key: crypto.randomUUID() };
        body = { action, breakdownVersionId: versionId, requestKey: retry.current.key };
      }
      const response = await fetch(`/api/tasks/${taskId}/draft`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result: unknown = await response.json();
      if (leaving.current) return;
      if (!response.ok) {
        const parsed = z.object({ error: z.string().optional() }).safeParse(result);
        if (response.status < 500) retry.current = null;
        throw new Error(parsed.success && parsed.data.error ? parsed.data.error : 'ドラフトの操作を受け付けられませんでした。もう一度お試しください。');
      }
      const next = snapshotSchema.parse(result);
      if (action === 'create') { tracked.current = next.job?.id ?? null; focus.current = 'status'; retry.current = null; }
      else { focus.current = 'create'; setCompletion('ドラフト作成を取り消しました。'); }
      apply(next);
    } catch (cause) { if (!leaving.current) setActionError(cause instanceof Error ? cause.message : 'ドラフトの操作に失敗しました。'); }
    finally { if (!leaving.current) setSending(false); }
  }
  const stale = Boolean(snapshot?.stale && !activeJob);
  const reason = !snapshot || waitingForSaved ? 'ドラフトの状態を確認中…' : disabled ? reasons.TASK_NOT_RUNNABLE : dirty ? '未保存の変更があります。保存するとこの分解でドラフトを作れます。' : activeJob ? 'AIがドラフトを作成中です。1〜2分かかることがあります。作成中に分解を保存すると、作成中のドラフトは使われません。' : reasons[snapshot.blockReason ?? ''] ?? `分解 v${snapshot.breakdown.latestNumber}（${snapshot.breakdown.stepCount}件）をもとに作ります。${snapshot.hasRelatedMaterials ? '関連資料（メモ・URLの本文、添付はファイル名と種類のみ）も使います。' : ''}`;
  if (staleOnly && !stale && !activeJob && !readError && !actionError) return null;
  return <section className={styles.panel} aria-label={staleOnly ? 'ドラフトの分解変更案内' : 'ドラフト作成'}>
    <h2>ドラフト</h2>
    {stale && snapshot?.draft ? <div className={styles.notice}><p><strong>分解が変わっています。ドラフトを作り直しますか？</strong></p><p>ドラフト v{snapshot.draft.version} は分解 v{snapshot.draft.basedOnNumber} をもとにしています。今の分解は v{snapshot.breakdown.latestNumber} です。</p><p>今のドラフトは履歴に残ります。コメントで直した内容は引き継がれません。</p></div> : null}
    {!activeJob && snapshot?.draft?.tracking === 'UNKNOWN' ? <p>このドラフトには元にした分解の記録がありません。</p> : null}
    <Button ref={createRef} label={activeJob || sending ? 'ドラフトを作成中…' : stale ? 'この分解でドラフトを作り直す' : 'この分解でドラフトを作る'} variant="primary" isDisabled={blocked} aria-describedby={reasonId} onClick={() => void submit('create')} />
    <p id={reasonId}>{reason}</p>
    {activeJob ? <><p>AIワーカー {workerLabel ?? (serviceError ? '状態を確認できません' : '確認中…')}</p><Button label="ドラフト作成を取り消す" isDisabled={sending} onClick={() => void submit('cancel')} /></> : null}
    {readError ? <><p role="alert" data-draft-error="true">{readError}</p><Button label="ドラフトの状態を再取得" isDisabled={sending} onClick={() => void read()} /></> : null}
    {actionError ? <p role="alert" data-draft-error="true">{actionError}</p> : snapshot?.job?.status === 'FAILED' ? <p>{snapshot.job.message}</p> : null}
    <p ref={statusRef} tabIndex={-1} role="status" data-draft-status="true">{completion || (activeJob ? 'ドラフト作成を受け付けました。ワーカーの処理を待っています。' : '')}</p>
    {pendingDisplay ? <Button label="ドラフトを表示（ページを再読み込み）" onClick={() => { if (snapshot?.draft && window.confirm('未保存の分解があります。入力を破棄してドラフトを表示しますか？')) reloadWithDraft(snapshot.draft.versionId); }} /> : null}
  </section>;
}

export function DraftStaleNotice({ taskId, onCreated }: { taskId: string; onCreated: () => Promise<void> }) {
  return <ThemeContext.Provider value={{ theme: neutralTheme, mode: 'light' }}><div data-astryx-theme="neutral" data-theme="light"><DraftFlowPanel taskId={taskId} onCreated={onCreated} staleOnly /></div></ThemeContext.Provider>;
}
