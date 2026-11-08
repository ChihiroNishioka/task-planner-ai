'use client';

import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { userMessage } from '../domain/labels';

const modeSchema = z.enum(['cli', 'mock']);
const servicesSchema = z.object({
  services: z.array(z.object({
    name: z.string(), mode: z.string(), label: z.string(),
    revision: z.object({ mode: modeSchema, label: z.string() }).optional(),
  })),
});
export type ServiceInfo = z.infer<typeof servicesSchema>['services'][number];

export const SERVICES_POLL_MS = 5_000;

/** /api/services を定期的に取得する。開きっぱなしでもワーカーのheartbeat変化を反映し、失敗は日本語のエラーとして返す。 */
export function useServices(intervalMs: number = SERVICES_POLL_MS) {
  const [services, setServices] = useState<ServiceInfo[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch('/api/services', { cache: 'no-store' });
        if (!response.ok) throw new Error('サービスの状態を取得できませんでした。');
        const data = servicesSchema.parse(await response.json());
        if (active) { setServices(data.services); setError(''); }
      } catch (cause) {
        if (active) { setServices(null); setError(userMessage(cause, 'サービスの状態を取得できませんでした。')); }
      }
    };
    void load();
    const timer = setInterval(() => void load(), intervalMs);
    return () => { active = false; clearInterval(timer); };
  }, [attempt, intervalMs]);
  return { services, error, reload };
}
