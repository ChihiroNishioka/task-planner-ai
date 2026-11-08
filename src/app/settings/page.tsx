'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';

const servicesSchema = z.object({ services: z.array(z.object({ name: z.string(), mode: z.string(), label: z.string() })) });
type Service = z.infer<typeof servicesSchema>['services'][number];
const fallbackServices: Service[] = ['Notion', 'Google Drive', 'Gmail', 'Google Calendar', '音声文字起こし', 'AI', '通知'].map((name) => ({ name, mode: 'mock', label: 'モック' }));

export default function Settings() {
  const [services, setServices] = useState<Service[]>(fallbackServices);
  useEffect(() => {
    let active = true;
    void fetch('/api/services').then(async (response) => {
      if (!response.ok) return;
      const data = servicesSchema.parse(await response.json());
      if (active) setServices(data.services);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  const aiReal = services.some((service) => service.name === 'AI' && service.mode === 'cli');
  return <main className="shell"><header className="topbar"><Link href="/" className="back-link">← タスク一覧</Link><span className="mock-label">モック</span></header><h1>設定</h1><section className="detail-card"><h2>外部サービス</h2><ul className="service-list">{services.map((service) => <li key={service.name}><span>{service.name}</span><strong>{service.label}</strong></li>)}</ul><p>{aiReal ? 'AIはサブスクのCLIで生成し、失敗したらモックに戻します。ほかのサービスは認証情報を設定していないため、実サービスには接続していません。' : '認証情報を設定していないため、実サービスには接続していません。'}</p></section></main>;
}
