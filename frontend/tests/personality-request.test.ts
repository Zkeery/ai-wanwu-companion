import { afterEach, expect, it, vi } from 'vitest';
import { personalityApi } from '@/lib/personality';
afterEach(() => vi.unstubAllGlobals());
it('ends a stalled save within the personality deadline and does not retry the write', async () => {
  const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal!;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  vi.stubGlobal('fetch', fetchMock);
  const start = performance.now();
  await expect(personalityApi.save(12, { expected_revision: 0, mode: 'custom', tags: ['gentle'], custom_text: '', priority: null })).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(performance.now() - start).toBeLessThan(4500);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
}, 5000);
