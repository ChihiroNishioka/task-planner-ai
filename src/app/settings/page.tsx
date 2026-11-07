import Link from 'next/link';

const services = ['Notion', 'Google Drive', 'Gmail', 'Google Calendar', '音声文字起こし', 'AI', '通知'];

export default function Settings() {
  return <main className="shell"><header className="topbar"><Link href="/" className="back-link">← タスク一覧</Link><span className="mock-label">モック</span></header><h1>設定</h1><section className="detail-card"><h2>外部サービス</h2><ul className="service-list">{services.map((service) => <li key={service}><span>{service}</span><strong>モック</strong></li>)}</ul><p>認証情報を設定していないため、実サービスには接続していません。</p></section></main>;
}
