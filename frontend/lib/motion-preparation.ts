import { checkResponse } from './api';
import { authHeaders } from './auth';
import type { Activity } from './life-simulation';
import { loadPrivateMotionShared, type LoadedMotion } from './private-motion';

export type PreparationState = 'not_requested' | 'waiting_source' | 'queued' | 'ready' | 'failed';
export type PreparationSummary = Record<Activity, PreparationState>;
const activities: Activity[] = ['rest', 'walk', 'observe'];
const states: PreparationState[] = ['not_requested', 'waiting_source', 'queued', 'ready', 'failed'];

export function parseMotionPreparation(value: unknown, id: number, activity: Activity): PreparationState {
  const bad = () => { throw new Error('动作准备状态无法核对'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(',') !== 'activities,character_id' || data.character_id !== id
      || !Array.isArray(data.activities) || data.activities.length !== 3) return bad();
  const seen = new Set<string>();
  let selected: PreparationState | undefined;
  for (const raw of data.activities) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad();
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'activity,attempts,error_code,state'
        || !activities.includes(item.activity as Activity) || seen.has(item.activity as string)
        || !states.includes(item.state as PreparationState)
        || !Number.isInteger(item.attempts) || Number(item.attempts) < 0 || Number(item.attempts) > 3
        || !(item.error_code === null || (typeof item.error_code === 'string' && /^[a-z_]{1,48}$/.test(item.error_code)))) return bad();
    seen.add(item.activity as string);
    if (item.activity === activity) selected = item.state as PreparationState;
  }
  return selected ?? bad();
}

function waitForNext(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancelled = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancelled); resolve(); }, 1000);
    signal.addEventListener('abort', cancelled, { once: true });
  });
}

export async function readMotionPreparation(id: number, token: string, signal: AbortSignal): Promise<PreparationSummary | null> {
  const response = await fetch(`/api/v1/characters/${id}/motion-preparation`, {
    headers: authHeaders(token), signal, cache: 'no-store', redirect: 'error',
  });
  signal.throwIfAborted();
  if (response.status === 404) return null;
  await checkResponse(response, token);
  const value: unknown = await response.json();
  signal.throwIfAborted();
  return { rest: parseMotionPreparation(value, id, 'rest'), walk: parseMotionPreparation(value, id, 'walk'),
    observe: parseMotionPreparation(value, id, 'observe') };
}

export async function loadPreparedActivityMotion(id: number, token: string, signal: AbortSignal, activity: Activity): Promise<LoadedMotion> {
  const first = await loadPrivateMotionShared(id, token, signal, activity);
  if (first.asset) return first;
  first.dispose();
  const missing = () => ({ asset: null, dispose: () => {} });
  // MotionPlayer owns the unchanged 10-second total deadline, including media
  // decoding. This additional count also bounds calls outside the component.
  for (let attempt = 0; attempt < 10; attempt++) {
    signal.throwIfAborted();
    if (document.hidden) return missing();
    const response = await fetch(`/api/v1/characters/${id}/motion-preparation`, {
      headers: authHeaders(token), signal, cache: 'no-store', redirect: 'error',
    });
    if (response.status === 404) return missing(); // Older servers have no preparation endpoint.
    await checkResponse(response, token);
    const state = parseMotionPreparation(await response.json(), id, activity);
    signal.throwIfAborted();
    if (document.hidden) return missing();
    if (state === 'ready') {
      const result = await loadPrivateMotionShared(id, token, signal, activity);
      if (!result.asset) { result.dispose(); throw new Error('动作素材暂不可用'); }
      return result;
    }
    if (state === 'failed') throw new Error('动作准备未完成');
    if (state !== 'queued') return missing();
    if (attempt < 9) await waitForNext(signal);
  }
  throw new Error('动作准备超时');
}
