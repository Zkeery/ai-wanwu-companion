import { beforeEach, expect, it, vi } from 'vitest';
import { clearToken, setToken } from '@/lib/auth';
import { invalidatePrivateImage, privateImageBlob } from '@/lib/private-images';
const response = (size = 16) => new Response('x'.repeat(size), { headers: { 'Content-Type': 'image/webp' } });
const read = (url: string, token = 'owner', marks?: string[]) => privateImageBlob(url, token, new AbortController().signal, s => marks?.push(s));
beforeEach(() => { vi.restoreAllMocks(); clearToken(); setToken('owner'); });

it('reuses a completed portrait on return and distinguishes a cache hit from a download', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response());
  const first = await read('/uploads/return.png'), stages: string[] = [];
  expect(await read('/uploads/return.png', 'owner', stages)).toBe(first);
  expect(stages).toEqual(['image_memory_cache_hit']);
  expect(fetcher).toHaveBeenCalledOnce();
  invalidatePrivateImage('/uploads/return.png', 'owner');
  await read('/uploads/return.png');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('drops successful bytes on account changes and logout, including a switch back', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response());
  await read('/uploads/account.png');
  setToken('other'); await read('/uploads/account.png', 'other');
  setToken('owner'); await read('/uploads/account.png');
  clearToken(); setToken('owner'); await read('/uploads/account.png');
  expect(fetcher).toHaveBeenCalledTimes(4);
});
it('expires portraits after two minutes', async () => {
  let clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response());
  await read('/uploads/expiry.png'); clock += 119_999; await read('/uploads/expiry.png');
  expect(fetcher).toHaveBeenCalledOnce();
  clock++; await read('/uploads/expiry.png'); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('evicts oldest portraits at the count bound and the byte bound', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response());
  for (let i = 0; i < 9; i++) await read(`/uploads/bound-${i}.png`);
  await read('/uploads/bound-0.png'); expect(fetcher).toHaveBeenCalledTimes(10);
  clearToken(); setToken('owner'); fetcher.mockImplementation(async () => response(5 * 1024 * 1024));
  await read('/uploads/large-a.png'); await read('/uploads/large-b.png'); await read('/uploads/large-a.png');
  expect(fetcher).toHaveBeenCalledTimes(13);
});
it('does not store an aborted late result in the return cache', async () => {
  let finish!: (r: Response) => void;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockImplementation(async () => response());
  const controller = new AbortController();
  const first = privateImageBlob('/uploads/late.png', 'owner', controller.signal).catch(e => e);
  controller.abort(); await first; finish(response());
  await Promise.resolve(); await Promise.resolve();
  await read('/uploads/late.png'); expect(fetcher).toHaveBeenCalledTimes(2);
});
