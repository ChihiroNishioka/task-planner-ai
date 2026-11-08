'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '@astryxdesign/core/Button';
import { ThemeContext } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import { breakdownConflictMessage, breakdownSnapshotSchema, breakdownStepsSchema, breakdownVersionLabel, nextBreakdownTracking, type BreakdownSnapshot, type BreakdownTracking, type BreakdownVersion } from '../../../domain/breakdown';
import { modeLabel } from '../../../domain/preparation';
import styles from './breakdown.module.css';
import { useServices } from '../../use-services';

export function BreakdownEditor({ taskId, artifactVersion, disabled }: { taskId: string; artifactVersion: string | null; disabled: boolean }) {
  const { services, error: serviceError } = useServices();
  const workerLabel = services?.find((service) => service.name === 'AI')?.label;
  const [snapshot, setSnapshot] = useState<BreakdownSnapshot | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [baseVersion, setBaseVersion] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [watchError, setWatchError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState('');
  const [comparison, setComparison] = useState<BreakdownVersion | null>(null);
  const [trackedJob, setTrackedJob] = useState<BreakdownTracking | null>(null);
  const comparisonRef = useRef<HTMLElement | null>(null);
  const editRevision = useRef(0);
  const focusTarget = useRef<string | null>(null);
  const [deleted, setDeleted] = useState<{ index: number; step: string } | null>(null);
  const retry = useRef<{ body: string; key: string } | null>(null);
  const activeJob = snapshot?.jobs.find((job) => job.status === 'QUEUED' || job.status === 'RUNNING');
  const pending = Boolean(activeJob);
  const locked = disabled || busy;
  const adopt = useCallback((data: BreakdownSnapshot) => {
    const latest = data.versions.at(-1);
    setSteps(latest?.steps ?? []); setBaseVersion(latest?.id ?? null); setComparison(null);
    setDirty(false); dirtyRef.current = false; setComment(''); setDeleted(null);
  }, []);
  const hydrate = useCallback((data: BreakdownSnapshot) => {
    adopt(data);
    setTrackedJob(null);
    const active = data.jobs.find((job) => job.status === 'QUEUED' || job.status === 'RUNNING');
    if (active) {
      setSteps(active.inputSteps); setComment(active.comment); setBaseVersion(active.baseVersion);
      setDirty(true); dirtyRef.current = true;
      setTrackedJob({ id: active.id, revision: editRevision.current, preserveInput: false });
    }
  }, [adopt]);
  const read = useCallback(async () => {
    const response = await fetch(`/api/tasks/${taskId}/breakdown`, { cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 401 ? 'ログインし直してください。入力は保持しています。' : '分解を読み込めませんでした。再試行してください。');
    return breakdownSnapshotSchema.parse(await response.json());
  }, [taskId]);
  useEffect(() => {
    let cancelled = false;
    void read().then((data) => {
      if (cancelled) return;
      setSnapshot(data);
      if (!dirtyRef.current) hydrate(data);
      else {
        setTrackedJob(previous => nextBreakdownTracking(data, previous, editRevision.current, true));
        setComparison(data.versions.at(-1) ?? null);
        setNotice('新しい成果物があります。編集中の内容は保持しています。最新の版との比較を確認してください。');
      }
    }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : '分解を読み込めませんでした。再試行してください。'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [read, hydrate, artifactVersion]);
  useEffect(() => {
    if (!trackedJob) return;
    let cancelled = false;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (attempts > 300) { clearInterval(timer); setWatchError('AIの待機時間を超えました。入力は保持しています。最新状態を再取得してください。'); return; }
      void read().then((data) => {
        if (cancelled) return;
        setSnapshot(data);
        setWatchError('');
        const nextTracked = nextBreakdownTracking(data, trackedJob, editRevision.current, dirtyRef.current);
        setTrackedJob(nextTracked);
        const job = data.jobs.find((item) => item.id === trackedJob.id);
        if (job?.status === 'SUCCEEDED') {
          const changed = trackedJob.preserveInput || trackedJob.revision !== editRevision.current || Boolean(nextTracked);
          if (!changed) adopt(data);
          else setComparison(data.versions.at(-1) ?? null);
          const latest = data.versions.find((version) => version.kind === 'ai' && version.parentVersion === job.baseVersion);
          const completion = latest?.mode === 'mock' ? 'モック版を保存しました。モックのため入力内容は変わっていません。'
            : latest?.mode === 'mock_fallback' ? 'AIの再生成に失敗し、モック版に入力項目を保持しました。'
            : 'AIが新しい分解版を作成しました。';
          setNotice(completion + (changed ? '編集中の内容は保持しています。最新の版との比較を確認して、現在の入力を載せ替えてから保存してください。' : ''));
        }
        if (job?.status === 'CANCELLED') {
          setNotice('AIの作り直しを取り消しました。');
        }
        if (job?.status === 'FAILED') {
          setError(`AIの作り直しに失敗しました（${job.errorCode ?? '不明'}）。編集中の内容は保持しています。`);
        }
      }).catch(() => { if (!cancelled) setWatchError('AIの状態を取得できません。入力は保持しています。'); });
    }, 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [trackedJob, read, adopt]);
  useEffect(() => {
    if (comparison) { comparisonRef.current?.focus(); comparisonRef.current?.scrollIntoView({ block: 'nearest' }); }
  }, [comparison]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    const leave = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a');
      if (anchor?.href && anchor.href !== window.location.href && !window.confirm('未保存の分解があります。この画面を離れますか？')) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', prevent);
    document.addEventListener('click', leave, true);
    return () => { window.removeEventListener('beforeunload', prevent); document.removeEventListener('click', leave, true); };
  }, [dirty]);
  useEffect(() => {
    if (focusTarget.current) { document.getElementById(focusTarget.current)?.focus(); focusTarget.current = null; }
  }, [steps]);
  function markEdited() { editRevision.current += 1; setDirty(true); dirtyRef.current = true; }
  function edit(next: string[]) { setSteps(next); markEdited(); setNotice('未保存の変更があります。'); }
  function recover(job: BreakdownSnapshot['jobs'][number]) {
    const label = job.status === 'CANCELLED' ? '取り消した入力' : '失敗した入力';
    if (dirtyRef.current && !window.confirm(`編集中の内容を破棄して${label}を編集に戻しますか？`)) return;
    setSteps(job.inputSteps); setComment(job.comment); setBaseVersion(snapshot?.versions.at(-1)?.id ?? null);
    setDeleted(null); setComparison(null); retry.current = null; markEdited(); setError('');
    setNotice(`${label}を編集に戻しました。最新の版との差分を確認して保存してください。`);
  }
  async function reload() {
    if (dirtyRef.current && !window.confirm('未保存の変更を破棄して最新の分解を読み込みますか？')) return;
    setLoading(true); setError(''); setWatchError('');
    try { const data = await read(); editRevision.current += 1; retry.current = null; setSnapshot(data); hydrate(data); setNotice('最新の分解を読み込みました。'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '分解を読み込めませんでした。再試行してください。'); }
    finally { setLoading(false); }
  }
  async function submit(action: 'save' | 'regenerate' | 'restore' | 'cancel') {
    if (locked || (action === 'regenerate' && pending)) return;
    setError('');
    if ((action === 'save' || action === 'regenerate') && !breakdownStepsSchema.safeParse(steps).success) { setError('各項目は1〜300字、最大50件で入力してください。'); return; }
    if (action === 'regenerate' && (!comment.trim() || comment.trim().length > 20_000)) { setError('全体コメントを1〜20000字で入力してください。'); return; }
    if (action === 'restore' && dirtyRef.current && !window.confirm('未保存の変更を破棄して、この版を新しい版として復元しますか？')) return;
    if (action === 'cancel' && !activeJob) return;
    const command = action === 'cancel' ? { action, jobId: activeJob?.id } : action === 'restore' ? { action, baseVersion, sourceVersion: selected } : action === 'regenerate' ? { action, baseVersion, steps, comment } : { action, baseVersion, steps };
    const body = JSON.stringify(command);
    const key = retry.current?.body === body ? retry.current.key : crypto.randomUUID();
    retry.current = { body, key }; setBusy(true);
    if (action === 'save' || action === 'restore') editRevision.current += 1;
    try {
      const response = await fetch(`/api/tasks/${taskId}/breakdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...command, requestKey: key }) });
      if (response.status === 409) {
        const failure = z.object({ code: z.string().optional() }).parse(await response.json());
        setError(breakdownConflictMessage(failure.code, action, undefined).message);
        setComparison(null);
        const latest = await read();
        const job = action === 'cancel' ? latest.jobs.find(item => item.id === command.jobId) : undefined;
        const explanation = breakdownConflictMessage(failure.code, action, job?.status);
        setError(explanation.message);
        setSnapshot(latest); setWatchError('');
        setComparison(explanation.compare ? latest.versions.at(-1) ?? null : null);
        setTrackedJob(previous => nextBreakdownTracking(latest, previous, editRevision.current, dirtyRef.current));
        return;
      }
      if (!response.ok) throw new Error(response.status === 401 ? 'ログインし直してください。入力は保持しています。' : '保存できませんでした。入力を確認して再試行してください。');
      const data = breakdownSnapshotSchema.parse(await response.json());
      setSnapshot(data); retry.current = null;
      if (action === 'cancel') {
        setTrackedJob(previous => nextBreakdownTracking(data, previous, editRevision.current, dirtyRef.current));
        setWatchError('');
        setNotice('AIの作り直しを取り消しました。');
      }
      else if (action === 'regenerate') { setTrackedJob(nextBreakdownTracking(data, null, editRevision.current, false)); setNotice('AIの作り直しを受け付けました。ワーカーの処理を待っています。'); }
      else { adopt(data); setSelected(''); setNotice(action === 'restore' ? '新しい復元版を保存しました。' : 'ユーザー編集版を保存しました。'); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '処理に失敗しました。入力は保持しています。'); }
    finally { setBusy(false); }
  }
  function move(index: number, offset: number) {
    const next = [...steps]; const item = next[index]; const other = next[index + offset];
    if (item === undefined || other === undefined) return;
    focusTarget.current = `breakdown-step-${index + offset}`;
    next[index] = other; next[index + offset] = item; edit(next);
    setNotice(`項目${index + 1}を項目${index + offset + 1}へ移動しました。未保存です。`);
  }
  function remove(index: number) {
    const step = steps[index]; if (step === undefined) return;
    setDeleted({ index, step });
    focusTarget.current = steps.length > 1 ? `breakdown-step-${Math.min(index, steps.length - 2)}` : 'breakdown-add';
    edit(steps.filter((_, i) => i !== index)); setNotice(`項目${index + 1}を削除しました。取り消せます。未保存です。`);
  }
  function undoDelete() {
    if (!deleted) return;
    const index = Math.min(deleted.index, steps.length);
    focusTarget.current = `breakdown-step-${index}`;
    edit([...steps.slice(0, index), deleted.step, ...steps.slice(index)]); setDeleted(null);
    setNotice(`削除した項目を項目${index + 1}へ戻しました。未保存です。`);
  }
  const failedJobs = snapshot?.jobs.filter((job) => job.status === 'FAILED') ?? [];
  const cancelledJobs = snapshot?.jobs.filter((job) => job.status === 'CANCELLED') ?? [];
  const history = snapshot?.versions.find((version) => version.id === selected);
  const current = snapshot?.versions.find((version) => version.id === baseVersion);
  return <ThemeContext.Provider value={{ theme: neutralTheme, mode: 'light' }}><section data-astryx-theme="neutral" data-theme="light" className={styles.editor} aria-label="分解編集" aria-busy={busy || loading}>
    <div className={styles.heading}><h2>タスク分解</h2><span className={styles.badge}>{dirty ? '編集中・未保存' : current ? breakdownVersionLabel(current) : '分解はまだありません'}</span></div>
    <p className={styles.hint}>手順を直して保存できます。上下ボタンで順番を変更できます。</p>
    {loading ? <p role="status">分解を読み込み中…</p> : <>
      {steps.length === 0 ? <p>項目はありません。「項目を追加」から作成できます。</p> : null}
      <ol className={`${styles.list} ai-steps`}>{steps.map((step, index) => <li key={index} className={styles.step}>
        <label htmlFor={`breakdown-step-${index}`}>項目 {index + 1}</label>
        <textarea id={`breakdown-step-${index}`} rows={2} maxLength={300} value={step} disabled={locked} onChange={(event) => edit(steps.map((value, i) => i === index ? event.target.value : value))} />
        <div className={styles.actions}>
          <Button label={`項目${index + 1}を上へ`} isDisabled={locked || index === 0} onClick={() => move(index, -1)} />
          <Button label={`項目${index + 1}を下へ`} isDisabled={locked || index === steps.length - 1} onClick={() => move(index, 1)} />
          <Button label={`項目${index + 1}を削除`} variant="ghost" isDisabled={locked} onClick={() => remove(index)} />
        </div>
      </li>)}</ol>
      <div className={styles.actions}><Button id="breakdown-add" label="項目を追加" isDisabled={locked || steps.length >= 50} onClick={() => { focusTarget.current = `breakdown-step-${steps.length}`; edit([...steps, '']); }} /><Button label={busy ? '保存中…' : 'ユーザー編集版を保存'} variant="primary" isDisabled={locked || !dirty} onClick={() => void submit('save')} /></div>
      {deleted ? <Button label="削除を取り消す" isDisabled={locked} onClick={undoDelete} /> : null}
      {current?.mode === 'mock_fallback' ? <p className={styles.warning} data-mode="mock_fallback">{modeLabel(current.mode, current.fallbackReason)}。実AIでは再生成せず、入力項目を保持しています。理由コード {current.fallbackReason}</p> : null}
      <div className={styles.comment}><label htmlFor="breakdown-comment">全体コメント</label><textarea id="breakdown-comment" rows={3} maxLength={20000} value={comment} disabled={locked} onChange={(event) => { setComment(event.target.value); markEdited(); }} placeholder="どのように手順を直したいですか" /><p className={styles.hint}>未保存の現在のリストとこのコメントをAIに渡します。</p><p className={styles.hint}>AIワーカー {workerLabel ?? (serviceError ? '状態を確認できません' : '確認中…')}</p><Button label="このコメントでAIに作り直してもらう" variant="primary" isDisabled={locked || pending || !comment.trim()} onClick={() => void submit('regenerate')} /></div>
      {pending ? <><p role="status">AIが分解を作成中… ワーカーの処理を待っています。</p><Button label="AIの作り直しを取り消す" isDisabled={locked} onClick={() => void submit('cancel')} /></> : null}
      {pending || snapshot?.jobs.some((job) => job.status === 'CANCELLED') ? <p className={styles.hint}>取消は生成結果の保存を止めます。実行中のCLIプロセスは強制停止せず、完了後の結果を破棄します。</p> : null}
      {comparison ? <section ref={comparisonRef} tabIndex={-1} className={styles.history} aria-label="最新の分解との比較">
        <h3>最新の分解との比較</h3>
        <p>{breakdownVersionLabel(comparison)}</p>
        <p>上の項目と全体コメントは現在の入力です。以下の最新の版を確認し、基準版だけを載せ替えてから保存してください。</p>
        <ol>{comparison.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
        {comparison.comment ? <p>最新の全体コメント {comparison.comment}</p> : null}
        <Button label="現在の入力を最新の版に載せ替える" isDisabled={locked} onClick={() => {
          setBaseVersion(comparison.id); setComparison(null); retry.current = null; markEdited(); setError('');
          setNotice(`現在の入力をv${comparison.number}に載せ替えました。内容を確認してユーザー編集版を保存してください。`);
        }} />
      </section> : null}
      {failedJobs.length ? <details className={styles.history}><summary>失敗した再生成の入力（{failedJobs.length}件）</summary>{failedJobs.map((job, index) => <div key={job.id}>
        <p>失敗入力{index + 1}・{job.errorCode}・{job.createdAt}</p>
        <ol>{job.inputSteps.map((step, i) => <li key={i}>{step}</li>)}</ol><p>全体コメント {job.comment}</p>
        <Button label={`失敗入力${index + 1}を編集に戻す`} isDisabled={locked} onClick={() => recover(job)} />
      </div>)}</details> : null}
      {cancelledJobs.length ? <details className={styles.history}><summary>取り消した再生成の入力（{cancelledJobs.length}件）</summary>{cancelledJobs.map((job, index) => <div key={job.id}>
        <p>取消入力{index + 1}・{job.createdAt}</p>
        <ol>{job.inputSteps.map((step, i) => <li key={i}>{step}</li>)}</ol><p>全体コメント {job.comment}</p>
        <Button label={`取消入力${index + 1}を編集に戻す`} isDisabled={locked} onClick={() => recover(job)} />
      </div>)}</details> : null}
      {disabled ? <p>完了・中止したタスクの分解は変更できません。</p> : null}
      <details className={styles.history} open={Boolean(selected)}><summary>分解の版履歴（{snapshot?.versions.length ?? 0}件）</summary>
        {!snapshot?.versions.length ? <p>履歴はまだありません。</p> : <><label htmlFor="breakdown-history">表示する分解版</label><select id="breakdown-history" value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">版を選択</option>{snapshot.versions.map((version) => <option key={version.id} value={version.id}>{breakdownVersionLabel(version)}</option>)}</select></>}
        {history ? <div aria-label="過去の分解"><p>{breakdownVersionLabel(history)}</p>{history.steps.length ? <ol>{history.steps.map((step, i) => <li key={i}>{step}</li>)}</ol> : <p>項目はありません。</p>}{history.comment ? <p>全体コメント {history.comment}</p> : null}<Button label="この版を復元" isDisabled={locked} onClick={() => void submit('restore')} /></div> : null}
      </details>
    </>}
    <p role="status">{notice}</p>
    {error || watchError ? <p className={styles.warning} role="alert" data-app-error="true">{error}{watchError}</p> : null}
    <Button label={loading ? '読み込み中…' : '最新の版を読み込む'} isDisabled={loading || busy} onClick={() => void reload()} />
  </section></ThemeContext.Provider>;
}
