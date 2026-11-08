import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'Task Planner AI',
  description: 'タスクの登録と準備を行う個人用アプリ',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body>{children}</body></html>;
}
