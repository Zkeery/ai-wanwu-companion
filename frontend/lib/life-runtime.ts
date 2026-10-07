import { request } from './api';
import { object } from './contracts';
import { activityNames, type Activity } from './life-simulation';

export type RuntimeTask = { id: string; state: 'queued' | 'running' | 'done' | 'cancelled' | 'failed'; created_at: number; retry_at: number; activity: Activity | null; target_id: string | null; error_code: string | null; dispatch_requested?: boolean; reason?: string | null };
export type AutomaticStatus = { enabled: boolean; revision: number; next_at: number; today_count: number; daily_limit: 2; viewing_until?: number; budget_available?: boolean | null };
export type CurrentActivity = { task_id: string; activity: Activity; target_id: string | null; started_at: number; expires_at: number; source: 'viewing' | 'offline' };
export type RuntimeSnapshot = { origin: 'offline_fixture' | 'real_provider'; space_id: string; companion_id: string; permission: { enabled: boolean; activities: Activity[]; revision: number }; present: boolean; observed_at: number; next_allowed_at: number; tasks: RuntimeTask[]; automatic?: AutomaticStatus | null; current_activity?: CurrentActivity | null };
export type RuntimeView = { snapshot: RuntimeSnapshot | null; stale: boolean };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 253402300799;
const activity = (v: unknown): v is Activity => typeof v === 'string' && Object.hasOwn(activityNames, v);
const errors = ['invalid_action', 'invalid_request', 'conflict', 'not_found', 'worker_error', 'budget_exhausted'];
const invalid = (): never => { throw new Error('生活体验状态暂时无法核对'); };
function parseTasks(list: unknown, observedAt: number): RuntimeTask[] {
  if (!Array.isArray(list) || list.length > 20) return invalid();
  const ids = new Set<string>(); let previous: RuntimeTask | null = null;
  for (const raw of list) {
    const t = object(raw);
    if (t.dispatch_requested !== undefined && typeof t.dispatch_requested !== 'boolean') return invalid();
    if (t.reason !== undefined && t.reason !== null && (typeof t.reason !== 'string' || !t.reason.trim()
      || Array.from(t.reason).length > 120 || [...t.reason].some(char => char.charCodeAt(0) < 32))) return invalid();
    if (!uuid(t.id) || ids.has(t.id) || !['queued', 'running', 'done', 'cancelled', 'failed'].includes(String(t.state)) || !integer(t.created_at) || t.created_at > observedAt || !integer(t.retry_at)) return invalid();
    if (previous && (t.created_at > previous.created_at || (t.created_at === previous.created_at && t.id > previous.id))) return invalid();
    if (t.state === 'done') {
      if (!activity(t.activity) || t.error_code !== null || (t.activity === 'observe' ? !uuid(t.target_id) : t.target_id !== null)) return invalid();
    } else if (t.activity !== null || t.target_id !== null || t.reason != null || (['failed', 'cancelled'].includes(String(t.state)) ? !errors.includes(String(t.error_code)) : t.error_code !== null)) return invalid();
    if (t.state === 'running' ? t.retry_at <= t.created_at : t.retry_at !== 0) return invalid();
    ids.add(t.id); previous = t as RuntimeTask;
  }
  return list as RuntimeTask[];
}

export type RuntimeHistory = Pick<RuntimeSnapshot, 'origin' | 'space_id' | 'companion_id' | 'observed_at' | 'tasks'> & { next_before: string | null };
function cursor(value: string) {
  const [stamp, id, extra] = value.split(':');
  const time = Number(stamp);
  if (extra !== undefined || !integer(time) || String(time) !== stamp || !uuid(id)) return invalid();
  return { created_at: time, id };
}
const older = (a: Pick<RuntimeTask, 'created_at' | 'id'>, b: Pick<RuntimeTask, 'created_at' | 'id'>) => a.created_at < b.created_at || (a.created_at === b.created_at && a.id < b.id);
export function parseRuntimeHistory(value: unknown, spaceId: string, before?: string): RuntimeHistory {
  const r = object(value);
  if (!['offline_fixture', 'real_provider'].includes(String(r.origin)) || !uuid(r.space_id) || r.space_id !== spaceId || typeof r.companion_id !== 'string' || !r.companion_id.trim() || !integer(r.observed_at)) return invalid();
  const tasks = parseTasks(r.tasks, r.observed_at);
  if (before && tasks.length && !older(tasks[0], cursor(before))) return invalid();
  if (r.next_before !== null) {
    if (typeof r.next_before !== 'string' || tasks.length !== 20) return invalid();
    const end = tasks[tasks.length - 1], next = cursor(r.next_before);
    if (next.created_at !== end.created_at || next.id !== end.id) return invalid();
  }
  return r as RuntimeHistory;
}

export async function readRuntimeHistory(spaceId: string, before?: string, signal?: AbortSignal): Promise<RuntimeHistory> {
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
  return parseRuntimeHistory(await request(`/living/spaces/${encodeURIComponent(spaceId)}/life-runtime/history${before ? `?before=${encodeURIComponent(before)}` : ''}`, { signal: bounded }), spaceId, before);
}

export function parseRuntime(value: unknown, spaceId: string): RuntimeSnapshot {
  const r = object(value), p = object(r.permission);
  const invalid = () => { throw new Error('生活体验状态暂时无法核对'); };
  if (!['offline_fixture', 'real_provider'].includes(String(r.origin)) || !uuid(r.space_id) || r.space_id !== spaceId || typeof r.companion_id !== 'string' || !r.companion_id.trim() || typeof r.present !== 'boolean' || !integer(r.observed_at) || !integer(r.next_allowed_at) || r.next_allowed_at < r.observed_at || typeof p.enabled !== 'boolean' || !integer(p.revision) || !Array.isArray(p.activities) || p.activities.length > 3 || !p.activities.every(activity) || new Set(p.activities).size !== p.activities.length || (p.enabled && (!p.activities.length || p.revision === 0)) || (p.revision === 0 && p.activities.length > 0) || !Array.isArray(r.tasks) || r.tasks.length > 20) return invalid();
  parseTasks(r.tasks, r.observed_at);
  if (r.current_activity !== undefined && r.current_activity !== null) {
    const c = object(r.current_activity), task = (r.tasks as RuntimeTask[])[0];
    if (!r.present || !p.enabled || !uuid(c.task_id) || !activity(c.activity) || !p.activities.includes(c.activity) || !['viewing', 'offline'].includes(String(c.source)) || !integer(c.started_at) || !integer(c.expires_at) || c.started_at > r.observed_at || c.expires_at <= r.observed_at || c.expires_at !== c.started_at + 600 || !task || task.state !== 'done' || task.id !== c.task_id || task.activity !== c.activity || task.target_id !== c.target_id || task.created_at > c.started_at) return invalid();
  }
  if (r.automatic !== undefined && r.automatic !== null) {
    const a = object(r.automatic);
    if (a.viewing_until !== undefined && (!integer(a.viewing_until) || (a.viewing_until !== 0 && (!a.enabled || a.viewing_until <= r.observed_at || a.viewing_until > r.observed_at + 75)))) return invalid();
    if (r.origin === 'real_provider' ? typeof a.budget_available !== 'boolean' : a.budget_available != null) return invalid();
    if (typeof a.enabled !== 'boolean' || !integer(a.revision) || !integer(a.next_at) || !integer(a.today_count) || a.today_count > 2 || a.daily_limit !== 2 || (a.enabled && (a.revision === 0 || !p.enabled)) || (!a.enabled && a.next_at !== 0)) return invalid();
  }
  return r as RuntimeSnapshot;
}
async function call(spaceId: string, suffix: string, init: RequestInit) {
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
  return parseRuntime(await request(`/living/spaces/${encodeURIComponent(spaceId)}/life-runtime${suffix}`, { ...init, signal }), spaceId);
}
export const runtimeApi = {
  viewing: async (id: string, leaseId: string, revision: number, enabled: boolean, signal?: AbortSignal) => {
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
    const value = object(await request(`/living/spaces/${encodeURIComponent(id)}/life-runtime/viewing/${encodeURIComponent(leaseId)}`, {
      method: 'PUT', body: JSON.stringify({ expected_revision: revision, enabled }), signal: bounded,
    }));
    if (value.lease_id !== leaseId || !integer(value.expires_at) || (enabled ? value.expires_at === 0 : value.expires_at !== 0)) return invalid();
    return { lease_id: leaseId, expires_at: value.expires_at };
  },
  automatic: (id: string, revision: number, enabled: boolean, signal?: AbortSignal) => call(id, '/automatic', { method: 'PUT', body: JSON.stringify({ request_id: crypto.randomUUID(), expected_revision: revision, enabled }), signal }),
  read: (id: string, signal?: AbortSignal) => call(id, '', { signal }),
  save: (id: string, revision: number, enabled: boolean, activities: Activity[], signal?: AbortSignal) => call(id, '/permission', { method: 'PUT', body: JSON.stringify({ request_id: crypto.randomUUID(), expected_revision: revision, enabled, activities }), signal }),
  schedule: (id: string, signal?: AbortSignal) => call(id, '/tasks', { method: 'POST', body: JSON.stringify({ request_id: crypto.randomUUID() }), signal }),
  run: (id: string, taskId: string, signal?: AbortSignal) => call(id, `/tasks/${encodeURIComponent(taskId)}/dispatch`, { method: 'POST', body: '{}', signal }),
};
