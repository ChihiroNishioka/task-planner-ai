'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { ThemeContext } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import { breakdownSnapshotSchema, breakdownStepsSchema, breakdownVersionLabel, type BreakdownSnapshot } from '../../../domain/breakdown';
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
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState('');
  const ownedJob = useRef<{ id: string; revision: number } | null>(null);
  const editRevision = useRef(0);
  const focusTarget = useRef<string | null>(null);
  const [deleted, setDeleted] = useState<{ index: number; step: string } | null>(null);
  const retry = useRef<{ body: string; key: string } | null>(null);
  const pending = snapshot?.jobs.some((job) => job.status === 'QUEUED' || job.status === 'RUNNING') ?? false;
  const locked = disabled || busy;
  const adopt = useCallback((data: BreakdownSnapshot) => {
    const latest = data.versions.at(-1);
    setSteps(latest?.steps ?? []); setBaseVersion(latest?.id ?? null);
    setDirty(false); dirtyRef.current = false; setComment(''); setDeleted(null);
  }, []);
  const hydrate = useCallback((data: BreakdownSnapshot) => {
    adopt(data);
    const active = data.jobs.find((job) => job.status === 'QUEUED' || job.status === 'RUNNING');
    if (active) {
      setSteps(active.inputSteps); setComment(active.comment); setBaseVersion(active.baseVersion);
      setDirty(true); dirtyRef.current = true;
      ownedJob.current = { id: active.id, revision: editRevision.current };
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
      if (!dirtyRef.current) hydrate(data); else setNotice('新しい成果物があります。編集中の内容は保持しています。');
    }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : '分解を読み込めませんでした。再試行してください。'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [read, hydrate, artifactVersion]);
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (attempts > 300) { clearInterval(timer); setError('AIの待機時間を超えました。入力は保持しています。最新状態を再取得してください。'); return; }
      void read().then((data) => {
        if (cancelled) return;
        setSnapshot(data);
        const owner = ownedJob.current;
        const job = data.jobs.find((item) => item.id === owner?.id);
        if (job?.status === 'SUCCEEDED') {
          const changed = owner?.revision !== editRevision.current;
          if (!changed) adopt(data);
          const latest = data.versions.find((version) => version.kind === 'ai' && version.parentVersion === job.baseVersion);
          const completion = latest?.mode === 'mock' ? 'モック版を保存しました。モックのため入力内容は変わっていません。'
            : latest?.mode === 'mock_fallback' ? 'AIの再生成に失敗し、モック版に入力項目を保持しました。'
            : 'AIが新しい分解版を作成しました。';
          setNotice(completion + (changed ? '編集中の内容は保持しています。最新の版は読み込み操作で確認できます。' : ''));
          ownedJob.current = null;
        }
        if (job?.status === 'FAILED' || (!ownedJob.current && data.jobs.at(-1)?.status === 'FAILED')) {
          setError(`AIの作り直しに失敗しました（${job?.errorCode ?? data.jobs.at(-1)?.errorCode ?? '不明'}）。編集中の内容は保持しています。`); ownedJob.current = null;
        }
      }).catch(() => { if (!cancelled) setError('AIの状態を取得できません。入力は保持しています。'); });
    }, 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [pending, read, adopt]);
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
    if (dirtyRef.current && !window.confirm('編集中の内容を破棄して失敗した入力を編集に戻しますか？')) return;
    setSteps(job.inputSteps); setComment(job.comment); setBaseVersion(snapshot?.versions.at(-1)?.id ?? null);
    setDeleted(null); markEdited(); setError('');
    setNotice('失敗した入力を編集に戻しました。最新の版との差分を確認して保存してください。');
  }
  async function reload() {
    if (dirtyRef.current && !window.confirm('未保存の変更を破棄して最新の分解を読み込みますか？')) return;
    setLoading(true); setError('');
    try { const data = await read(); editRevision.current += 1; ownedJob.current = null; retry.current = null; setSnapshot(data); adopt(data); setNotice('最新の分解を読み込みました。'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '分解を読み込めませんでした。再試行してください。'); }
    finally { setLoading(false); }
  }
  async function submit(action: 'save' | 'regenerate' | 'restore') {
    if (locked || (action === 'regenerate' && pending)) return;
    setError('');
    if (action !== 'restore' && !breakdownStepsSchema.safeParse(steps).success) { setError('各項目は1〜300字、最大50件で入力してください。'); return; }
    if (action === 'regenerate' && (!comment.trim() || comment.trim().length > 20_000)) { setError('全体コメントを1〜20000字で入力してください。'); return; }
    if (action === 'restore' && dirtyRef.current && !window.confirm('未保存の変更を破棄して、この版を新しい版として復元しますか？')) return;
    const command = action === 'restore' ? { action, baseVersion, sourceVersion: selected } : action === 'regenerate' ? { action, baseVersion, steps, comment } : { action, baseVersion, steps };
    const body = JSON.stringify(command);
    const key = retry.current?.body === body ? retry.current.key : crypto.randomUUID();
    retry.current = { body, key }; setBusy(true);
    if (action !== 'regenerate') editRevision.current += 1;
    try {
      const response = await fetch(`/api/tasks/${taskId}/breakdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...command, requestKey: key }) });
      if (!response.ok) throw new Error(response.status === 409 ? '別の変更があります。入力を控えてから最新の版を読み込んでください。' : response.status === 401 ? 'ログインし直してください。入力は保持しています。' : '保存できませんでした。入力を確認して再試行してください。');
      const data = breakdownSnapshotSchema.parse(await response.json());
      setSnapshot(data); retry.current = null;
      if (action === 'regenerate') { const job = data.jobs.at(-1); ownedJob.current = job ? { id: job.id, revision: editRevision.current } : null; setNotice('AIの作り直しを受け付けました。ワーカーの処理を待っています。'); }
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
      {pending ? <p role="status">AIが分解を作成中… ワーカーの処理を待っています。</p> : null}
      {failedJobs.length ? <details className={styles.history}><summary>失敗した再生成の入力（{failedJobs.length}件）</summary>{failedJobs.map((job, index) => <div key={job.id}>
        <p>失敗入力{index + 1}・{job.errorCode}・{job.createdAt}</p>
        <ol>{job.inputSteps.map((step, i) => <li key={i}>{step}</li>)}</ol><p>全体コメント {job.comment}</p>
        <Button label={`失敗入力${index + 1}を編集に戻す`} isDisabled={locked} onClick={() => recover(job)} />
      </div>)}</details> : null}
      {disabled ? <p>完了・中止したタスクの分解は変更できません。</p> : null}
      <details className={styles.history} open={Boolean(selected)}><summary>分解の版履歴（{snapshot?.versions.length ?? 0}件）</summary>
        {!snapshot?.versions.length ? <p>履歴はまだありません。</p> : <><label htmlFor="breakdown-history">表示する分解版</label><select id="breakdown-history" value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">版を選択</option>{snapshot.versions.map((version) => <option key={version.id} value={version.id}>{breakdownVersionLabel(version)}</option>)}</select></>}
        {history ? <div aria-label="過去の分解"><p>{breakdownVersionLabel(history)}</p>{history.steps.length ? <ol>{history.steps.map((step, i) => <li key={i}>{step}</li>)}</ol> : <p>項目はありません。</p>}{history.comment ? <p>全体コメント {history.comment}</p> : null}<Button label="この版を復元" isDisabled={locked} onClick={() => void submit('restore')} /></div> : null}
      </details>
    </>}
    <p role="status">{notice}</p>
    {error ? <p className={styles.warning} role="alert" data-app-error="true">{error}</p> : null}
    <Button label={loading ? '読み込み中…' : '最新の版を読み込む'} isDisabled={loading || busy} onClick={() => void reload()} />
  </section></ThemeContext.Provider>;
}
