import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { candidateImage, parseCandidate, readCandidates, reviewCandidate, type MotionCandidate } from '@/lib/motion-candidates';
import { clearToken, setToken } from '@/lib/auth';

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const digest = createHash('sha256').update(bytes).digest('hex');
const item: MotionCandidate = { job_id: 'a'.repeat(64), state: 'needs_review', candidate_sha256: digest,
  image_url: `/api/v1/characters/18/motion-candidates/${'a'.repeat(64)}/image/${digest}` };
const signal = () => new AbortController().signal;
const fetcher = vi.fn();
beforeEach(() => { setToken('owner'); vi.stubGlobal('fetch', fetcher); vi.stubGlobal('crypto', webcrypto); fetcher.mockReset(); });
afterEach(() => { clearToken(); vi.unstubAllGlobals(); });

it('validates exact owned image URLs and rejects unknown states and secret fields', () => {
  expect(parseCandidate(item, 18)).toEqual(item);
  for (const bad of [{ ...item, image_url: 'https://outside.test/image' }, { ...item, state: 'automatic_accept' },
    { ...item, local_path: '/private/file' }]) expect(() => parseCandidate(bad, 18)).toThrow();
  expect(() => parseCandidate(item, 19)).toThrow();
});
it('validates list identity, duplicates and pagination before display', async () => {
  for (const body of [{ character_id: 19, items: [item], next_cursor: null },
    { character_id: 18, items: [item, item], next_cursor: null },
    { character_id: 18, items: [item], next_cursor: item.job_id }]) {
    fetcher.mockResolvedValueOnce(Response.json(body)); await expect(readCandidates(18, 'owner', signal())).rejects.toThrow();
  }
});
it('fetches private images with auth and verifies pixel digest', async () => {
  fetcher.mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
  expect((await candidateImage(item, 18, 'owner', signal())).size).toBe(bytes.length);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: 'no-store', headers: { Authorization: 'Bearer owner' } });
  fetcher.mockResolvedValueOnce(new Response('changed', { headers: { 'Content-Type': 'image/png' } }));
  await expect(candidateImage(item, 18, 'owner', signal())).rejects.toThrow();
});
it('blocks a stale identity before fetching', async () => {
  setToken('another'); await expect(readCandidates(18, 'owner', signal())).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
});
it('sends only the explicit decision and hash, without retries on network failure', async () => {
  fetcher.mockRejectedValue(new Error('offline'));
  await expect(reviewCandidate(18, item, 'reject', 'owner', signal())).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ decision: 'reject', candidate_sha256: digest });
});
it('rejects a successful response for another candidate', async () => {
  const other = { ...item, job_id: 'b'.repeat(64), image_url: item.image_url!.replace('a'.repeat(64), 'b'.repeat(64)) };
  fetcher.mockResolvedValue(Response.json(other));
  await expect(reviewCandidate(18, item, 'accept', 'owner', signal())).rejects.toThrow();
});

it('queries only the chosen activity and rejects a response for another category', async () => {
  const rest = { ...item, activity: 'rest' as const };
  fetcher.mockResolvedValueOnce(Response.json({ character_id: 18, items: [rest], next_cursor: null }));
  expect((await readCandidates(18, 'owner', signal(), null, 'rest')).items).toEqual([rest]);
  expect(fetcher.mock.calls[0][0]).toBe('/api/v1/characters/18/motion-candidates?activity=rest');
  fetcher.mockResolvedValueOnce(Response.json({ character_id: 18, items: [item], next_cursor: null }));
  await expect(readCandidates(18, 'owner', signal(), null, 'observe')).rejects.toThrow();
  expect(() => parseCandidate({ ...item, activity: 'dance' }, 18)).toThrow();
});

it('rejects a review response that changes the activity', async () => {
  fetcher.mockResolvedValue(Response.json({ ...item, activity: 'observe' }));
  await expect(reviewCandidate(18, { ...item, activity: 'rest' }, 'accept', 'owner', signal())).rejects.toThrow();
});
