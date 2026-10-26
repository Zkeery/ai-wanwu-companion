import { beforeEach, expect, it, vi } from 'vitest';
import { clearToken, setToken } from '@/lib/auth';
import { privateImageBlob } from '@/lib/private-images';

const url = '/api/v1/gatherings/fc5096f1-6d9b-4f5e-a62b-f24f0802bedc/companions/4/image';
const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
const jpeg = [0xff, 0xd8, 0xff, 0xe0];
const webp = [0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];

async function emptyTypeResponse(bytes: number[], mime?: string) {
  const blob = await new Response(new Uint8Array(bytes)).blob();
  expect(blob.type).toBe('');
  const response = new Response(null, { headers: mime ? { 'Content-Type': mime } : {} });
  vi.spyOn(response, 'blob').mockResolvedValue(blob);
  return response;
}

beforeEach(() => {
  vi.restoreAllMocks();
  clearToken();
  localStorage.clear();
  setToken('synthetic-session');
});

it.each([
  ['image/png', png], ['image/jpeg', jpeg], ['image/webp', webp],
  ['image/png; charset=binary', png],
])('preserves authenticated image bytes when Blob loses %s', async (mime, bytes) => {
  const response = await emptyTypeResponse(bytes as number[], mime as string);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  const blob = await privateImageBlob(url, 'synthetic-session', new AbortController().signal);
  expect(blob.type).toBe((mime as string).split(';')[0]);
  expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(bytes);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({
    headers: { Authorization: 'Bearer synthetic-session' }, redirect: 'error', cache: 'no-store',
  }));
});

it.each([
  ['image/png', [60, 104, 116, 109, 108, 62]],
  ['image/png', png.slice(0, 7)],
  ['image/jpeg', png],
  ['text/html', png],
  ['image/svg+xml', [60, 115, 118, 103, 62]],
  [undefined, png],
])('rejects empty-type bodies with unverified %s', async (mime, bytes) => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(await emptyTypeResponse(bytes as number[], mime as string | undefined));
  await expect(privateImageBlob(url, 'synthetic-session', new AbortController().signal)).rejects.toThrow('形象格式');
});
