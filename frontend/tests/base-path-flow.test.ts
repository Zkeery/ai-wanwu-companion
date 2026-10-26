import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { request } from '@/lib/api';
import { setToken } from '@/lib/auth';
import { creationApi, generateCompanion } from '@/lib/creation';
import { privateImageBlob } from '@/lib/private-images';
import { withBasePath, withoutBasePath } from '@/lib/base-path';

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/partner');
  vi.stubEnv('NEXT_PUBLIC_AUTH_HEADER', 'Authorization');
  localStorage.clear();
  sessionStorage.clear();
  setToken('unit-test-token');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear(); sessionStorage.clear(); });

it('keeps login and API calls under the mount without changing their authentication', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
  vi.stubGlobal('fetch', fetcher);
  await request('/auth/invite', { method: 'POST', body: '{"code":"unit-test"}' });
  expect(fetcher.mock.calls[0][0]).toBe('/partner/api/v1/auth/invite');
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer unit-test-token');
});

it('uploads multipart photos to the mounted API with the same idempotency key', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 1, status: 'done', objects: [{ id: 2, label: '杯子' }] })));
  vi.stubGlobal('fetch', fetcher);
  await creationApi.upload(new File(['test'], 'cup.png'), 'stable-key', new AbortController().signal);
  const [url, options] = fetcher.mock.calls[0];
  expect(url).toBe('/partner/api/v1/photos');
  expect(options.body).toBeInstanceOf(FormData);
  expect(options.headers['Idempotency-Key']).toBe('stable-key');
  expect(options.headers['Content-Type']).toBeUndefined();
});

it('loads private images through the mount while retaining canonical URL validation', async () => {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } })));
  vi.stubGlobal('fetch', fetcher);
  const image = await privateImageBlob('/uploads/owner/cup.png', 'unit-test-token', new AbortController().signal);
  expect(image.type).toBe('image/png');
  expect(fetcher.mock.calls[0][0]).toBe('/partner/uploads/owner/cup.png?preview=true');
  await expect(privateImageBlob('/uploads/%2e%2e/private.env', 'unit-test-token', new AbortController().signal)).rejects.toThrow('无法核对');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('consumes the mounted generation SSE stream and only accepts a ready result', async () => {
  const character = { id: 7, name: '小杯', persona: '温柔', opening_line: '你好', image_path: null, status: 'ready', created_at: '' };
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response('event: done\ndata: ' + JSON.stringify(character) + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } })));
  vi.stubGlobal('fetch', fetcher);
  const result = await generateCompanion(2, '杯子', new AbortController().signal, vi.fn());
  expect(result.id).toBe(7);
  expect(fetcher.mock.calls[0][0]).toBe('/partner/api/v1/characters');
});

it('preserves the original root deployment and does not prefix a URL twice', async () => {
  expect(withBasePath('/partner/api/v1/characters')).toBe('/partner/api/v1/characters');
  expect(withoutBasePath('/partner/companions/7')).toBe('/companions/7');
  expect(withoutBasePath('/partner-other')).toBe('/partner-other');
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
  const fetcher = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
  vi.stubGlobal('fetch', fetcher);
  await request('/characters');
  expect(fetcher.mock.calls[0][0]).toBe('/api/v1/characters');
});

it('surfaces a mounted daily-limit failure instead of silently retrying a paid action', async () => {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response('{"error":{"code":"daily_model_limit","message":"今日次数已用完"}}', { status: 429 })));
  vi.stubGlobal('fetch', fetcher);
  await expect(request('/characters', { method: 'POST', body: '{}' })).rejects.toThrow('今日次数已用完');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
