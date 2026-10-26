import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHomeClipSpeech } from '@/lib/living-home-clip-speech';

const FIRST = '太阳暖暖的，去院子走一走吧。', SECOND = '好呀，我们一会儿一起喝茶。';
const clips = { [FIRST]: '/local-voices/first.wav', [SECOND]: '/local-voices/second.wav' };
const caption = (key = 'first', text = FIRST, actorId = 4) => ({ key, text, actorId });
class LocalPlayer {
  src = ''; preload = ''; currentTime = 0; onended: (() => void) | null = null; onerror: (() => void) | null = null; playing = false;
  duration = 6.25; mediaError: { code: number } | null = null;
  get paused() { return !this.playing; }
  get error() { return this.mediaError; }
  play = vi.fn((): Promise<void> => { this.playing = true; return Promise.resolve(); });
  pause = vi.fn(() => { this.playing = false; });
  load = vi.fn(); removeAttribute = vi.fn((name: string) => { if (name === 'src') this.src = ''; });
  end() { this.playing = false; this.onended?.(); }
  failMedia() { this.playing = false; this.onerror?.(); }
}
function setup(map: Readonly<Record<string, string>> = clips) {
  const player = new LocalPlayer(), factory = vi.fn(() => player as unknown as HTMLAudioElement);
  return { player, factory, speech: createHomeClipSpeech(map, factory) };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('explicit local fixture audio captions', () => {
  it('constructs nothing by default, creates one player only on explicit enable and plays only a future exact caption', () => {
    const f = setup(); expect(f.speech.getSnapshot()).toMatchObject({ enabled: false, speaking: false, status: 'off', voiceName: '本地离线示例', localOnly: true });
    expect(f.speech.say(caption('past'))).toBe(false); expect(f.factory).not.toHaveBeenCalled(); expect(f.player.play).not.toHaveBeenCalled();
    expect(f.speech.enable()).toBe(true); expect(f.factory).toHaveBeenCalledTimes(1); expect(f.player.preload).toBe('auto'); expect(f.player.play).not.toHaveBeenCalled(); expect(f.speech.say(caption('past'))).toBe(false);
    expect(f.speech.say(caption('fresh'))).toBe(true); expect(f.player.src).toBe(clips[FIRST]); expect(f.player.play).toHaveBeenCalledTimes(1); expect(f.speech.getSnapshot()).toMatchObject({ speaking: true, currentCaption: caption('fresh'), pendingCount: 0 }); f.speech.dispose();
  });

  it('does not synthesize, normalize into another caption or play an unknown caption', () => {
    const f = setup(); f.speech.enable(); for (const text of [FIRST + ' ', ' ' + FIRST, FIRST.replace('，', ','), '未知字幕', 'constructor']) expect(f.speech.say(caption(text, text))).toBe(false);
    expect(f.player.play).not.toHaveBeenCalled(); expect(f.player.src).toBe(''); expect(f.speech.say(caption('known'))).toBe(true); expect(f.player.src).toBe('/local-voices/first.wav'); f.speech.dispose();
  });

  it('rejects external, traversal, encoded traversal and non-path URLs before constructing any player', () => {
    const invalid = ['https://example.com/local-voices/a.wav', '//example.com/local-voices/a.wav', 'local-voices/a.wav', '/local-voices/../a.wav', '/local-voices/%2e%2e/a.wav', '/local-voices/%252e%252e/a.wav', '/local-voices/a\\..\\b.wav', '/local-voices/%5cfile.wav', '/local-voices//a.wav', '/local-voices/a.wav?remote=https://example.com', '/local-voices/a.wav#x', '/local-voices/%00a.wav', '/local-voices/a b.wav', '/local-voices/%zz.wav', '/local-voices/'];
    for (const path of invalid) { const f = setup({ [FIRST]: path }); expect(f.speech.enable(), path).toBe(false); expect(f.speech.say(caption()), path).toBe(false); expect(f.factory, path).not.toHaveBeenCalled(); expect(f.speech.getSnapshot().status).toBe('unavailable'); f.speech.dispose(); }
  });

  it('keeps two partners in order with at most one pending caption, and remembers dropped or duplicate keys', () => {
    const f = setup(); f.speech.enable(); expect(f.speech.say(caption())).toBe(true); expect(f.speech.say(caption('second', SECOND, 5))).toBe(true); expect(f.speech.say(caption('second', SECOND, 5))).toBe(false); expect(f.speech.say(caption('overflow'))).toBe(false);
    expect(f.player.play).toHaveBeenCalledTimes(1); expect(f.speech.getSnapshot()).toMatchObject({ currentCaption: caption(), pendingCount: 1 }); f.player.end();
    expect(f.player.play).toHaveBeenCalledTimes(2); expect(f.player.src).toBe(clips[SECOND]); expect(f.speech.getSnapshot()).toMatchObject({ currentCaption: caption('second', SECOND, 5), pendingCount: 0 }); f.player.end();
    expect(f.speech.getSnapshot()).toMatchObject({ speaking: false, currentCaption: null }); expect(f.speech.say(caption('first'))).toBe(false); expect(f.speech.say(caption('overflow'))).toBe(false); f.speech.dispose();
  });

  it('drops a pending caption after eight seconds without replay, while allowing a future new key', () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000); const f = setup(); f.speech.enable(); f.speech.say(caption()); f.speech.say(caption('expired', SECOND, 5)); vi.setSystemTime(18_001); f.player.end();
    expect(f.player.play).toHaveBeenCalledTimes(1); expect(f.speech.getSnapshot()).toMatchObject({ currentCaption: null, pendingCount: 0 }); expect(f.speech.say(caption('expired', SECOND, 5))).toBe(false); expect(f.speech.say(caption('future', SECOND, 5))).toBe(true); f.speech.dispose();
  });

  it('immediately pauses and clears both captions without replaying them when resumed', () => {
    const f = setup(); f.speech.enable(); f.speech.say(caption()); f.speech.say(caption('pending', SECOND)); const oldEnd = f.player.onended; f.speech.pause();
    expect(f.player.playing).toBe(false); expect(f.player.currentTime).toBe(0); expect(f.speech.getSnapshot()).toMatchObject({ enabled: true, currentCaption: null, pendingCount: 0, status: 'ready' });
    expect(f.speech.say(caption())).toBe(false); expect(f.speech.say(caption('pending', SECOND))).toBe(false); expect(f.speech.say(caption('future', SECOND))).toBe(true); oldEnd?.(); expect(f.speech.getSnapshot().currentCaption?.key).toBe('future'); f.speech.dispose();
  });

  it.each(['departure', 'activity change'] as const)('stops a current clip invalidated by %s and discards its queued follow-up', reason => {
    const f = setup(), actors = new Map([[4, { activity: 'talk' }], [5, { activity: 'talk' }]]);
    f.speech.enable(); f.speech.say(caption('current', FIRST, 4)); f.speech.say(caption('pending', SECOND, 5)); f.player.currentTime = 2.75;
    const oldEnd = f.player.onended, oldError = f.player.onerror;
    if (reason === 'departure') actors.delete(4); else actors.get(4)!.activity = 'rest';
    f.speech.retain(value => actors.get(value.actorId)?.activity === 'talk');
    expect(f.player.pause).toHaveBeenCalledTimes(1); expect(f.player.playing).toBe(false); expect(f.player.currentTime).toBe(0);
    expect(f.player.load).not.toHaveBeenCalled(); expect(f.player.removeAttribute).not.toHaveBeenCalled();
    expect(f.speech.getSnapshot()).toMatchObject({ enabled: true, speaking: false, status: 'ready', currentCaption: null, pendingCount: 0, seenKeys: 2 });
    f.speech.retain(value => actors.get(value.actorId)?.activity === 'talk'); expect(f.player.pause).toHaveBeenCalledTimes(1);
    expect(f.speech.say(caption('current', FIRST, 4))).toBe(false); expect(f.speech.say(caption('pending', SECOND, 5))).toBe(false);
    expect(f.speech.say(caption('future', SECOND, 5))).toBe(true); oldEnd?.(); oldError?.();
    expect(f.speech.getSnapshot()).toMatchObject({ speaking: true, currentCaption: caption('future', SECOND, 5), pendingCount: 0 });
    expect(f.player.playing).toBe(true); expect(f.player.play).toHaveBeenCalledTimes(2); f.speech.dispose();
  });

  it.each(['departure', 'activity change'] as const)('drops only a pending clip invalidated by %s without interrupting the current clip', reason => {
    const f = setup(), actors = new Map([[4, { activity: 'talk' }], [5, { activity: 'talk' }]]);
    f.speech.enable(); f.speech.say(caption('current', FIRST, 4)); f.speech.say(caption('pending', SECOND, 5)); f.player.currentTime = 2.75;
    const onend = f.player.onended;
    if (reason === 'departure') actors.delete(5); else actors.get(5)!.activity = 'sleep';
    f.speech.retain(value => actors.get(value.actorId)?.activity === 'talk');
    expect(f.player.pause).not.toHaveBeenCalled(); expect(f.player.playing).toBe(true); expect(f.player.currentTime).toBe(2.75); expect(f.player.onended).toBe(onend);
    expect(f.speech.getSnapshot()).toMatchObject({ enabled: true, speaking: true, currentCaption: caption('current', FIRST, 4), pendingCount: 0, seenKeys: 2 });
    f.player.end(); expect(f.player.play).toHaveBeenCalledTimes(1); expect(f.speech.getSnapshot()).toMatchObject({ speaking: false, currentCaption: null, pendingCount: 0 });
    actors.set(5, { activity: 'talk' }); expect(f.speech.say(caption('pending', SECOND, 5))).toBe(false); expect(f.speech.say(caption('future', SECOND, 5))).toBe(true); f.speech.dispose();
  });

  it('retains a valid current clip and queued partner in order without restarting playback', () => {
    const f = setup(), activeActors = new Set([4, 5]);
    f.speech.enable(); f.speech.say(caption('current', FIRST, 4)); f.speech.say(caption('pending', SECOND, 5)); f.player.currentTime = 2.75;
    f.speech.retain(value => activeActors.has(value.actorId));
    expect(f.player.pause).not.toHaveBeenCalled(); expect(f.player.currentTime).toBe(2.75); expect(f.speech.getSnapshot()).toMatchObject({ currentCaption: caption('current', FIRST, 4), pendingCount: 1, seenKeys: 2 });
    f.player.end(); expect(f.player.play).toHaveBeenCalledTimes(2); expect(f.speech.getSnapshot()).toMatchObject({ currentCaption: caption('pending', SECOND, 5), pendingCount: 0 }); f.speech.dispose();
  });

  it('retaining an empty, disabled or disposed controller never constructs media or enables playback', () => {
    const f = setup(), predicate = vi.fn(() => false);
    f.speech.retain(predicate); expect(predicate).not.toHaveBeenCalled(); expect(f.factory).not.toHaveBeenCalled(); expect(f.player.pause).not.toHaveBeenCalled();
    expect(f.speech.getSnapshot()).toMatchObject({ enabled: false, status: 'off', seenKeys: 0 });
    f.speech.dispose(); const paused = f.player.pause.mock.calls.length; f.speech.retain(predicate);
    expect(predicate).not.toHaveBeenCalled(); expect(f.player.pause).toHaveBeenCalledTimes(paused); expect(f.speech.getSnapshot().status).toBe('disposed');
  });

  it('ignores a rejected old play promise after its speaker becomes invalid and a fresh clip starts', async () => {
    const f = setup(), actors = new Map([[4, { activity: 'talk' }], [5, { activity: 'talk' }]]); let reject!: (error: Error) => void;
    f.player.play.mockImplementationOnce(() => new Promise<void>((_resolve, rejected) => { reject = rejected; }));
    f.speech.enable(); f.speech.say(caption('current', FIRST, 4)); f.speech.say(caption('pending', SECOND, 5)); actors.delete(4);
    f.speech.retain(value => actors.get(value.actorId)?.activity === 'talk'); expect(f.speech.say(caption('fresh', SECOND, 5))).toBe(true);
    reject(new Error('stale device rejection')); await Promise.resolve(); await Promise.resolve();
    expect(f.speech.getSnapshot()).toMatchObject({ enabled: true, speaking: true, currentCaption: caption('fresh', SECOND, 5), pendingCount: 0, lastPlayError: null });
    expect(f.player.playing).toBe(true); expect(f.player.play).toHaveBeenCalledTimes(2); f.speech.dispose();
  });

  it('turns off and releases the local source once, consumes off-era captions and re-enables only explicitly', () => {
    const f = setup(); f.speech.enable(); f.speech.say(caption()); f.speech.say(caption('pending', SECOND)); f.speech.off(); f.speech.off(); expect(f.player.pause).toHaveBeenCalledTimes(1); expect(f.player.removeAttribute).toHaveBeenCalledTimes(1); expect(f.player.load).toHaveBeenCalledTimes(1);
    expect(f.speech.getSnapshot()).toMatchObject({ enabled: false, currentCaption: null, pendingCount: 0, status: 'off' }); expect(f.speech.say(caption('off-era'))).toBe(false); expect(f.speech.enable()).toBe(true); expect(f.factory).toHaveBeenCalledTimes(1); expect(f.speech.say(caption('off-era'))).toBe(false); expect(f.speech.say(caption('pending', SECOND))).toBe(false); expect(f.speech.say(caption('new'))).toBe(true); f.speech.dispose();
  });

  it('disposes once, ignores stale events and can never play or enable afterward', () => {
    const f = setup(); f.speech.enable(); f.speech.say(caption()); f.speech.say(caption('pending', SECOND)); const stale = f.player.onerror; f.speech.dispose(); f.speech.dispose(); stale?.();
    expect(f.player.pause).toHaveBeenCalledTimes(1); expect(f.player.removeAttribute).toHaveBeenCalledTimes(1); expect(f.player.load).toHaveBeenCalledTimes(1); expect(f.speech.enable()).toBe(false); expect(f.speech.say(caption('future'))).toBe(false); expect(f.player.play).toHaveBeenCalledTimes(1); expect(f.speech.getSnapshot()).toMatchObject({ enabled: false, speaking: false, currentCaption: null, pendingCount: 0, status: 'disposed' });
  });

  it('moves from media error to the single pending caption and clears the current caption when the next ends', () => {
    const f = setup(); f.speech.enable(); f.speech.say(caption()); f.speech.say(caption('next', SECOND)); f.player.failMedia(); expect(f.player.play).toHaveBeenCalledTimes(2); expect(f.speech.getSnapshot().currentCaption?.key).toBe('next'); f.player.end(); expect(f.speech.getSnapshot().currentCaption).toBeNull(); f.speech.dispose();
  });

  it('handles rejected play promises as an error and continues only one unexpired pending caption', async () => {
    const f = setup(); let reject!: (error: Error) => void; f.player.play.mockImplementationOnce(() => new Promise<void>((_resolve, rejected) => { reject = rejected; })); f.speech.enable(); expect(f.speech.say(caption())).toBe(true); f.speech.say(caption('next', SECOND)); reject(new Error('local decoder failed')); await Promise.resolve(); await Promise.resolve();
    expect(f.player.play).toHaveBeenCalledTimes(2); expect(f.speech.getSnapshot()).toMatchObject({ currentCaption: caption('next', SECOND), pendingCount: 0, lastPlayError: 'Error' }); f.speech.dispose();
  });

  it('ignores an old rejected play promise after pause and a new current caption', async () => {
    const f = setup(); let reject!: (error: Error) => void; f.player.play.mockImplementationOnce(() => new Promise<void>((_resolve, rejected) => { reject = rejected; })); f.speech.enable(); f.speech.say(caption()); const staleError = f.player.onerror; f.speech.pause(); f.speech.say(caption('fresh', SECOND)); reject(new Error('stale rejection')); await Promise.resolve(); await Promise.resolve(); staleError?.();
    expect(f.speech.getSnapshot()).toMatchObject({ speaking: true, currentCaption: caption('fresh', SECOND), pendingCount: 0 }); expect(f.player.play).toHaveBeenCalledTimes(2); expect(f.player.playing).toBe(true); f.speech.dispose();
  });

  it('fails closed on factory or synchronous play failure and only retries creation on explicit enable', () => {
    const player = new LocalPlayer(), factory = vi.fn<() => HTMLAudioElement>().mockImplementationOnce(() => { throw new Error('no device'); }).mockImplementation(() => player as unknown as HTMLAudioElement), speech = createHomeClipSpeech(clips, factory);
    expect(speech.enable()).toBe(false); expect(speech.say(caption('unavailable'))).toBe(false); expect(factory).toHaveBeenCalledTimes(1); expect(speech.getSnapshot().status).toBe('unavailable'); expect(speech.enable()).toBe(true);
    player.play.mockImplementationOnce(() => { throw new Error('play failed'); }); expect(speech.say(caption('bad-play'))).toBe(false); expect(speech.getSnapshot().currentCaption).toBeNull(); expect(speech.say(caption('future'))).toBe(true); speech.dispose();
  });

  it('uses the native Audio factory lazily and never requests speech APIs, network helpers or timers', () => {
    const player = new LocalPlayer(), native = vi.fn(function () { return player; }), forbidden = vi.fn(() => { throw new Error('forbidden'); });
    vi.stubGlobal('Audio', native); vi.stubGlobal('fetch', forbidden); vi.stubGlobal('SpeechSynthesisUtterance', forbidden); vi.stubGlobal('speechSynthesis', { speak: forbidden }); vi.stubGlobal('setTimeout', forbidden); vi.stubGlobal('setInterval', forbidden);
    const speech = createHomeClipSpeech(clips); expect(native).not.toHaveBeenCalled(); expect(speech.enable()).toBe(true); expect(native).toHaveBeenCalledTimes(1); expect(speech.say(caption())).toBe(true); expect(player.src).toBe('/local-voices/first.wav'); expect(forbidden).not.toHaveBeenCalled(); speech.dispose();
  });

  it('rejects invalid keys, actor IDs and overlong configured captions without media work', () => {
    const f = setup(); f.speech.enable(); expect(f.speech.say(caption(''))).toBe(false); expect(f.speech.say(caption('x'.repeat(257)))).toBe(false); expect(f.speech.say(caption('invalid-actor', FIRST, NaN))).toBe(false); expect(f.player.play).not.toHaveBeenCalled(); f.speech.dispose();
    const long = setup({ ['字'.repeat(161)]: '/local-voices/long.wav' }); expect(long.speech.enable()).toBe(false); expect(long.factory).not.toHaveBeenCalled(); long.speech.dispose();
  });

  it('reports actual media time, paused state and duration with bounded errors that never include a URL', async () => {
    const f = setup(); expect(f.speech.getSnapshot().clipPlayback).toBeUndefined(); f.speech.enable(); expect(f.speech.getSnapshot()).toMatchObject({ clipPlayback: { paused: true, currentTime: 0, duration: 6.25, errorCode: null }, lastPlayError: null });
    f.speech.say(caption()); f.player.currentTime = 2.75; expect(f.speech.getSnapshot().clipPlayback).toEqual({ paused: false, currentTime: 2.75, duration: 6.25, errorCode: null });
    f.player.mediaError = { code: 3 }; f.player.failMedia(); expect(f.speech.getSnapshot()).toMatchObject({ speaking: false, clipPlayback: { paused: true, errorCode: 3 }, lastPlayError: 'media:3' });
    f.player.mediaError = null; f.player.duration = Infinity; f.player.play.mockRejectedValueOnce(Object.assign(new Error('https://private.example/path.wav'), { name: 'NotAllowedError' })); f.speech.say(caption('rejected')); await Promise.resolve(); await Promise.resolve();
    expect(f.speech.getSnapshot()).toMatchObject({ clipPlayback: { duration: null }, lastPlayError: 'NotAllowedError' }); expect(JSON.stringify(f.speech.getSnapshot())).not.toContain('private.example');
    f.player.play.mockRejectedValueOnce({ name: 'https://private.example/also.wav' }); f.speech.say(caption('opaque')); await Promise.resolve(); await Promise.resolve(); expect(f.speech.getSnapshot().lastPlayError).toBe('PlaybackError'); f.speech.dispose();
  });
});
