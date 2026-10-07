import { checkResponse } from './api';
import { authHeaders, getToken } from './auth';
import { array, object, parseCharacter, type Character } from './contracts';
import { MAX_CANDIDATES } from './input-limits';
import { parseThemeId } from './themes';
import { parseOrigin, type CreationOrigin } from './creation-origin';

export type Photo = { id: number; status: string; theme_id?: string | null; objects: { id: number; label: string; visual_features?: string; category?: string }[] };
export type Draft = { origin?: CreationOrigin | null; requestId: string; photoId?: number; objectId?: number; label?: string; visualFeatures?: string; themeId?: string | null; freeCreation?: boolean };
export const DRAFT_KEY = 'companion-creation-v1';
function positiveId(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error('创建结果格式不正确');
  return value as number;
}
export function parsePhoto(value: unknown): Photo {
  const p = object(value);
  if (p.status !== 'done') throw new Error('照片识别尚未完成');
  const objects = array(p.objects, item => {
    const o = object(item);
    if (typeof o.label !== 'string') throw new Error('对象描述格式不正确');
    if (o.visual_features !== undefined && (typeof o.visual_features !== 'string' || o.visual_features.length > 500)) throw new Error('照片特征格式不正确');
    if (o.category !== undefined && (typeof o.category !== 'string' || !['fruit', 'plant', 'object', 'other', 'unknown'].includes(o.category))) throw new Error('照片类别格式不正确');
    return { id: positiveId(o.id), label: o.label, ...(o.visual_features === undefined ? {} : { visual_features: o.visual_features as string }), ...(o.category === undefined ? {} : { category: o.category as string }) };
  });
  if (!objects.length) throw new Error('没有得到可选对象，请换一张物品或植物照片');
  return { id: positiveId(p.id), status: p.status, objects: objects.slice(0, MAX_CANDIDATES), ...(p.theme_id == null ? {} : { theme_id: parseThemeId(p.theme_id) }) };
}
export function readDraft(): Draft | null {
  const raw = sessionStorage.getItem(DRAFT_KEY);
  if (!raw) return null;
  const d = object(JSON.parse(raw));
  if (typeof d.requestId !== 'string' || !/^[\da-f-]{36}$/i.test(d.requestId)) throw new Error('创建记录无法恢复，请重新选择照片');
  if (d.visualFeatures !== undefined && (typeof d.visualFeatures !== 'string' || d.visualFeatures.length > 500)) throw new Error('保存的照片特征无法恢复');
  if (d.freeCreation !== undefined && typeof d.freeCreation !== 'boolean') throw new Error('保存的创作方式无法恢复');
  return { origin: parseOrigin(d.origin), requestId: d.requestId, photoId: d.photoId == null ? undefined : positiveId(d.photoId), objectId: d.objectId == null ? undefined : positiveId(d.objectId), label: typeof d.label === 'string' ? d.label : undefined, visualFeatures: d.visualFeatures as string | undefined, ...(d.themeId == null ? {} : { themeId: parseThemeId(d.themeId) }), ...(d.freeCreation === undefined ? {} : { freeCreation: d.freeCreation }) };
}
export function writeDraft(draft: Draft) {
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); }
  catch { throw new Error('浏览器无法保存恢复记录，请允许本站使用会话存储后重试'); }
}
export function validatePhoto(file: File): string | null {
  if (!file.size) return '请选择一张有内容的图片';
  if (file.size > 10 * 1024 * 1024) return '图片不能超过 10MB';
  if (!/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) return '请选择 JPG、PNG、WebP 或 HEIC 图片';
  return null;
}
async function request(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<unknown> {
  const requestToken = getToken();
  const response = await fetch('/api/v1' + path, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]), cache: 'no-store', headers: { ...authHeaders(), ...init.headers } });
  await checkResponse(response, requestToken);
  return response.json();
}
export const creationApi = {
  correction: async (id: number, requestId: string, signal: AbortSignal) => parsePhoto(await request(`/photos/${id}/corrections`, signal, { method: 'POST', headers: { 'Idempotency-Key': requestId } })),
  upload: async (file: File, requestId: string, signal: AbortSignal, themeId?: string | null) => { const body = new FormData(); body.append('file', file); if (themeId) body.append('theme_id', themeId); return parsePhoto(await request('/photos', signal, { method: 'POST', body, headers: { 'Idempotency-Key': requestId } })); },
  photo: async (id: number, signal: AbortSignal) => parsePhoto(await request(`/photos/${id}`, signal)),
  receipt: async (key: string, signal: AbortSignal): Promise<{ status: 'running' | 'ready' | 'failed'; photo: Photo | null }> => {
    const r = object(await request(`/photos/requests/${encodeURIComponent(key)}`, signal));
    if (r.status !== 'running' && r.status !== 'ready' && r.status !== 'failed') throw new Error('无法识别当前状态，请稍后核对');
    return { status: r.status, photo: r.photo == null ? null : parsePhoto(r.photo) };
  },
  byObject: async (id: number, signal: AbortSignal) => { const r = await request(`/characters/by-object/${id}`, signal); return r == null ? null : parseCharacter(r); },
  rename: async (id: number, name: string, signal: AbortSignal) => parseCharacter(await request(`/characters/${id}`, signal, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })),
};

// Only a server-confirmed, persisted failure can skip the uncertain-state check.
export class GenerationFailedError extends Error {
  constructor(message: string, public characterId: number) { super(message); this.name = 'GenerationFailedError'; }
}

export async function consumeCreation(response: Response, stage: (text: string) => void, signal: AbortSignal, requestToken: string | null = getToken()): Promise<Character> {
  await checkResponse(response, requestToken);
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('生成连接异常，请核对结果');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', result: Character | null = null;
  const cancelReader = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancelReader, { once: true });
  function handle(block: string) {
    let event = ''; const data: string[] = [];
    for (const line of block.split(/\r?\n/)) { if (line.startsWith('event:')) event = line.slice(6).trim(); if (line.startsWith('data:')) data.push(line.slice(5).trimStart()); }
    if (!data.length || !event || result) return;
    const value = object(JSON.parse(data.join('\n')));
    if (event === 'chunk') { if (typeof value.stage !== 'string') throw new Error('生成阶段格式异常'); stage(value.stage); }
    if (event === 'error') {
      const e = object(value.error), message = typeof e.message === 'string' ? e.message : '生成失败，请核对结果';
      if (value.status === 'failed' && typeof value.character_id === 'number' && Number.isInteger(value.character_id) && value.character_id > 0) throw new GenerationFailedError(message, value.character_id);
      throw new Error(message);
    }
    if (event === 'done') { const c = parseCharacter(value); if (c.status !== 'ready') throw new Error('伙伴尚未生成完成'); result = c; }
  }
  try {
    while (!result) {
      signal.throwIfAborted(); const { done, value } = await reader.read(); signal.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) { handle(buffer.slice(0, boundary.index)); buffer = buffer.slice(boundary.index + boundary[0].length); if (result) break; }
      if (done) { if (buffer.trim()) handle(buffer); break; }
    }
    if (!result) throw new Error('连接已中断，请先核对生成结果');
    return result;
  } finally {
    signal.removeEventListener('abort', cancelReader);
    // The ready result is durable; transport teardown must not block the UI.
    cancelReader(); reader.releaseLock();
  }
}
export async function generateCompanion(objectId: number, label: string, signal: AbortSignal, stage: (text: string) => void, visualFeatures?: string, freeCreation = false): Promise<Character> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(180000)]);
  const requestToken = getToken();
  const response = await fetch('/api/v1/characters', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ object_id: objectId, label, ...(visualFeatures === undefined ? {} : { visual_features: visualFeatures }), ...(freeCreation ? { free_creation: true } : {}) }), signal: combined });
  return consumeCreation(response, stage, combined, requestToken);
}
