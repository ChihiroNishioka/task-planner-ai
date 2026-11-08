'use client';

import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { TextInput } from '@astryxdesign/core/TextInput';
import { TextArea } from '@astryxdesign/core/TextArea';
import { InternationalizationProvider } from '@astryxdesign/core/i18n';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { fetchErrors, referenceLimits, referenceSchema, type Reference } from '../../../domain/references';

const listSchema = z.object({ references: z.array(referenceSchema) });
const savedSchema = z.object({ reference: referenceSchema });
const tabs = ['ファイル', 'メモ', 'URL'] as const;
type Tab = typeof tabs[number];
type Editor = { kind: 'new' } | { kind: 'edit'; id: string; revision: number };
const apiErrors: Record<number, string> = {
  401: 'ログインが必要です。再ログインしてください。', 403: 'この操作は許可されていません。',
  404: '資料またはタスクが見つかりません。資料を再読み込みしてください。',
  409: '資料が更新されたか、取得中です。再読み込みして確認してください。',
  422: '入力内容または資料の上限を確認してください。', 429: '取得処理が混み合っています。少し待って再試行してください。',
};

export function ReferencePanel({ taskId, children }: { taskId: string; children: ReactNode }) {
  const [tab, setTab] = useState<Tab>('ファイル');
  const [references, setReferences] = useState<Reference[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [editor, setEditor] = useState<Editor>({ kind: 'new' });
  const activeLoad = useRef(0);
  const monitoring = useRef(true);
  const mutating = useRef(false);
  const saveOperations = useRef(new Map<string, { signature: string; key: string }>());
  const endpoint = `/api/tasks/${taskId}/references`;
  const load = useCallback(async (cancelled: () => boolean = () => false) => {
    const attempt = ++activeLoad.current;
    try {
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error(apiErrors[response.status] ?? '資料を読み込めませんでした。');
      const data = listSchema.parse(await response.json());
      if (!cancelled() && activeLoad.current === attempt) {
        setReferences(data.references); setLoadError('');
        monitoring.current = data.references.some(item => item.kind === 'URL' && item.fetchStatus === 'FETCHING');
      }
    } catch (cause) {
      if (!cancelled() && activeLoad.current === attempt) { monitoring.current = true; setLoadError(cause instanceof Error && Object.values(apiErrors).includes(cause.message) ? cause.message : '資料を読み込めませんでした。'); }
    } finally { if (!cancelled() && activeLoad.current === attempt) setLoading(false); }
  }, [endpoint]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function observe() {
      if (cancelled) return;
      if (monitoring.current && !mutating.current) await load(() => cancelled);
      if (!cancelled) timer = setTimeout(() => void observe(), 2500);
    }
    monitoring.current = true;
    void observe();
    return () => { cancelled = true; clearTimeout(timer); activeLoad.current += 1; };
  }, [load]);

  function resetNote() { saveOperations.current.delete('note'); setTitle(''); setBody(''); setEditor({ kind: 'new' }); }
  async function mutate(path: string, method: string, data?: unknown, operation?: string) {
    activeLoad.current += 1;
    mutating.current = true;
    monitoring.current = true;
    const signature = JSON.stringify({ path, method, data });
    const previous = operation ? saveOperations.current.get(operation) : undefined;
    const key = previous?.signature === signature ? previous.key : crypto.randomUUID();
    if (operation) saveOperations.current.set(operation, { signature, key });
    setPending(true); setError(''); setMessage('');
    try {
      const response = await fetch(path, {
        method, headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      if (!response.ok) throw new Error(apiErrors[response.status] ?? '資料を保存できませんでした。もう一度お試しください。');
      if (response.status === 204) {
        setReferences(current => current.filter(item => `${endpoint}/${item.id}` !== path));
      } else {
        const saved = savedSchema.parse(await response.json()).reference;
        setReferences(current => current.some(item => item.id === saved.id) ? current.map(item => item.id === saved.id ? saved : item) : [...current, saved]);
      }
      if (operation) saveOperations.current.delete(operation);
      await load();
      return true;
    } catch (cause) {
      setError(cause instanceof Error && (Object.values(apiErrors).includes(cause.message) || cause.message.startsWith('資料を保存')) ? cause.message : '資料を保存できませんでした。もう一度お試しください。');
      return false;
    } finally { mutating.current = false; setPending(false); }
  }
  async function saveNote(event: FormEvent) {
    event.preventDefault();
    const editing = editor.kind === 'edit';
    if (await mutate(editing ? `${endpoint}/${editor.id}` : endpoint, editing ? 'PATCH' : 'POST', editing ? { title, body, revision: editor.revision } : { kind: 'NOTE', title, body }, 'note')) {
      resetNote(); setMessage(editing ? 'メモを更新しました。' : 'メモを保存しました。');
    }
  }
  async function saveUrl(event: FormEvent) {
    event.preventDefault();
    if (await mutate(endpoint, 'POST', { kind: 'URL', url }, 'url')) { setUrl(''); setMessage('URLを保存しました。取得結果を確認してください。'); }
  }
  async function remove(item: Reference) {
    if (!window.confirm('この資料を削除しますか？')) return;
    if (await mutate(`${endpoint}/${item.id}`, 'DELETE')) {
      if (editor.kind === 'edit' && editor.id === item.id) resetNote();
      setMessage('資料を削除しました。');
    }
  }
  return <InternationalizationProvider locale="ja" overrides={{ ja: { "@astryx.field.required": "必須" } }}><Theme theme={neutralTheme} mode="light"><section className="input-section reference-panel" data-reference-panel aria-label="関連資料">
    <h2>関連資料</h2>
    <TabList className="reference-tabs" role="tablist" aria-label="資料の種類" value={tab} onChange={value => { const selected = tabs.find(name => name === value); if (selected) setTab(selected); }} layout="fill" size="lg">{tabs.map((name, index) => <Tab key={name} id={`ref-tab-${index}`} value={name} label={name} panelId={`ref-panel-${index}`} onFocus={() => setTab(name)} />)}</TabList>
    <div id="ref-panel-0" role="tabpanel" aria-labelledby="ref-tab-0" hidden={tab !== 'ファイル'}>{children}</div>
    {loading ? <p role="status">資料を読み込み中…</p> : null}
    {loadError ? <div className="error" data-ref-error role="alert"><p>{loadError}</p><button type="button" className="secondary-button" disabled={loading || pending} onClick={() => { setLoading(true); void load(); }}>資料を再読み込み</button></div> : null}
    {error ? <p className="error" data-ref-error role="alert">{error}</p> : null}
    <p role="status" aria-live="polite">{message}</p>
    <div id="ref-panel-1" role="tabpanel" aria-labelledby="ref-tab-1" hidden={tab !== 'メモ'}>
      <form onSubmit={saveNote} className="reference-form"><TextInput controlClassName="reference-input-control" id="reference-note-title" label="メモの題名（任意）" value={title} onChange={value => { const next = value.slice(0, referenceLimits.noteTitle); if (next !== title) saveOperations.current.delete('note'); setTitle(next); }} isDisabled={pending} /><TextArea id="reference-note-body" label="メモの本文" value={body} maxLength={referenceLimits.noteBody} rows={6} isRequired onChange={value => { if (value !== body) saveOperations.current.delete('note'); setBody(value); }} isDisabled={pending} aria-describedby="reference-note-remaining" /><p id="reference-note-remaining">あと{referenceLimits.noteBody - body.length}文字</p><div className="reference-actions"><button className="secondary-button" disabled={pending || loading || !!loadError || !body.trim()}>{pending ? '保存中…' : editor.kind === 'edit' ? '変更を保存' : 'メモを保存'}</button>{editor.kind === 'edit' ? <button type="button" className="secondary-button" disabled={pending} onClick={resetNote}>編集をやめる</button> : null}</div></form>
      {!loading && !loadError && !references.some(item => item.kind === 'NOTE') ? <p>メモはまだありません。</p> : null}
      <ul className="reference-list">{references.filter(item => item.kind === 'NOTE').map(item => <li key={item.id} data-reference-kind="NOTE"><h3>{item.title || '題名のないメモ'}</h3><p className="reference-body">{item.body}</p><div className="reference-actions"><button type="button" className="secondary-button" disabled={pending} onClick={() => { saveOperations.current.delete('note'); setEditor({ kind: 'edit', id: item.id, revision: item.revision }); setTitle(item.title); setBody(item.body); document.getElementById('reference-note-body')?.focus(); }}>編集</button><button type="button" className="secondary-button" disabled={pending} onClick={() => void remove(item)}>削除</button></div></li>)}</ul>
    </div>
    <div id="ref-panel-2" role="tabpanel" aria-labelledby="ref-tab-2" hidden={tab !== 'URL'}>
      <form onSubmit={saveUrl} className="reference-form"><TextInput controlClassName="reference-input-control" id="reference-url" label="関連するURL" type="url" isRequired inputMode="url" value={url} placeholder="https://example.com/" onChange={value => { const next = value.slice(0, referenceLimits.url); if (next !== url) saveOperations.current.delete('url'); setUrl(next); }} isDisabled={pending} /><p>公開ページのタイトルと本文をサーバーで取得します。取得に失敗してもURLは保存されます。</p><button className="secondary-button" disabled={pending || loading || !!loadError || !url.trim()}>{pending ? '取得中…' : 'URLを追加'}</button></form>
      {!loading && !loadError && !references.some(item => item.kind === 'URL') ? <p>URLはまだありません。</p> : null}
      <ul className="reference-list">{references.map(item => item.kind === 'URL' ? <li key={item.id} data-reference-kind="URL"><h3>{item.title || 'URL資料'}</h3><SafeLink url={item.url} /><p className="reference-status">{item.fetchStatus === 'SUCCEEDED' ? '取得済み' : item.fetchStatus === 'FETCHING' ? '取得中' : '取得失敗'}・{item.fetchMode === 'fixture' ? 'テスト用データ' : item.fetchStatus === 'SUCCEEDED' ? '実サイトから取得' : '実サイト取得モード'}</p>{item.fetchErrorCode ? <p className="error">{fetchErrors[item.fetchErrorCode]}</p> : null}{item.fetchStatus !== 'SUCCEEDED' && item.body ? <p>以前に取得した本文です。最新の取得は完了していないためAI入力には使用しません。</p> : null}{item.truncated ? <p>本文の一部のみ保存</p> : null}{item.body ? <details><summary>本文を確認</summary><p className="reference-body">{item.body}</p></details> : null}<div className="reference-actions"><button type="button" className="secondary-button" disabled={pending || item.fetchStatus === 'FETCHING'} onClick={() => void mutate(`${endpoint}/${item.id}/refetch`, 'POST')}>再取得</button><button type="button" className="secondary-button" disabled={pending} onClick={() => void remove(item)}>削除</button></div></li> : null)}</ul>
    </div>
  </section></Theme></InternationalizationProvider>;
}

function SafeLink({ url }: { url: string }) {
  let safe = false;
  try {
    const parsed = new URL(url);
    safe = ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch { safe = false; }
  return safe ? <a href={url} target="_blank" rel="noopener noreferrer nofollow">{url}</a> : <span>{url}</span>;
}
