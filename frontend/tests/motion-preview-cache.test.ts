import { expect, it, vi } from 'vitest';
import { createMotionPreviewCache } from '@/lib/motion-preview-cache';
import type { LoadedMotion } from '@/lib/private-motion';

const signal = () => new AbortController().signal;
const motion = (name = 'rest'): LoadedMotion => ({ asset: { videoUrl: `blob:${name}`, durationMs: 5000,
  spriteUrl: '', backgroundUrl: '', frameWidth: 640, frameHeight: 640, frameCount: 1, fps: 24 }, dispose: vi.fn() });

it('reuses a verified action throughout the open preview without reading again', async () => {
  const cache = createMotionPreviewCache(), rest = motion(), read = vi.fn(async () => rest);
  const first = await cache.load('rest', signal(), read); first.dispose();
  await cache.load('walk', signal(), async () => motion('walk'));
  // The original handoff cache used a three-second release deadline. This owner
  // retains its lease until the preview closes, so a later visit still reuses it.
  const again = await cache.load('rest', signal(), read);
  expect(again.asset).toBe(rest.asset); expect(read).toHaveBeenCalledTimes(1);
  expect(rest.dispose).not.toHaveBeenCalled();
  cache.clear(); expect(rest.dispose).toHaveBeenCalledOnce();
});

it('releases all four possible slots exactly once and allows a fresh scope after clear', async () => {
  const cache = createMotionPreviewCache(), owned = ['default', 'rest', 'walk', 'observe'].map(motion);
  for (const [i, key] of (['default', 'rest', 'walk', 'observe'] as const).entries()) await cache.load(key, signal(), async () => owned[i]);
  cache.clear(); cache.clear();
  for (const result of owned) expect(result.dispose).toHaveBeenCalledOnce();
  const fresh = motion('new'); expect((await cache.load('rest', signal(), async () => fresh)).asset).toBe(fresh.asset);
  cache.clear(); expect(fresh.dispose).toHaveBeenCalledOnce();
});

it('does not share resources across separate account or companion previews', async () => {
  const a = createMotionPreviewCache(), b = createMotionPreviewCache(), old = motion('old'), current = motion('current');
  await a.load('walk', signal(), async () => old);
  expect((await b.load('walk', signal(), async () => current)).asset).toBe(current.asset);
  a.clear(); expect(old.dispose).toHaveBeenCalledOnce(); expect(current.dispose).not.toHaveBeenCalled();
  b.clear();
});

it('does not cache missing results or failed reads and never retries them automatically', async () => {
  const cache = createMotionPreviewCache(), read = vi.fn().mockResolvedValueOnce({ asset: null, dispose: vi.fn() })
    .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(motion());
  expect((await cache.load('rest', signal(), read)).asset).toBeNull(); expect(read).toHaveBeenCalledTimes(1);
  await expect(cache.load('rest', signal(), read)).rejects.toThrow('offline'); expect(read).toHaveBeenCalledTimes(2);
  await cache.load('rest', signal(), read); expect(read).toHaveBeenCalledTimes(3); cache.clear();
});

it('cancels only the active download, disposes a late result, and leaves existing actions usable', async () => {
  const cache = createMotionPreviewCache(), rest = motion(), late = motion('walk'), controller = new AbortController();
  await cache.load('rest', signal(), async () => rest);
  let finish!: (result: LoadedMotion) => void, requested!: AbortSignal;
  const pending = cache.load('walk', controller.signal, s => { requested = s; return new Promise(done => { finish = done; }); });
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); expect(requested.aborted).toBe(true); finish(late); await rejected;
  expect(late.dispose).toHaveBeenCalledOnce();
  expect((await cache.load('rest', signal(), vi.fn())).asset).toBe(rest.asset); cache.clear();
});

it('a late result from a closed scope cannot populate the new one', async () => {
  const cache = createMotionPreviewCache(), old = motion('old'), fresh = motion('fresh');
  let finish!: (result: LoadedMotion) => void;
  const pending = cache.load('observe', signal(), () => new Promise(done => { finish = done; }));
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  cache.clear(); await cache.load('observe', signal(), async () => fresh); finish(old); await rejected;
  expect(old.dispose).toHaveBeenCalledOnce();
  expect((await cache.load('observe', signal(), vi.fn())).asset).toBe(fresh.asset);
  cache.clear(); expect(fresh.dispose).toHaveBeenCalledOnce();
});

it('an aborted caller cannot use a cached action', async () => {
  const cache = createMotionPreviewCache(); await cache.load('rest', signal(), async () => motion());
  const controller = new AbortController(); controller.abort();
  await expect(cache.load('rest', controller.signal, vi.fn())).rejects.toMatchObject({ name: 'AbortError' }); cache.clear();
});
