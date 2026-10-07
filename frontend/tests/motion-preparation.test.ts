import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadPreparedActivityMotion, parseMotionPreparation, readMotionPreparation } from '@/lib/motion-preparation';
import { loadPrivateMotionShared } from '@/lib/private-motion';
import type { MotionAsset } from '@/components/motion-player';

vi.mock('@/lib/private-motion', () => ({ loadPrivateMotionShared: vi.fn() }));
const snapshot = (state = 'queued') => ({ character_id: 7, activities: ['rest', 'walk', 'observe'].map(activity => ({
  activity, state: activity === 'rest' ? state : 'waiting_source', attempts: 0, error_code: null,
})) });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const loader = vi.mocked(loadPrivateMotionShared);
let fetcher: ReturnType<typeof vi.fn>;
const asset: MotionAsset = { spriteUrl: 'blob:sprite', backgroundUrl: 'blob:background', frameWidth: 320, frameHeight: 320, frameCount: 12, fps: 12, activity: 'rest' };

it('reads all preparation states through one authenticated read-only request', async () => {
  const signal = new AbortController().signal;
  expect(await readMotionPreparation(7, 'session', signal)).toEqual({ rest: 'queued', walk: 'waiting_source', observe: 'waiting_source' });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/v1/characters/7/motion-preparation', {
    headers: { Authorization: 'Bearer session' }, signal, cache: 'no-store', redirect: 'error',
  });
});

it('does not substitute a ready result for malformed or mismatched preparation responses', async () => {
  fetcher.mockResolvedValueOnce(json({ ...snapshot('ready'), character_id: 8 }));
  await expect(readMotionPreparation(7, 'session', new AbortController().signal)).rejects.toThrow('无法核对');
  fetcher.mockResolvedValueOnce(json({}, 404));
  expect(await readMotionPreparation(7, 'session', new AbortController().signal)).toBeNull();
});
beforeEach(() => {
  vi.useFakeTimers(); loader.mockReset();
  loader.mockResolvedValue({ asset: null, dispose: vi.fn() });
  fetcher = vi.fn(async () => json(snapshot())); vi.stubGlobal('fetch', fetcher);
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('waits for only the current queued activity then loads verified media', async () => {
  const dispose = vi.fn();
  loader.mockResolvedValueOnce({ asset: null, dispose }).mockResolvedValueOnce({ asset, dispose: vi.fn() });
  fetcher.mockResolvedValueOnce(json(snapshot())).mockResolvedValueOnce(json(snapshot('ready')));
  const signal = new AbortController().signal;
  const promise = loadPreparedActivityMotion(7, 'session', signal, 'rest');
  await vi.advanceTimersByTimeAsync(1000);
  expect((await promise).asset).toBe(asset);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(loader).toHaveBeenLastCalledWith(7, 'session', signal, 'rest');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenLastCalledWith('/api/v1/characters/7/motion-preparation', {
    headers: { Authorization: 'Bearer session' }, signal, cache: 'no-store', redirect: 'error',
  });
});

it('keeps existing cache hits free of preparation requests', async () => {
  loader.mockResolvedValue({ asset, dispose: vi.fn() });
  expect((await loadPreparedActivityMotion(7, 'session', new AbortController().signal, 'rest')).asset).toBe(asset);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['waiting_source', 'not_requested'])('does not poll forever for %s', async state => {
  fetcher.mockResolvedValue(json(snapshot(state)));
  expect((await loadPreparedActivityMotion(7, 'session', new AbortController().signal, 'rest')).asset).toBeNull();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('does not follow another activity or an older server into repeated requests', async () => {
  expect((await loadPreparedActivityMotion(7, 'session', new AbortController().signal, 'walk')).asset).toBeNull();
  fetcher.mockResolvedValue(json({}, 404));
  expect((await loadPreparedActivityMotion(7, 'session', new AbortController().signal, 'rest')).asset).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('stops polling on abort and never consumes a late status from an old account', async () => {
  const controller = new AbortController();
  const promise = loadPreparedActivityMotion(7, 'old-session', controller.signal, 'rest');
  const rejected = expect(promise).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  controller.abort(); await rejected;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(loader).toHaveBeenCalledTimes(1);
});

it('makes no further requests once the page hides', async () => {
  const promise = loadPreparedActivityMotion(7, 'session', new AbortController().signal, 'rest');
  await vi.advanceTimersByTimeAsync(0);
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  await vi.advanceTimersByTimeAsync(1000);
  expect((await promise).asset).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('bounds polling and leaves retry to the user', async () => {
  const promise = loadPreparedActivityMotion(7, 'session', new AbortController().signal, 'rest');
  const rejected = expect(promise).rejects.toThrow('超时');
  await vi.advanceTimersByTimeAsync(10_000); await rejected;
  expect(fetcher).toHaveBeenCalledTimes(10);
  expect(loader).toHaveBeenCalledTimes(1);
});

it('fails on backend failure, inconsistent readiness, or denied access', async () => {
  fetcher.mockResolvedValueOnce(json(snapshot('failed')));
  await expect(loadPreparedActivityMotion(7, 'session', new AbortController().signal, 'rest')).rejects.toThrow('未完成');
  fetcher.mockResolvedValueOnce(json(snapshot('ready')));
  await expect(loadPreparedActivityMotion(7, 'session', new AbortController().signal, 'rest')).rejects.toThrow('暂不可用');
  fetcher.mockResolvedValueOnce(json({}, 401));
  await expect(loadPreparedActivityMotion(7, 'session', new AbortController().signal, 'rest')).rejects.toThrow('登录');
});

it.each(['owner', 'duplicate', 'activity', 'state', 'attempts', 'error', 'extra', 'missing'])('rejects malformed status: %s', change => {
  const data = snapshot();
  if (change === 'owner') data.character_id = 8;
  if (change === 'duplicate') data.activities[1].activity = 'rest';
  if (change === 'activity') data.activities[1].activity = 'dance';
  if (change === 'state') data.activities[0].state = 'executing';
  if (change === 'attempts') data.activities[0].attempts = 4;
  if (change === 'error') Object.assign(data.activities[0], { error_code: '<script>' });
  if (change === 'extra') Object.assign(data, { local_path: '/private' });
  if (change === 'missing') data.activities.pop();
  expect(() => parseMotionPreparation(data, 7, 'rest')).toThrow('无法核对');
});
