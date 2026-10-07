import { request } from './api';
import { object } from './contracts';

export const activityNames = { rest: '休息', walk: '散步', observe: '观察' } as const;
export type Activity = keyof typeof activityNames;
export type LifeSettings = { enabled: boolean; activities: Activity[] };
export type LifeEvent = { id: string; mode: 'simulation'; activity: Activity; target_kind: string | null; season: string | null; created_at: number; reason: string; companion_id: string };
export type LifeSnapshot = { mode: 'simulation'; settings: LifeSettings; revision: number; present: boolean; observed_at: number; next_allowed_at: number; events: LifeEvent[]; outcome: string };
const integer = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const activity = (v: unknown): v is Activity => typeof v === 'string' && Object.hasOwn(activityNames, v);
export function parseLife(value: unknown): LifeSnapshot {
  const r = object(value), s = object(r.settings);
  if (r.mode !== 'simulation' || typeof r.present !== 'boolean' || !integer(r.revision) || !integer(r.observed_at) || !integer(r.next_allowed_at) || typeof r.outcome !== 'string' || typeof s.enabled !== 'boolean' || !Array.isArray(s.activities) || !s.activities.every(activity) || new Set(s.activities).size !== s.activities.length || (s.enabled && !s.activities.length) || !Array.isArray(r.events) || r.events.length > 20) throw new Error('生活模拟状态暂时无法核对');
  for (const raw of r.events) {
    const e = object(raw);
    if (e.mode !== 'simulation' || !activity(e.activity) || typeof e.id !== 'string' || typeof e.companion_id !== 'string' || typeof e.reason !== 'string' || !integer(e.created_at) || !(e.target_kind === null || typeof e.target_kind === 'string') || !(e.season === null || ['spring', 'summer', 'autumn', 'winter'].includes(String(e.season)))) throw new Error('生活模拟记录暂时无法核对');
  }
  return r as LifeSnapshot;
}
async function call(id: string, suffix: string, init: RequestInit) {
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
  return parseLife(await request(`/living/spaces/${encodeURIComponent(id)}/life-simulation${suffix}`, { ...init, signal }));
}
export const lifeApi = {
  read: (id: string, signal?: AbortSignal) => call(id, '', { signal }),
  save: (id: string, revision: number, settings: LifeSettings, signal?: AbortSignal) => call(id, '', { method: 'PUT', body: JSON.stringify({ request_id: crypto.randomUUID(), expected_revision: revision, settings }), signal }),
  step: (id: string, signal?: AbortSignal) => call(id, '/step', { method: 'POST', body: JSON.stringify({ request_id: crypto.randomUUID(), source: 'viewing' }), signal }),
};
