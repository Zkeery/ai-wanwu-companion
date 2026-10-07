import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { motionGeneration, parseGenerationRequest } from '@/lib/motion-generation';
import { clearToken, setToken } from '@/lib/auth';
const fetcher = vi.fn();
const waiting = { character_id: 18, state: 'waiting_authorization', request_id: 'a'.repeat(36) };
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal('fetch', fetcher); setToken('owner'); });
afterEach(() => { clearToken(); vi.unstubAllGlobals(); });
it('rejects mismatched identity, unknown states and extra fields', () => {
  for (const v of [{ ...waiting, character_id: 19 }, { ...waiting, state: 'paid' }, { ...waiting, approval_ref: 'secret' }])
    expect(() => parseGenerationRequest(v, 18)).toThrow();
});
it('GET has no body; registration sends no grant or owner fields', async () => {
  fetcher.mockImplementation(() => Promise.resolve(Response.json(waiting)));
  await motionGeneration(18, 'owner', new AbortController().signal);
  await motionGeneration(18, 'owner', new AbortController().signal, true);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', cache: 'no-store' });
  expect(fetcher.mock.calls[0][1].body).toBeUndefined();
  expect(fetcher.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{}', headers: { Authorization: 'Bearer owner' } });
});
it('blocks stale identities and never retries network failure', async () => {
  setToken('other'); await expect(motionGeneration(18, 'owner', new AbortController().signal, true)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled(); setToken('owner'); fetcher.mockRejectedValue(new Error('offline'));
  await expect(motionGeneration(18, 'owner', new AbortController().signal, true)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce();
});
