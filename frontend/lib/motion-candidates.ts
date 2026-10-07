import { checkResponse } from './api';
import { authHeaders, getToken } from './auth';

const states = ['reserved', 'attempted', 'unknown', 'needs_review', 'rejected', 'reviewed', 'queued', 'ready'] as const;
export type CandidateState = typeof states[number];
export type CandidateActivity = 'rest' | 'walk' | 'observe';
export type MotionCandidate = { job_id: string; state: CandidateState; candidate_sha256: string | null; image_url: string | null; activity?: CandidateActivity };
export type CandidatePage = { items: MotionCandidate[]; next_cursor: string | null };
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const base = (id: number) => `/api/v1/characters/${id}/motion-candidates`;
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('动作候选暂时无法核对');
  return v as Record<string, unknown>;
}
export function parseCandidate(value: unknown, id: number): MotionCandidate {
  const v = object(value);
  if (!['candidate_sha256,image_url,job_id,state', 'activity,candidate_sha256,image_url,job_id,state'].includes(Object.keys(v).sort().join(',')) || !sha(v.job_id)
      || ('activity' in v && !['rest', 'walk', 'observe'].includes(v.activity as string))
      || !states.includes(v.state as CandidateState)
      || !(v.candidate_sha256 === null || sha(v.candidate_sha256))
      || v.image_url !== (v.candidate_sha256 ? `${base(id)}/${v.job_id}/image/${v.candidate_sha256}` : null)) {
    throw new Error('动作候选暂时无法核对');
  }
  return v as MotionCandidate;
}
async function send(url: string, token: string, signal: AbortSignal, init: RequestInit = {}) {
  if (getToken() !== token) throw new Error('登录状态已变化');
  const response = await fetch(url, { ...init, cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { ...authHeaders(token), ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (getToken() !== token) throw new Error('登录状态已变化');
  await checkResponse(response, token);
  signal.throwIfAborted();
  return response;
}
export async function readCandidates(id: number, token: string, signal: AbortSignal, cursor: string | null = null, activity: CandidateActivity = 'walk'): Promise<CandidatePage> {
  if (cursor !== null && !sha(cursor)) throw new Error('列表位置无法核对');
  if (!['rest', 'walk', 'observe'].includes(activity)) throw new Error('动作分类无法核对');
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (activity !== 'walk') params.set('activity', activity);
  const v = object(await (await send(base(id) + (params.size ? `?${params}` : ''), token, signal)).json());
  if (Object.keys(v).sort().join(',') !== 'character_id,items,next_cursor' || v.character_id !== id
      || !Array.isArray(v.items) || v.items.length > 20 || !(v.next_cursor === null || sha(v.next_cursor))) {
    throw new Error('动作列表暂时无法核对');
  }
  const items = v.items.map(item => parseCandidate(item, id));
  if (items.some(item => (item.activity ?? 'walk') !== activity)
      || new Set(items.map(item => item.job_id)).size !== items.length
      || items.some((item, i) => item.job_id <= (i ? items[i-1].job_id : cursor ?? ''))
      || (v.next_cursor !== null && (items.length !== 20 || items[19].job_id !== v.next_cursor))) {
    throw new Error('动作列表暂时无法核对');
  }
  return { items, next_cursor: v.next_cursor };
}
export async function candidateImage(item: MotionCandidate, id: number, token: string, signal: AbortSignal): Promise<Blob> {
  parseCandidate(item, id);
  if (!item.image_url || !item.candidate_sha256) throw new Error('图片尚未就绪');
  const response = await send(item.image_url, token, signal);
  if (response.headers.get('content-type')?.split(';')[0] !== 'image/png') throw new Error('图片格式无法核对');
  const raw = await response.arrayBuffer();
  if (!raw.byteLength || raw.byteLength > 20 * 1024 * 1024) throw new Error('图片大小无法核对');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map(n => n.toString(16).padStart(2, '0')).join('');
  if (digest !== item.candidate_sha256 || getToken() !== token) throw new Error('图片已变化，请更新后再看');
  signal.throwIfAborted();
  return new Blob([raw], { type: 'image/png' });
}
export async function reviewCandidate(id: number, item: MotionCandidate, decision: 'accept' | 'reject', token: string, signal: AbortSignal): Promise<MotionCandidate> {
  const response = await send(`${base(id)}/${item.job_id}/review`, token, signal, { method: 'POST',
    body: JSON.stringify({ decision, candidate_sha256: item.candidate_sha256 }) });
  const result = parseCandidate(await response.json(), id);
  if (result.job_id !== item.job_id || result.candidate_sha256 !== item.candidate_sha256
      || (result.activity ?? 'walk') !== (item.activity ?? 'walk')) throw new Error('确认结果暂时无法核对');
  return result;
}
