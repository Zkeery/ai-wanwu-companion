import { checkResponse } from './api';
import { authHeaders } from './auth';
import type { MotionAsset } from '@/components/motion-player';
import type { Activity } from './life-simulation';

export type LoadedMotion = { asset: MotionAsset | null; dispose: () => void };

// The scene and its detail replace one another in the same render. Keep only a
// verified activity asset across that short handoff; never share generic dance.
type SharedMotion = { id: number; value: LoadedMotion; users: number; timer: ReturnType<typeof setTimeout> | null };
const sharedMotions = new Map<string, SharedMotion>();
const sharedKey = (id: number, token: string, activity: Activity) => JSON.stringify([id, token, activity]);

export function clearPrivateMotionCache(id?: number) {
  for (const [key, entry] of sharedMotions) {
    if (id !== undefined && entry.id !== id) continue;
    if (entry.timer) clearTimeout(entry.timer);
    entry.value.dispose(); sharedMotions.delete(key);
  }
}

export async function loadPrivateMotionShared(id: number, token: string, signal: AbortSignal, activity: Activity): Promise<LoadedMotion> {
  signal.throwIfAborted();
  const key = sharedKey(id, token, activity);
  let entry = sharedMotions.get(key);
  if (!entry) {
    const value = await loadPrivateMotion(id, token, signal, activity);
    if (signal.aborted) { value.dispose(); signal.throwIfAborted(); }
    if (!value.asset) return value;
    entry = sharedMotions.get(key);
    if (entry) value.dispose();
    else {
      entry = { id, value, users: 0, timer: null };
      sharedMotions.set(key, entry);
    }
  }
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
  entry.users++;
  const owned = entry;
  let released = false;
  return { asset: entry.value.asset, dispose: () => {
    if (released) return;
    released = true; owned.users--;
    if (owned.users === 0 && sharedMotions.get(key) === owned) {
      owned.timer = setTimeout(() => { if (sharedMotions.get(key) === owned && owned.users === 0) {
        sharedMotions.delete(key); owned.value.dispose();
      } }, 3000);
    }
  } };
}

async function media(url: string, digest: string, token: string, signal: AbortSignal, mime = 'image/png'): Promise<Blob> {
  const response = await fetch(url, { headers: authHeaders(token), signal,
    cache: 'no-store', redirect: 'error' });
  await checkResponse(response, token);
  if (response.headers.get('Content-Type')?.split(';')[0] !== mime) throw new Error('动作素材格式无法核对');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('动作素材暂不可用');
  const parts: Uint8Array<ArrayBuffer>[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 10 * 1024 * 1024) throw new Error('动作素材过大');
      parts.push(new Uint8Array(next.value));
    }
  } catch (error) { await reader.cancel(); throw error; }
  finally { reader.releaseLock(); }
  const blob = new Blob(parts, { type: mime });
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
    n => n.toString(16).padStart(2, '0')).join('');
  if (size === 0 || hash !== digest) throw new Error('动作素材无法核对');
  return blob;
}

export async function loadPrivateMotion(id: number, token: string, signal: AbortSignal, activity?: Activity): Promise<LoadedMotion> {
  return loadMotion(id, token, signal, activity);
}

export async function loadGatheringMotion(groupId: string, id: number, token: string, signal: AbortSignal, activity: Activity): Promise<LoadedMotion> {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(groupId)) throw new Error('共同空间无法核对');
  return loadMotion(id, token, signal, activity, groupId);
}

async function loadMotion(id: number, token: string, signal: AbortSignal, activity?: Activity, groupId?: string): Promise<LoadedMotion> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('伙伴无法核对');
  if (activity !== undefined && !['rest', 'walk', 'observe'].includes(activity)) throw new Error('活动无法核对');
  const root = groupId ? `/api/v1/gatherings/${groupId}/companions/${id}/motion` : `/api/v1/characters/${id}/motion`;
  const response = await fetch(`${root}${activity ? `?activity=${activity}` : ''}`, {
    headers: authHeaders(token), signal, cache: 'no-store', redirect: 'error',
  });
  await checkResponse(response, token);
  const data = await response.json();
  const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!data || typeof data !== 'object') throw new Error('动作状态无法核对');
  if (data.state === 'missing' && Object.keys(data).length === 1) return { asset: null, dispose: () => {} };
  if ((data.activity !== undefined && !['rest', 'walk', 'observe'].includes(data.activity))
      || (data.slot !== undefined && data.slot !== 'activity')
      || (groupId !== undefined && data.slot !== 'activity')
      || (data.slot === 'activity' && activity === undefined)
      || (activity !== undefined && data.activity !== activity)) throw new Error('动作与当前活动无法核对');
  if (data.state !== 'ready' || typeof data.pack_id !== 'string' || !/^[a-f0-9]{32}$/.test(data.pack_id)
      || !sha(data.source_sha256)) throw new Error('动作状态无法核对');
  const base = data.slot === 'activity'
    ? `${root}/activity/${activity}/${data.pack_id}`
    : `${root}/${data.pack_id}`;
  if (data.kind === 'video') {
    if (data.video_url !== base + '/video' || !sha(data.video_sha256)
        || ![data.width, data.height, data.fps, data.duration_ms].every(Number.isInteger)
        || data.width < 64 || data.width > 1920 || data.height < 64 || data.height > 1920
        || data.fps !== 24 || data.duration_ms < 4000 || data.duration_ms > 15000) throw new Error('动作状态无法核对');
    const blob = await media(data.video_url, data.video_sha256, token, signal, 'video/mp4');
    signal.throwIfAborted();
    let videoUrl = URL.createObjectURL(blob);
    return { asset: { videoUrl, durationMs: data.duration_ms, spriteUrl: '', backgroundUrl: '',
      frameWidth: data.width, frameHeight: data.height, frameCount: 1, fps: data.fps, ...(data.activity ? { activity: data.activity } : {}) },
    dispose: () => { if (videoUrl) URL.revokeObjectURL(videoUrl); videoUrl = ''; } };
  }
  if (data.kind !== undefined || !sha(data.sprite_sha256) || !sha(data.background_sha256)) throw new Error('动作状态无法核对');
  if (data.sprite_url !== base + '/sprite' || data.background_url !== base + '/background'
      || ![data.frame_width, data.frame_height, data.frame_count, data.fps].every(Number.isInteger)
      || data.frame_width < 64 || data.frame_width > 512 || data.frame_height < 64 || data.frame_height > 512
      || data.frame_count < 2 || data.frame_count > 24 || data.fps < 4 || data.fps > 24
      || data.frame_width * data.frame_height * data.frame_count > 7_000_000) throw new Error('动作状态无法核对');
  const [sprite, background] = await Promise.all([
    media(data.sprite_url, data.sprite_sha256, token, signal),
    media(data.background_url, data.background_sha256, token, signal),
  ]);
  signal.throwIfAborted();
  let spriteUrl = '', backgroundUrl = '';
  const dispose = () => {
    if (spriteUrl) URL.revokeObjectURL(spriteUrl); if (backgroundUrl) URL.revokeObjectURL(backgroundUrl);
    spriteUrl = ''; backgroundUrl = '';
  };
  try {
    spriteUrl = URL.createObjectURL(sprite); backgroundUrl = URL.createObjectURL(background);
    return { asset: { spriteUrl, backgroundUrl, frameWidth: data.frame_width, frameHeight: data.frame_height,
      frameCount: data.frame_count, fps: data.fps, ...(data.activity ? { activity: data.activity } : {}) }, dispose };
  } catch (error) { dispose(); throw error; }
}
