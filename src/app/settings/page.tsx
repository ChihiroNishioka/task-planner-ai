'use client';

import Link from 'next/link';
import { revisionModeNotice } from '../../domain/labels';
import { useServices, type ServiceInfo } from '../use-services';

const fallbackServices: ServiceInfo[] = ['Notion', 'Google Drive', 'Gmail', 'Google Calendar', '音声文字起こし', 'AI', '通知'].map((name) => ({ name, mode: name === 'AI' ? 'unknown' : 'mock', label: name === 'AI' ? '確認中…' : 'モック' }));

export default function Settings() {
  const { services: loaded, error, reload } = useServices();
  const services = loaded ?? fallbackServices.map((service) => service.name === 'AI' && error ? { ...service, label: 'AIの実行モードを確認できません' } : service);
  const ai = services.find((service) => service.name === 'AI');
  return <main className="shell"><header className="topbar"><Link href="/" className="back-link">← タスク一覧</Link><span className="mock-label">モック</span></header><h1>設定</h1><section className="detail-card"><h2>外部サービス</h2><ul className="service-list">{services.map((service) => <li key={service.name}><span>{service.name}</span><strong>{service.label}</strong></li>)}</ul><p>{ai?.mode === 'cli' ? 'AIはサブスクのCLIで生成し、失敗したらモックに戻します。AI以外の連携はモックで、認証情報を設定していないため実サービスには接続していません。' : 'AI以外の連携はモックです。認証情報を設定していないため、実サービスには接続していません。'}</p>{ai?.revision ? <p className="revision-notice">{revisionModeNotice(ai.revision.mode, ai.mode === 'cli' || ai.mode === 'mock' ? ai.mode : null)}</p> : null}{error ? <p className="error" role="alert">{error}<button type="button" className="secondary-button" onClick={reload}>再試行</button></p> : null}{ai && ai.mode !== 'cli' && ai.mode !== 'mock' ? <p className="fallback-note">AIの実行モードは、常駐ワーカー（npm run worker）が記録した状態で表示します。ワーカーが動いていないときは不明です。</p> : null}</section></main>;
}
