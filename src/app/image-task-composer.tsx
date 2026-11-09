'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { TextArea } from '@astryxdesign/core/TextArea';
import { ThemeContext } from '@astryxdesign/core/theme';
import { InternationalizationProvider } from '@astryxdesign/core/i18n';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import styles from './image-task-composer.module.css';
import { userMessage } from '../domain/labels';
import { modeLabel } from '../domain/preparation';

const key = 'image-task-proposal';
const networkError = '通信できませんでした。接続を確認してもう一度お試しください。';
const suggestionSchema = z.object({ title: z.string().nullable(), deadline: z.string().nullable(), description: z.string(), extractedText: z.string().nullable(), noTaskFound: z.boolean() });
const proposalSchema = z.object({ id: z.string(), status: z.enum(['QUEUED', 'RUNNING', 'READY', 'CREATING', 'CONSUMED']), image: z.object({ name: z.string(), url: z.string() }), suggestion: suggestionSchema.nullable(), mode: z.enum(['ai', 'mock', 'mock_fallback']).nullable(), modeLabel: z.string().nullable(), fallbackReason: z.string().nullable(), taskId: z.string().nullable(), queueDelayed: z.boolean(), createStuck: z.boolean(), note: z.string().optional() });
type Proposal = z.infer<typeof proposalSchema>;
type Selection = { file: File; operationKey: string };
type Phase = { kind: 'idle' } | { kind: 'selected'; selection: Selection } | { kind: 'uploading'; selection: Selection } | { kind: 'proposal'; proposal: Proposal } | { kind: 'restoring'; id: string };
const errorSchema = z.object({ error: z.string() });

export function ImageTaskComposer({ note, deadline, onBusyChange }: { note: string; deadline: string; onBusyChange: (busy: boolean) => void }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState('');
  const [errorCount, setErrorCount] = useState(0);
  const [retry, setRetry] = useState(false);
  const [pollVersion, setPollVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState('');
  const [editDeadline, setEditDeadline] = useState('');
  const [description, setDescription] = useState('');
  const [editNote, setEditNote] = useState('');
  const [extractedText, setExtractedText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLLabelElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const focusFile = useRef(false);
  const initialized = useRef<string | null>(null);
  const focusReady = useRef<string | null>(null);
  const initialValues = useRef({ note, deadline });
  const retryOperation = useRef<'read' | 'poll' | 'create' | 'cancel'>('poll');
  const uploadAbort = useRef<AbortController | null>(null);
  const uploadRequest = useRef<Promise<Proposal | null> | null>(null);
  const cancelRequested = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  const pendingProposal = useRef<string | null>(null);
  const proposalId = phase.kind === 'proposal' ? phase.proposal.id : phase.kind === 'restoring' ? phase.id : null;
  const proposal = phase.kind === 'proposal' ? phase.proposal : null;
  const active = phase.kind === 'uploading' || phase.kind === 'proposal' || phase.kind === 'restoring';
  const showError = useCallback((message: string, canRetry = false) => { setError(message); setRetry(canRetry); setErrorCount(value => value + 1); }, []);
  useEffect(() => { onBusyChange(active); }, [active, onBusyChange]);
  useEffect(() => { if (errorCount) errorRef.current?.focus(); }, [errorCount]);
  useEffect(() => {
    let active = true;
    void Promise.resolve(sessionStorage.getItem(key)).then(stored => {
      if (active && stored) { pendingProposal.current = stored; setPhase({ kind: 'restoring', id: stored }); }
    });
    return () => { active = false; uploadAbort.current?.abort(); };
  }, []);
  useEffect(() => { if (phase.kind === 'idle' && focusFile.current) { focusFile.current = false; (chooseRef.current ?? fileRef.current)?.focus(); } }, [phase.kind]);
  useEffect(() => {
    if (proposal?.status === 'READY' && focusReady.current !== proposal.id) { focusReady.current = proposal.id; headingRef.current?.focus(); }
  }, [proposal?.id, proposal?.status]);
  function forget() {
    sessionStorage.removeItem(key); pendingProposal.current = null; initialized.current = null; focusReady.current = null;
    setPhase({ kind: 'idle' }); setError(''); setRetry(false); focusFile.current = true;
    if (fileRef.current) fileRef.current.value = '';
  }
  const handleResponse = useCallback(async (response: Response) => {
    if (response.status === 401) { sessionStorage.removeItem(key); router.push('/login?next=/'); return false; }
    if (!response.ok) {
      if (response.status === 404 || response.status === 410) { sessionStorage.removeItem(key); pendingProposal.current = null; setPhase({ kind: 'idle' }); }
      const parsed = errorSchema.safeParse(await response.json().catch(() => null));
      throw new Error(parsed.success ? parsed.data.error : networkError);
    }
    return true;
  }, [router]);
  const accept = useCallback((value: Proposal) => {
    if (value.status === 'CONSUMED' && value.taskId) { sessionStorage.removeItem(key); pendingProposal.current = null; router.push(`/tasks/${value.taskId}`); return; }
    if (value.status === 'READY' && initialized.current !== value.id) {
      initialized.current = value.id;
      const initial = initialValues.current;
      setTitle(value.suggestion?.title || initial.note.split('\n')[0] || ''); setEditDeadline(initial.deadline || value.suggestion?.deadline || '');
      setDescription(value.suggestion?.description ?? ''); setEditNote(value.note ?? initial.note); setExtractedText(value.suggestion?.extractedText ?? '');
    }
    setPhase({ kind: 'proposal', proposal: value });
    if (value.createStuck) showError('作成を完了できませんでした。時間をおいて再読み込みしてください。');
  }, [showError, router]);
  const shouldPoll = phase.kind === 'restoring' || (proposal && ['QUEUED', 'RUNNING', 'CREATING'].includes(proposal.status) && !proposal.createStuck);
  useEffect(() => {
    if (!proposalId || !shouldPoll || retry) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>; let failures = 0;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch(`/api/image-proposals/${proposalId}`, { signal: controller.signal });
        if (stopped || !await handleResponse(response)) return;
        const parsed = z.object({ proposal: proposalSchema }).parse(await response.json());
        if (stopped) return;
        failures = 0; setError(''); accept(parsed.proposal);
        if (['READY', 'CONSUMED'].includes(parsed.proposal.status) || parsed.proposal.createStuck) return;
      } catch (cause) {
        if (stopped) return;
        failures++;
        if (failures >= 5) { retryOperation.current = 'poll'; showError(userMessage(cause, networkError), true); return; }
      }
      timer = setTimeout(() => void poll(), 2000);
    }
    void poll(); return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [proposalId, shouldPoll, pollVersion, retry, handleResponse, accept, showError]);
  function select(file: File | undefined) {
    setError(''); setRetry(false);
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setPhase({ kind: 'idle' }); showError('画像は10MiB以下にしてください。'); return; }
    const mime = file.type.toLowerCase();
    const accepted = ['image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif'].includes(mime) || ((!mime || mime === 'application/octet-stream') && /\.(jpe?g|png|heic|heif)$/i.test(file.name));
    if (!accepted) { setPhase({ kind: 'idle' }); showError('対応していない形式です。JPEG、PNG、HEIC、HEIFの画像を選んでください。'); return; }
    cancelRequested.current = false;
    setPhase({ kind: 'selected', selection: { file, operationKey: crypto.randomUUID() } });
  }
  function upload(selection: Selection) {
    const controller = new AbortController(); uploadAbort.current = controller;
    const request = (async () => {
      const body = new FormData(); body.append('image', selection.file); body.append('note', initialValues.current.note);
      const response = await fetch('/api/image-proposals', { method: 'POST', headers: { 'idempotency-key': selection.operationKey }, body, signal: controller.signal });
      if (!await handleResponse(response)) return null;
      const parsed = z.object({ proposal: proposalSchema }).parse(await response.json());
      sessionStorage.setItem(key, parsed.proposal.id); pendingProposal.current = parsed.proposal.id;
      return parsed.proposal;
    })();
    const tracked = request.finally(() => {
      if (uploadAbort.current === controller) uploadAbort.current = null;
      if (uploadRequest.current === tracked) uploadRequest.current = null;
    });
    uploadRequest.current = tracked;
    return tracked;
  }
  async function read() {
    if (phase.kind !== 'selected') return;
    retryOperation.current = 'read';
    const selection = phase.selection;
    initialValues.current = { note, deadline }; setError(''); setRetry(false); setPhase({ kind: 'uploading', selection });
    try {
      const value = await upload(selection);
      if (value && !cancelRequested.current) accept(value);
    } catch (cause) {
      if (!cancelRequested.current) { setPhase({ kind: 'selected', selection }); showError(userMessage(cause, networkError), true); }
    }
  }
  async function cancel() {
    if (cancelling) return;
    cancelRequested.current = true;
    retryOperation.current = 'cancel'; setCancelling(true); setError(''); setRetry(false);
    try {
      if (!pendingProposal.current && phase.kind === 'uploading') {
        await (uploadRequest.current ?? upload(phase.selection));
      }
      if (!pendingProposal.current) return;
      const response = await fetch(`/api/image-proposals/${pendingProposal.current}`, { method: 'DELETE' });
      if (!await handleResponse(response)) return;
      forget();
    } catch (cause) { showError(userMessage(cause, networkError), true); }
    finally { setCancelling(false); }
  }
  async function create() {
    if (!proposal || saving || !title.trim()) return;
    retryOperation.current = 'create';
    setSaving(true); setError('');
    try {
      const response = await fetch(`/api/image-proposals/${proposal.id}/task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, deadline: editDeadline || null, description, note: editNote, extractedText: proposal.mode === 'ai' ? extractedText : null }) });
      if (response.status === 409) {
        const snapshot = await fetch(`/api/image-proposals/${proposal.id}`);
        if (!await handleResponse(snapshot)) return;
        const current = z.object({ proposal: proposalSchema }).parse(await snapshot.json());
        accept(current.proposal);
        if (current.proposal.status === 'CREATING' || current.proposal.status === 'CONSUMED') return;
      }
      if (!await handleResponse(response)) return;
      const result = z.object({ task: z.object({ id: z.string() }) }).parse(await response.json());
      sessionStorage.removeItem(key); router.push(`/tasks/${result.task.id}`);
    } catch (cause) { showError(userMessage(cause, networkError), true); }
    finally { setSaving(false); }
  }
  return <ThemeContext.Provider value={{ theme: neutralTheme, mode: 'light' }}><InternationalizationProvider locale="ja"><section data-astryx-theme="neutral" data-theme="light" className={styles.composer} aria-label="画像から作る">
    <h2>画像から作る</h2><p>スクリーンショットや写真からタスクの候補を作ります（JPEG / PNG / HEIC、10MiBまで）</p>
    <input ref={fileRef} id="image-task-file" className={styles.file} type="file" accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif" disabled={active} onChange={event => select(event.target.files?.[0])} />
    {!active && <label ref={chooseRef} tabIndex={-1} className={styles.choose} htmlFor="image-task-file">{phase.kind === 'selected' ? '選び直す' : error ? '画像を選び直す' : '画像を選ぶ'}</label>}
    {phase.kind === 'selected' && <><p className={styles.filename}>{phase.selection.file.name}</p><Button label="画像を読み取る" variant="primary" onClick={() => void read()} /></>}
    {(phase.kind === 'uploading' || phase.kind === 'restoring' || (proposal && proposal.status !== 'READY')) && <div><p data-testid="image-proposal-status" role="status">{proposal?.status === 'CREATING' ? '作成中…' : '画像を読み取っています…'}{proposal?.queueDelayed && <span>順番を待っています。このまま待つか、取り消してください。</span>}</p>{proposal?.status !== 'CREATING' && <Button label="取り消す" isDisabled={cancelling} onClick={() => void cancel()} />}</div>}
    {proposal?.status === 'READY' && <><h3 tabIndex={-1} ref={headingRef} className={styles.focus}>内容を確認</h3>
      <p data-testid="image-proposal-mode" className={styles.mode}>{proposal.mode === 'ai' ? proposal.modeLabel || 'AI生成' : `内容は${proposal.mode === 'mock_fallback' ? modeLabel('mock_fallback', proposal.fallbackReason) : proposal.modeLabel || 'モック'}。`}</p>
      {proposal.suggestion?.noTaskFound && <p>画像からタスクを読み取れませんでした。内容を入力してください。</p>}
      {/* 認証付き同一オリジンAPIをブラウザーから直接取得する。 */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <div className={styles.confirm}><div className={styles.preview}><img src={proposal.image.url} alt={`選択した画像: ${proposal.image.name}`} /></div>
      <div className={styles.fields}><TextInput label="タイトル" value={title} onChange={value => setTitle(value.slice(0, 240))} isDisabled={saving} />
      <label htmlFor="image-task-deadline">提案の期限</label><input id="image-task-deadline" type="date" value={editDeadline} disabled={saving} onChange={event => setEditDeadline(event.target.value)} />
      <TextArea label="説明" value={description} onChange={setDescription} maxLength={2000} isDisabled={saving} />
      <TextArea label="メモ" value={editNote} onChange={setEditNote} maxLength={2000} isDisabled={saving} />
      {proposal.mode === 'ai' && <TextArea label="読み取った文章" value={extractedText} onChange={setExtractedText} maxLength={8000} isDisabled={saving} />}
      <div className={styles.actions}><Button label={saving ? '作成中…' : 'この内容でタスクを作成'} variant="primary" isDisabled={saving || !title.trim()} onClick={() => void create()} /><Button label="やめる" isDisabled={saving} onClick={() => void cancel()} /></div></div></div></>}
    {error && <div ref={errorRef} tabIndex={-1} role="alert" data-testid="image-proposal-error" className={styles.error}>{error}</div>}
    {proposal?.createStuck ? <Button label="別の画像で始める" onClick={forget} /> : retry && <Button label="再試行" onClick={() => { setError(''); setRetry(false); if (retryOperation.current === 'read') void read(); else if (retryOperation.current === 'create') void create(); else if (retryOperation.current === 'cancel') void cancel(); else setPollVersion(value => value + 1); }} />}
  </section></InternationalizationProvider></ThemeContext.Provider>;
}
