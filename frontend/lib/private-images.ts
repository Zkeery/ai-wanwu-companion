import { checkResponse } from './api';
import { appFetch as fetch } from './base-path';
import { AUTH_CHANGED, authHeaders, getToken } from './auth';

export function isPrivateImageUrl(url: string): boolean {
  if (/^\/api\/v1\/gatherings\/[a-f0-9-]+\/companions\/[1-9][0-9]*\/image$/.test(url)) return true;
  if (/^\/api\/v1\/teams\/[a-f0-9-]+\/submissions\/[a-f0-9-]+\/image$/.test(url)) return true;
  if (!url.startsWith('/uploads/') || /[?#\\\p{C}]/u.test(url)) return false;
  try {
    const path = decodeURIComponent(url.slice('/uploads/'.length));
    return !/[\\\p{C}]/u.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
  } catch { return false; }
}

export type ImageLoadStage = 'image_request_started' | 'image_response_headers' | 'image_bytes_ready' | 'image_memory_cache_hit';
type Subscriber = { signal: AbortSignal; onStage?: (stage: ImageLoadStage) => void };
type PendingImage = { controller: AbortController; promise: Promise<Blob>; stages: ImageLoadStage[]; subscribers: Set<Subscriber>; settled: boolean };
// Every mounted image owns its blob URL; only successful bytes may be reused.
const pendingImages = new Map<string, PendingImage>();
const completedImages = new Map<string, { blob: Blob; expires: number }>();
const MAX_BYTES = 8 * 1024 * 1024, MAX_IMAGES = 8, CACHE_MS = 120_000;
let cacheOwner: string | null = null;
function syncCacheOwner() {
  const current = getToken();
  if (current !== cacheOwner) { completedImages.clear(); cacheOwner = current; }
  return current;
}
if (typeof window !== 'undefined') {
  window.addEventListener(AUTH_CHANGED, syncCacheOwner);
  window.addEventListener('storage', syncCacheOwner);
}
export function invalidatePrivateImage(url: string, token: string) {
  completedImages.delete(JSON.stringify([token, url]));
}
function remember(key: string, token: string, blob: Blob) {
  if (syncCacheOwner() !== token || blob.size > MAX_BYTES) return;
  for (const [k, value] of completedImages) if (value.expires <= Date.now()) completedImages.delete(k);
  completedImages.delete(key);
  completedImages.set(key, { blob, expires: Date.now() + CACHE_MS });
  let bytes = [...completedImages.values()].reduce((total, value) => total + value.blob.size, 0);
  while (completedImages.size > MAX_IMAGES || bytes > MAX_BYTES) {
    const oldest = completedImages.keys().next().value!;
    bytes -= completedImages.get(oldest)!.blob.size;
    completedImages.delete(oldest);
  }
}

function notify(subscriber: Subscriber, stage: ImageLoadStage) {
  try { if (!subscriber.signal.aborted) subscriber.onStage?.(stage); } catch { /* Diagnostics cannot break loading. */ }
}

function downloadImage(key: string, url: string, token: string): PendingImage {
  let resolve!: (blob: Blob) => void, reject!: (error: unknown) => void;
  const entry: PendingImage = { controller: new AbortController(), stages: [], subscribers: new Set(), settled: false,
    promise: new Promise((done, fail) => { resolve = done; reject = fail; }) };
  pendingImages.set(key, entry);
  const mark = (stage: ImageLoadStage) => {
    entry.stages.push(stage);
    for (const subscriber of entry.subscribers) notify(subscriber, stage);
  };
  const finish = () => {
    entry.settled = true;
    if (pendingImages.get(key) === entry) pendingImages.delete(key);
  };
  void (async () => {
    mark('image_request_started');
    const response = await fetch(url.startsWith('/uploads/') ? `${url}?preview=true` : url, {
      headers: authHeaders(token), cache: 'no-store', redirect: 'error',
      signal: AbortSignal.any([entry.controller.signal, AbortSignal.timeout(15000)]),
    });
    mark('image_response_headers');
    await checkResponse(response, token);
    let blob = await response.blob();
    // Some transports retain Content-Type but lose the Blob MIME type.
    // Restore only a supported raster type whose file signature agrees.
    if (!blob.type) {
      const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
      const matches = mime === 'image/png'
        ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => head[index] === byte)
        : mime === 'image/jpeg'
          ? head[0] === 255 && head[1] === 216 && head[2] === 255
          : mime === 'image/webp'
            ? head.length === 12 && [82, 73, 70, 70].every((byte, index) => head[index] === byte)
              && [87, 69, 66, 80].every((byte, index) => head[index + 8] === byte)
            : false;
      if (matches) blob = new Blob([blob], { type: mime });
    }
    if (!blob.type.startsWith('image/')) throw new Error('形象格式暂时无法识别');
    mark('image_bytes_ready');
    return blob;
  })().then(blob => {
    if (!entry.controller.signal.aborted && pendingImages.get(key) === entry) remember(key, token, blob);
    finish(); resolve(blob);
  }, error => { finish(); reject(error); });
  return entry;
}

export async function privateImageBlob(url: string, token: string, signal: AbortSignal, onStage?: (stage: ImageLoadStage) => void): Promise<Blob> {
  if (!isPrivateImageUrl(url)) throw new Error('图片地址无法核对');
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  const key = JSON.stringify([token, url]);
  if (syncCacheOwner() === token) {
    const cached = completedImages.get(key);
    if (cached && cached.expires > Date.now()) {
      completedImages.delete(key); completedImages.set(key, cached);
      notify({ signal, onStage }, 'image_memory_cache_hit');
      signal.throwIfAborted();
      return cached.blob;
    }
    completedImages.delete(key);
  }
  const entry = pendingImages.get(key) ?? downloadImage(key, url, token);
  return new Promise<Blob>((resolve, reject) => {
    const subscriber: Subscriber = { signal, onStage };
    let done = false;
    const cleanup = () => { entry.subscribers.delete(subscriber); signal.removeEventListener('abort', abort); };
    const abort = () => {
      if (done) return;
      done = true; cleanup();
      if (!entry.settled && entry.subscribers.size === 0) {
        if (pendingImages.get(key) === entry) pendingImages.delete(key);
        entry.controller.abort();
      }
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    entry.subscribers.add(subscriber);
    signal.addEventListener('abort', abort, { once: true });
    entry.promise.then(blob => { if (!done) { done = true; cleanup(); resolve(blob); } }, error => { if (!done) { done = true; cleanup(); reject(error); } });
    for (const stage of entry.stages) { if (done) break; notify(subscriber, stage); }
  });
}
