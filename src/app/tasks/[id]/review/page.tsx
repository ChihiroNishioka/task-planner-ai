import Link from 'next/link';

export default async function Review({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main className="shell"><header className="topbar"><Link href={`/tasks/${id}`} className="back-link">← タスク詳細</Link><span className="mock-label">モック</span></header><section className="detail-card"><p className="eyebrow">ドラフト比較</p><h1>成果物レビュー</h1><p>まだドラフトはありません。AI生成はモックのため、タスクの作業計画や成果物を生成しません。</p><div className="version-grid"><div><h2>v1</h2><p>版はありません</p></div><div><h2>v2</h2><p>版はありません</p></div></div></section></main>;
}
