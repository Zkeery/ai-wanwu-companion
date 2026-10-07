import { checkResponse } from './api';
import { authHeaders, getToken } from './auth';

export const generationStates = ['not_requested', 'waiting_authorization', 'queued', 'running', 'needs_review',
  'reviewed', 'rejected', 'ready', 'unknown', 'blocked'] as const;
export type GenerationState = typeof generationStates[number];
export type GenerationRequest = { character_id: number; state: GenerationState; request_id: string | null };

export function parseGenerationRequest(raw: unknown, id: number): GenerationRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('准备任务无法核对');
  const v = raw as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'character_id,request_id,state' || v.character_id !== id
      || !generationStates.includes(v.state as GenerationState)
      || !(v.request_id === null || (typeof v.request_id === 'string' && /^[a-f0-9-]{36}$/.test(v.request_id)))) {
    throw new Error('准备任务无法核对');
  }
  return v as GenerationRequest;
}

export async function motionGeneration(id: number, token: string, signal: AbortSignal, register = false): Promise<GenerationRequest> {
  if (getToken() !== token) throw new Error('登录状态已变化');
  const response = await fetch(`/api/v1/characters/${id}/motion-generation`, { method: register ? 'POST' : 'GET',
    cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { ...authHeaders(token), ...(register ? { 'Content-Type': 'application/json' } : {}) },
    ...(register ? { body: '{}' } : {}) });
  await checkResponse(response, token);
  const result = parseGenerationRequest(await response.json(), id);
  signal.throwIfAborted();
  if (getToken() !== token) throw new Error('登录状态已变化');
  return result;
}

export const generationActivities = ['rest', 'walk', 'observe'] as const;
export type GenerationActivity = typeof generationActivities[number];
export type ActivityGeneration = Omit<GenerationRequest, 'character_id'> & { activity: GenerationActivity };
export type ActivityGenerations = { character_id: number; activities: ActivityGeneration[] };

export function parseActivityGenerations(raw: unknown, id: number): ActivityGenerations {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('准备任务无法核对');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'activities,character_id' || value.character_id !== id
      || !Array.isArray(value.activities) || value.activities.length !== generationActivities.length) {
    throw new Error('准备任务无法核对');
  }
  const activities = value.activities.map((rawItem, index) => {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) throw new Error('准备任务无法核对');
    const item = rawItem as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'activity,request_id,state'
        || item.activity !== generationActivities[index]) throw new Error('准备任务无法核对');
    const checked = parseGenerationRequest({ character_id: id, state: item.state, request_id: item.request_id }, id);
    return { activity: generationActivities[index], state: checked.state, request_id: checked.request_id };
  });
  const ids = activities.map(item => item.request_id).filter((value): value is string => value !== null);
  if (new Set(ids).size !== ids.length) throw new Error('准备任务无法核对');
  return { character_id: id, activities };
}

export async function motionGenerationActivities(id: number, token: string, signal: AbortSignal,
                                                  register = false): Promise<ActivityGenerations> {
  if (getToken() !== token) throw new Error('登录状态已变化');
  const response = await fetch(`/api/v1/characters/${id}/motion-generation/activities`, {
    method: register ? 'POST' : 'GET', cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { ...authHeaders(token), ...(register ? { 'Content-Type': 'application/json' } : {}) },
    ...(register ? { body: '{}' } : {}),
  });
  await checkResponse(response, token);
  const result = parseActivityGenerations(await response.json(), id);
  signal.throwIfAborted();
  if (getToken() !== token) throw new Error('登录状态已变化');
  return result;
}
