import { checkResponse } from './api';
import { authHeaders } from './auth';

export function isPrivateImageUrl(url: string): boolean {
  if (/^\/api\/v1\/gatherings\/[a-f0-9-]+\/companions\/[1-9][0-9]*\/image$/.test(url)) return true;
  if (/^\/api\/v1\/teams\/[a-f0-9-]+\/submissions\/[a-f0-9-]+\/image$/.test(url)) return true;
  if (!url.startsWith('/uploads/') || /[?#\\\p{C}]/u.test(url)) return false;
  try {
    const path = decodeURIComponent(url.slice('/uploads/'.length));
    return !/[\\\p{C}]/u.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
  } catch { return false; }
}

export async function privateImageBlob(url: string, token: string, signal: AbortSignal): Promise<Blob> {
  if (!isPrivateImageUrl(url)) throw new Error('图片地址无法核对');
  const response = await fetch(url, {
    headers: authHeaders(token), cache: 'no-store', redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  await checkResponse(response, token);
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('形象格式暂时无法识别');
  return blob;
}
