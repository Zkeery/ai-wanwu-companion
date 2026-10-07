import { array, object, parseAuthUser, parseCharacter, parseCharacterOverview, parseLivingSpace, parseMemory, parseMessage, parseScene, parseSpaceSummary, type SceneAction, type SpaceMember } from './contracts';
import { authHeaders, expireSession, getToken } from './auth';
import { parseThemes } from './themes';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); this.name = 'ApiError'; }
}
export async function checkResponse(response: Response, requestToken: string | null = getToken()): Promise<void> {
  if (response.ok) return;
  if (response.status === 401) { expireSession(requestToken); throw new ApiError('请先登录', 401, 'unauthorized'); }
  let message = response.status === 404 ? '这个伙伴已经不在这里了' : '暂时连接不上，请稍后再试';
  let code = 'request_failed';
  try { const body = object(await response.json()); const error = object(body.error); if (typeof error.message === 'string') message = error.message; if (typeof error.code === 'string') code = error.code; } catch { /* Keep the safe message when a proxy returns HTML. */ }
  throw new ApiError(message, response.status, code);
}
export async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const timeout = AbortSignal.timeout(15000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const requestToken = getToken();
  const response = await fetch('/api/v1' + path, { ...init, cache: 'no-store', signal, headers: { ...authHeaders(), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
  await checkResponse(response, requestToken);
  return response.status === 204 ? null : response.json();
}
export const api = {
  themes: async (signal?: AbortSignal) => parseThemes(await request('/themes', { signal })),
  // 账号
  auth: {
    inviteLogin: async (code: string) => {
      const r = object(await request('/auth/invite', { method: 'POST', body: JSON.stringify({ code }) }));
      if (typeof r.token !== 'string') throw new Error('登录结果格式不正确');
      return { token: r.token, user: parseAuthUser(r.user) };
    },
    sendCode: async (phone: string) => request('/auth/code', { method: 'POST', body: JSON.stringify({ phone }) }),
    login: async (phone: string, code: string) => {
      const r = object(await request('/auth/login', { method: 'POST', body: JSON.stringify({ phone, code }) }));
      if (typeof r.token !== 'string') throw new Error('登录结果格式不正确');
      return { token: r.token, user: parseAuthUser(r.user) };
    },
    logout: async () => request('/auth/logout', { method: 'POST' }),
    me: async () => parseAuthUser(await request('/auth/me')),
  },
  // 伙伴
  characters: async (signal?: AbortSignal) => array(await request('/characters', { signal }), parseCharacter),
  characterOverview: async (signal?: AbortSignal) => array(await request(`/characters/overview${process.env.NEXT_PUBLIC_LIFE_JOURNAL === 'true' ? '?include_life_activity=true' : ''}`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000),
  }), parseCharacterOverview),
  character: async (id: number, signal?: AbortSignal) => parseCharacter(await request(`/characters/${id}`, { signal })),
  generationCredits: async () => {
    const r = object(await request('/characters/generation-credits'));
    if (typeof r.enabled !== 'boolean' || (r.enabled && (!Number.isInteger(r.available) || Number(r.available) < 0 || Number(r.available) > 5))) throw new Error('生成额度暂时无法核对');
    return { enabled: r.enabled, available: r.enabled ? Number(r.available) : null,
      ...(typeof r.model_available === 'boolean' ? { model_available: r.model_available } : {}),
      ...(typeof r.unavailable_message === 'string' ? { unavailable_message: r.unavailable_message } : {}) };
  },
  recreation: async (key: string) => {
    const r = object(await request(`/characters/recreation-requests/${encodeURIComponent(key)}`));
    if (!['ready', 'generating', 'failed', 'deleted'].includes(String(r.status))) throw new Error('再创作状态暂时无法核对');
    return { status: r.status as 'ready' | 'generating' | 'failed' | 'deleted', character: r.character == null ? null : parseCharacter(r.character) };
  },
  messages: async (id: number, signal?: AbortSignal) => array(await request(`/characters/${id}/messages`, { signal }), parseMessage),
  chatRequest: async (id: number, key: string) => {
    const result = object(await request(`/characters/${id}/chat/requests/${encodeURIComponent(key)}`));
    if (!['running', 'completed', 'failed', 'untracked'].includes(String(result.status))) throw new Error('聊天状态无法确认，请稍后核对');
    return result.status as 'running' | 'completed' | 'failed' | 'untracked';
  },
  memories: async (id: number, signal?: AbortSignal) => array(await request(`/characters/${id}/memories`, { signal }), parseMemory),
  scene: async (id: number, signal?: AbortSignal) => parseScene(await request(`/characters/${id}/scene`, { signal })),
  clearHistory: async (id: number) => request(`/characters/${id}/messages`, { method: 'DELETE' }),
  deleteCharacter: async (id: number) => request(`/characters/${id}`, { method: 'DELETE' }),
  renameCharacter: async (id: number, name: string) => parseCharacter(await request(`/characters/${id}`, { method: 'PUT', body: JSON.stringify({ name }) })),
  sceneAction: async (id: number, action: SceneAction) => parseScene(await request(`/characters/${id}/scene/actions/${action}`, { method: 'POST' })),
  undo: async (id: number) => parseScene(await request(`/characters/${id}/scene/undo`, { method: 'POST' })),
  decide: async (id: number, token: string, decision: 'confirm' | 'reject') => parseScene(await request(`/characters/${id}/scene/proposals/${encodeURIComponent(token)}/${decision}`, { method: 'POST' })),
  addMemory: async (id: number, content: string) => parseMemory(await request(`/characters/${id}/memories`, { method: 'POST', body: JSON.stringify({ content }) })),
  editMemory: async (id: number, content: string) => parseMemory(await request(`/memories/${id}`, { method: 'PUT', body: JSON.stringify({ content }) })),
  deleteMemory: async (id: number) => request(`/memories/${id}`, { method: 'DELETE' }),
  // 多场景
  living: {
    spaces: async (signal?: AbortSignal) => array(await request('/living/spaces', { signal }), parseSpaceSummary),
    create: async (sceneType: string, mode: string, companionId?: number) => parseLivingSpace(await request('/living/spaces', { method: 'POST', body: JSON.stringify({ scene_type: sceneType, mode, companion_id: companionId != null ? String(companionId) : null }) })),
    space: async (id: string, signal?: AbortSignal) => parseLivingSpace(await request(`/living/spaces/${id}`, { signal })),
    action: async (id: string, requestId: string, expectedRevision: number, command: Record<string, unknown>) => parseLivingSpace(await request(`/living/spaces/${id}/actions`, { method: 'POST', body: JSON.stringify({ request_id: requestId, expected_revision: expectedRevision, command }) })),
    members: async (id: string): Promise<SpaceMember[]> => array(await request(`/living/spaces/${id}/members`), item => { const m = object(item); return { companion_id: String(m.companion_id), name: m.name == null ? null : String(m.name) }; }),
    addMember: async (id: string, companionId: number) => request(`/living/spaces/${id}/members`, { method: 'POST', body: JSON.stringify({ companion_id: String(companionId) }) }),
    removeMember: async (id: string, companionId: number) => request(`/living/spaces/${id}/members/${companionId}`, { method: 'DELETE' }),
    deleteSpace: async (id: string) => request(`/living/spaces/${id}`, { method: 'DELETE' }),
    location: async (characterId: number) => { const r = object(await request(`/characters/${characterId}/location`)); return r.space_id == null ? null : String(r.space_id); },
    setLocation: async (characterId: number, spaceId: string) => request(`/characters/${characterId}/location`, { method: 'PUT', body: JSON.stringify({ space_id: spaceId }) }),
  },
};
export function errorText(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return '等待时间有点久，请刷新查看结果后再试';
  return error instanceof Error ? error.message : '没有完成，请稍后再试';
}
