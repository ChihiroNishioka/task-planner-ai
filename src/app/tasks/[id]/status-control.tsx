'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Button } from '@astryxdesign/core/Button';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { ThemeContext } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import { isClosedTaskStatus, scheduleEffectSchema, taskResponseSchema, taskStatusSchema, type Task } from '../../../domain/task';
import { statusChangeMessage, statusLabel } from '../../../domain/labels';
import styles from './status-control.module.css';

const successSchema = taskResponseSchema.extend({ changed: z.boolean(), scheduleEffect: scheduleEffectSchema, label: z.literal('モック') });
const conflictSchema = taskResponseSchema.extend({ code: z.literal('STATUS_CONFLICT'), error: z.string() });
const missingSchema = z.object({ code: z.literal('NOT_FOUND'), error: z.string() });
const genericError = '状態を変更できませんでした。もう一度お試しください。';
type FocusTarget = 'button' | 'message' | 'error';

export function StatusControl({ task, deadline, onTask }: { task: Task; deadline: string | null; onTask: (task: Task) => void }) {
  const [selection, setSelection] = useState({ baseline: task.status, chosen: task.status });
  const selected = selection.baseline === task.status ? selection.chosen : task.status;
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [confirmationTime, setConfirmationTime] = useState(0);
  const [notice, setNotice] = useState<{ taskId: string; status: Task['status']; text: string } | null>(null);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) setNotice(current => current?.taskId === task.id && current.status === task.status ? current : null);
    });
    return () => { active = false; };
  }, [task.id, task.status]);
  const [error, setError] = useState('');
  const [focusRequest, setFocusRequest] = useState(0);
  const focusTarget = useRef<FocusTarget>('button');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!focusRequest) return;
    const target = focusTarget.current;
    if (target === 'button') buttonRef.current?.focus();
    else if (target === 'message') messageRef.current?.focus();
    else errorRef.current?.focus();
  }, [focusRequest]);
  function focus(target: FocusTarget) {
    focusTarget.current = target;
    setFocusRequest(value => value + 1);
  }
  const terminal = isClosedTaskStatus(task.status);
  const reopening = terminal && (selected === 'OPEN' || selected === 'IN_PROGRESS');
  async function save() {
    if (busy || missing || selected === task.status) return;
    setBusy(true); setNotice(null); setError('');
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: selected, expectedStatus: task.status }),
      });
      const raw: unknown = await response.json();
      if (response.status === 409) {
        const conflict = conflictSchema.parse(raw);
        onTask(conflict.task);
        setSelection({ baseline: conflict.task.status, chosen: conflict.task.status });
        setError(conflict.error); focus('error');
      } else if (response.status === 404) {
        missingSchema.parse(raw);
        setMissing(true); setError('タスクが見つかりません。削除された可能性があります。「タスク一覧」に戻ってください。'); focus('error');
      } else {
        if (!response.ok) throw new Error(genericError);
        const result = successSchema.parse(raw);
        onTask(result.task);
        setSelection({ baseline: result.task.status, chosen: result.task.status });
        setNotice({ taskId: result.task.id, status: result.task.status, text: statusChangeMessage(result.task.status, result.scheduleEffect, result.task.deadline) });
        focus('message');
      }
    } catch {
      setError(genericError); focus('error');
    } finally { setBusy(false); setConfirm(false); }
  }
  function cancelDialog(open: boolean) {
    if (busy) return;
    setConfirm(open);
    if (!open) focus('button');
  }
  const deadlinePassed = deadline !== null && new Date(deadline.length === 10 ? `${deadline}T23:59:59+09:00` : deadline).getTime() <= confirmationTime;
  const description = `${task.status === 'COMPLETED' ? '完了日時が消えます。' : ''}${deadline ? deadlinePassed ? '締切を過ぎているため、通知は届きません。' : '締切前の通知が残っていれば、今から届くようにします（通知はモックです）。' : task.status === 'CANCELLED' ? 'タスクを再開します。' : ''}`;
  return <ThemeContext.Provider value={{ theme: neutralTheme, mode: 'light' }}>
    <section className={styles.control} data-astryx-theme="neutral" data-theme="light" aria-label="状態の変更" aria-busy={busy}>
      <SegmentedControl label="タスクの状態" layout="fill" value={selected} isDisabled={busy || missing} onChange={value => setSelection({ baseline: task.status, chosen: taskStatusSchema.parse(value) })}>
        {taskStatusSchema.options.map(value => <SegmentedControlItem key={value} value={value} label={statusLabel(value)} />)}
      </SegmentedControl>
      <div className={styles.actions}><Button ref={buttonRef} className={styles.submit} label={busy ? '変更中…' : '状態を変更'} variant="primary" isDisabled={busy || missing || selected === task.status} onClick={() => { if (reopening) { setConfirmationTime(Date.now()); setConfirm(true); } else void save(); }} /></div>
      {selected !== task.status ? <p>「状態を変更」を押すと保存されます。</p> : null}
      {task.status === 'COMPLETED' && task.completedAt ? <div><p className="detail-label">完了日時</p><time dateTime={task.completedAt}>{tokyoCompletionTime(task.completedAt)}</time></div> : null}
      {notice?.taskId === task.id && notice.status === task.status ? <p ref={messageRef} tabIndex={-1} className={styles.feedback} data-testid="status-message" role="status">{notice.text}</p> : null}
      {error ? <p ref={errorRef} tabIndex={-1} className={`${styles.feedback} ${styles.error}`} data-testid="status-error" role="alert">{error}</p> : null}
      <AlertDialog className={styles.dialog} isOpen={confirm} onOpenChange={cancelDialog} title={`${statusLabel(selected)}に戻しますか？`} description={description} actionLabel={`${statusLabel(selected)}に戻す`} cancelLabel="やめる" actionVariant="primary" isActionLoading={busy} onAction={() => void save()} />
    </section>
  </ThemeContext.Provider>;
}

function tokyoCompletionTime(value: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}
