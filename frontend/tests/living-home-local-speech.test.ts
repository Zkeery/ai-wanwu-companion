import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHomeLocalSpeech, type HomeLocalSpeechHost } from '@/lib/living-home-local-speech';

function voice(name: string, lang = 'zh-CN', localService = true, preferred = false): SpeechSynthesisVoice {
  return { name, lang, localService, default: preferred, voiceURI: name };
}
function setup(initial = [voice('本地中文')]) {
  let voices = initial;
  const listeners = new Set<EventListenerOrEventListenerObject>(), utterances: SpeechSynthesisUtterance[] = [];
  const synthesis = {
    speaking: false, pending: false,
    getVoices: vi.fn(() => voices), speak: vi.fn((utterance: SpeechSynthesisUtterance) => { synthesis.speaking = true; utterances.push(utterance); }),
    cancel: vi.fn(() => { synthesis.speaking = false; synthesis.pending = false; }),
    addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => { listeners.add(listener); }),
    removeEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => { listeners.delete(listener); }),
  };
  const createUtterance = vi.fn((text: string) => ({ text, voice: null, lang: '', pitch: 1, rate: 1, volume: 1, onend: null, onerror: null }) as unknown as SpeechSynthesisUtterance);
  const host: HomeLocalSpeechHost = { synthesis: synthesis as unknown as HomeLocalSpeechHost['synthesis'], createUtterance };
  return {
    host, synthesis, utterances, createUtterance, audio: createHomeLocalSpeech(host), listeners,
    setVoices(next: SpeechSynthesisVoice[]) { voices = next; },
    changed() { for (const listener of [...listeners]) { const event = new Event('voiceschanged'); if (typeof listener === 'function') listener(event); else listener.handleEvent(event); } },
    finish(index = utterances.length - 1, error = false) { const utterance = utterances[index]; synthesis.speaking = false; (error ? utterance.onerror : utterance.onend)?.call(utterance, {} as SpeechSynthesisEvent & SpeechSynthesisErrorEvent); },
  };
}
const caption = (key = 'new-caption', actorId = 4, text = '太阳暖暖的，去院子走一走吧。') => ({ key, actorId, text });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('explicit opt-in local Chinese caption speech', () => {
  it('does not inspect a service, construct an utterance or speak until explicit enable, and consumes captions seen while off', () => {
    const f = setup(); expect(f.audio.getSnapshot()).toMatchObject({ enabled: false, speaking: false, status: 'off', localOnly: true });
    expect(f.audio.say(caption('old'))).toBe(false); expect(f.synthesis.getVoices).not.toHaveBeenCalled(); expect(f.createUtterance).not.toHaveBeenCalled(); expect(f.synthesis.speak).not.toHaveBeenCalled();
    expect(f.audio.enable()).toBe(true); expect(f.audio.say(caption('old'))).toBe(false); expect(f.audio.say(caption('fresh'))).toBe(true); expect(f.synthesis.speak).toHaveBeenCalledTimes(1); f.audio.dispose();
  });

  it('never falls back to remote Chinese, local non-Chinese or a truthy non-boolean local flag', () => {
    const f = setup([voice('远程中文', 'zh-CN', false), voice('Local English', 'en-US'), { ...voice('假本地'), localService: 1 } as unknown as SpeechSynthesisVoice]);
    expect(f.audio.enable()).toBe(false); expect(f.audio.getSnapshot()).toMatchObject({ enabled: false, available: false, status: 'unavailable', voiceName: null });
    expect(f.audio.say(caption())).toBe(false); expect(f.createUtterance).not.toHaveBeenCalled(); expect(f.synthesis.speak).not.toHaveBeenCalled(); f.audio.dispose();
  });

  it('selects an actual local Chinese voice, bounds text by 160 characters and uses moderate actor pitch with natural rate', () => {
    const selected = voice('普通话本地'), f = setup([voice('Remote default', 'zh-CN', false, true), voice('粵語', 'zh-HK'), selected]);
    expect(f.audio.enable()).toBe(true); const text = '你好🙂'.repeat(100); expect(f.audio.say(caption('even', 4, '  ' + text + '\n '))).toBe(true);
    const even = f.utterances[0]; expect(even.voice).toBe(selected); expect(even.lang).toBe('zh-CN'); expect(Array.from(even.text)).toHaveLength(160); expect(even.text).toBe(Array.from(text).slice(0, 160).join(''));
    expect(even.rate).toBe(1); expect(even.volume).toBe(1); expect(even.pitch).toBeGreaterThanOrEqual(.9); expect(even.pitch).toBeLessThanOrEqual(1.1);
    f.finish(); expect(f.audio.say(caption('odd', 5))).toBe(true); expect(f.utterances[1].pitch).not.toBe(even.pitch); expect(f.utterances[1].pitch).toBeGreaterThanOrEqual(.9); expect(f.utterances[1].pitch).toBeLessThanOrEqual(1.1); f.audio.dispose();
  });

  it('accepts local zh script or regional languages and respects the local default when Mandarin is absent', () => {
    const selected = voice('本地繁體', 'zh-TW', true, true), f = setup([voice('本地香港', 'zh-HK'), selected, voice('日語', 'ja-JP')]);
    expect(f.audio.enable()).toBe(true); expect(f.audio.say(caption())).toBe(true); expect(f.utterances[0].voice).toBe(selected); f.audio.dispose();
    const script = setup([voice('本地简体', 'zh-Hans')]); expect(script.audio.enable()).toBe(true); expect(script.audio.say(caption())).toBe(true); expect(script.utterances[0].lang).toBe('zh-Hans'); script.audio.dispose();
  });

  it('speaks two partners in order with just one pending caption, drops overflow and never repeats consumed keys', () => {
    const f = setup(); f.audio.enable(); expect(f.audio.say(caption('first'))).toBe(true); expect(f.audio.say(caption('first', 5, '不同文字也不重复读'))).toBe(false); expect(f.audio.say(caption('second', 5))).toBe(true); expect(f.audio.say(caption('second', 5))).toBe(false); expect(f.audio.say(caption('overflow'))).toBe(false);
    expect(f.createUtterance).toHaveBeenCalledTimes(1); expect(f.audio.getSnapshot()).toMatchObject({ currentCaption: caption('first'), pendingCount: 1 });
    f.finish(); expect(f.audio.getSnapshot()).toMatchObject({ speaking: true, currentCaption: caption('second', 5), pendingCount: 0 }); expect(f.synthesis.speak).toHaveBeenCalledTimes(2);
    f.finish(); expect(f.audio.getSnapshot()).toMatchObject({ speaking: false, currentCaption: null, pendingCount: 0 }); expect(f.audio.say(caption('second', 5))).toBe(false); expect(f.audio.say(caption('overflow'))).toBe(false); expect(f.audio.say(caption('future'))).toBe(true); expect(f.synthesis.speak).toHaveBeenCalledTimes(3); f.audio.dispose();
  });

  it('expires a pending caption after eight seconds and never catches it up after completion or error', () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000); const f = setup(); f.audio.enable(); f.audio.say(caption('first')); expect(f.audio.say(caption('expired'))).toBe(true);
    vi.setSystemTime(18_001); f.finish(); expect(f.synthesis.speak).toHaveBeenCalledTimes(1); expect(f.audio.getSnapshot()).toMatchObject({ speaking: false, currentCaption: null, pendingCount: 0 }); expect(f.audio.say(caption('expired'))).toBe(false);
    f.audio.say(caption('next')); f.audio.say(caption('error-followup', 5)); vi.setSystemTime(20_000); f.finish(1, true); expect(f.synthesis.speak).toHaveBeenCalledTimes(3); expect(f.audio.getSnapshot().currentCaption?.key).toBe('error-followup'); f.audio.dispose();
  });

  it('does not queue behind another device utterance or pending browser speech', () => {
    const f = setup(); f.audio.enable(); f.synthesis.speaking = true; expect(f.audio.say(caption('external'))).toBe(false); f.synthesis.speaking = false; f.synthesis.pending = true; expect(f.audio.say(caption('pending'))).toBe(false);
    f.synthesis.pending = false; expect(f.audio.say(caption('external'))).toBe(false); expect(f.audio.say(caption('fresh'))).toBe(true); expect(f.synthesis.speak).toHaveBeenCalledTimes(1); f.audio.dispose();
  });

  it('cancels immediately on pause, preserves consumed keys and explicit opt-in, and only speaks a future caption', () => {
    const f = setup(); f.audio.enable(); f.audio.say(caption('paused')); f.audio.say(caption('pending')); const oldEnd = f.utterances[0].onend; f.audio.pause();
    expect(f.synthesis.cancel).toHaveBeenCalledTimes(1); expect(f.audio.getSnapshot()).toMatchObject({ enabled: true, speaking: false, status: 'ready', currentCaption: null, pendingCount: 0 }); expect(f.audio.say(caption('paused'))).toBe(false); expect(f.audio.say(caption('pending'))).toBe(false);
    expect(f.audio.say(caption('resumed'))).toBe(true); oldEnd?.call(f.utterances[0], {} as SpeechSynthesisEvent); expect(f.audio.getSnapshot().speaking).toBe(true); expect(f.synthesis.speak).toHaveBeenCalledTimes(2); f.audio.dispose();
  });

  it.each(['departure', 'activity change'] as const)('cancels a current caption invalidated by %s and discards its queued follow-up', reason => {
    const f = setup(), actors = new Map([[4, { activity: 'talk' }], [5, { activity: 'talk' }]]);
    f.audio.enable(); f.audio.say(caption('current', 4)); f.audio.say(caption('pending', 5));
    const oldEnd = f.utterances[0].onend, oldError = f.utterances[0].onerror;
    if (reason === 'departure') actors.delete(4); else actors.get(4)!.activity = 'rest';
    f.audio.retain(value => actors.get(value.actorId)?.activity === 'talk');
    expect(f.synthesis.cancel).toHaveBeenCalledTimes(1);
    expect(f.audio.getSnapshot()).toMatchObject({ enabled: true, speaking: false, status: 'ready', currentCaption: null, pendingCount: 0, seenKeys: 2 });
    f.audio.retain(value => actors.get(value.actorId)?.activity === 'talk'); expect(f.synthesis.cancel).toHaveBeenCalledTimes(1);
    expect(f.audio.say(caption('current', 4))).toBe(false); expect(f.audio.say(caption('pending', 5))).toBe(false);
    expect(f.audio.say(caption('future', 5))).toBe(true);
    oldEnd?.call(f.utterances[0], {} as SpeechSynthesisEvent); oldError?.call(f.utterances[0], {} as SpeechSynthesisErrorEvent);
    expect(f.audio.getSnapshot()).toMatchObject({ speaking: true, currentCaption: caption('future', 5), pendingCount: 0 });
    expect(f.synthesis.speak).toHaveBeenCalledTimes(2); f.audio.dispose();
  });

  it.each(['departure', 'activity change'] as const)('drops only a pending caption invalidated by %s while its valid current speaker continues', reason => {
    const f = setup(), actors = new Map([[4, { activity: 'talk' }], [5, { activity: 'talk' }]]);
    f.audio.enable(); f.audio.say(caption('current', 4)); f.audio.say(caption('pending', 5));
    const current = f.utterances[0], onend = current.onend;
    if (reason === 'departure') actors.delete(5); else actors.get(5)!.activity = 'sleep';
    f.audio.retain(value => actors.get(value.actorId)?.activity === 'talk');
    expect(f.synthesis.cancel).not.toHaveBeenCalled(); expect(current.onend).toBe(onend);
    expect(f.audio.getSnapshot()).toMatchObject({ enabled: true, speaking: true, currentCaption: caption('current', 4), pendingCount: 0, seenKeys: 2 });
    f.finish(); expect(f.synthesis.speak).toHaveBeenCalledTimes(1); expect(f.audio.getSnapshot()).toMatchObject({ speaking: false, currentCaption: null, pendingCount: 0 });
    actors.set(5, { activity: 'talk' }); expect(f.audio.say(caption('pending', 5))).toBe(false); expect(f.audio.say(caption('future', 5))).toBe(true); f.audio.dispose();
  });

  it('retains a valid current speaker and queued partner in order without cancelling either', () => {
    const f = setup(), activeActors = new Set([4, 5]);
    f.audio.enable(); f.audio.say(caption('current', 4)); f.audio.say(caption('pending', 5));
    f.audio.retain(value => activeActors.has(value.actorId));
    expect(f.synthesis.cancel).not.toHaveBeenCalled(); expect(f.audio.getSnapshot()).toMatchObject({ currentCaption: caption('current', 4), pendingCount: 1, seenKeys: 2 });
    f.finish(); expect(f.synthesis.speak).toHaveBeenCalledTimes(2); expect(f.audio.getSnapshot()).toMatchObject({ currentCaption: caption('pending', 5), pendingCount: 0 }); f.audio.dispose();
  });

  it('retaining an empty, disabled or disposed controller never enables or inspects speech', () => {
    const f = setup(), predicate = vi.fn(() => false);
    f.audio.retain(predicate); expect(predicate).not.toHaveBeenCalled(); expect(f.synthesis.getVoices).not.toHaveBeenCalled(); expect(f.synthesis.cancel).not.toHaveBeenCalled();
    expect(f.audio.getSnapshot()).toMatchObject({ enabled: false, status: 'off', seenKeys: 0 });
    f.audio.dispose(); const cancelled = f.synthesis.cancel.mock.calls.length; f.audio.retain(predicate);
    expect(predicate).not.toHaveBeenCalled(); expect(f.synthesis.cancel).toHaveBeenCalledTimes(cancelled); expect(f.audio.getSnapshot().status).toBe('disposed');
  });

  it('turns off without replay, detaches voice listeners and disposes once without accepting future work', () => {
    const f = setup(); f.audio.enable(); f.audio.say(caption('first')); f.audio.say(caption('pending')); f.audio.off(); f.audio.off(); expect(f.synthesis.cancel).toHaveBeenCalledTimes(1); expect(f.audio.getSnapshot()).toMatchObject({ enabled: false, speaking: false, status: 'off', currentCaption: null, pendingCount: 0 });
    expect(f.audio.say(caption('while-off'))).toBe(false); f.audio.enable(); expect(f.audio.say(caption('first'))).toBe(false); expect(f.audio.say(caption('pending'))).toBe(false); expect(f.audio.say(caption('while-off'))).toBe(false); expect(f.audio.say(caption('fresh'))).toBe(true);
    f.audio.dispose(); f.audio.dispose(); expect(f.synthesis.cancel).toHaveBeenCalledTimes(2); expect(f.audio.enable()).toBe(false); expect(f.audio.say(caption('disposed'))).toBe(false); expect(f.audio.getSnapshot()).toMatchObject({ enabled: false, available: false, speaking: false, disposed: true, status: 'disposed' });
  });

  it('rechecks voices once after explicit enable and never automatically speaks an unavailable-era caption', () => {
    const f = setup([]); expect(f.audio.enable()).toBe(false); expect(f.listeners.size).toBe(1); expect(f.audio.say(caption('past'))).toBe(false);
    f.setVoices([voice('迟到的本地中文')]); f.changed(); expect(f.synthesis.getVoices).toHaveBeenCalledTimes(2); expect(f.listeners.size).toBe(0); expect(f.audio.getSnapshot()).toMatchObject({ enabled: true, available: true, status: 'ready' });
    expect(f.synthesis.speak).not.toHaveBeenCalled(); expect(f.audio.say(caption('past'))).toBe(false); expect(f.audio.say(caption('future'))).toBe(true); f.changed(); expect(f.synthesis.getVoices).toHaveBeenCalledTimes(2); f.audio.dispose();
  });

  it('remains unavailable after one remote-only voices event and cannot be enabled by stale events after off or dispose', () => {
    const f = setup([]); f.audio.enable(); f.setVoices([voice('远程中文', 'zh-CN', false)]); f.changed(); f.setVoices([voice('本地中文')]); f.changed(); expect(f.audio.getSnapshot().status).toBe('unavailable'); expect(f.synthesis.speak).not.toHaveBeenCalled();
    const off = setup([]); off.audio.enable(); const stale = [...off.listeners][0] as EventListener; off.audio.off(); off.setVoices([voice('本地中文')]); stale(new Event('voiceschanged')); expect(off.audio.getSnapshot().enabled).toBe(false); expect(off.listeners.size).toBe(0);
    const disposed = setup([]); disposed.audio.enable(); const staleDisposed = [...disposed.listeners][0] as EventListener; disposed.audio.dispose(); disposed.setVoices([voice('本地中文')]); staleDisposed(new Event('voiceschanged')); expect(disposed.audio.getSnapshot().enabled).toBe(false); expect(disposed.listeners.size).toBe(0); f.audio.dispose(); off.audio.dispose();
  });

  it('releases speech after completion or error and fails closed when local utterance construction or speaking throws', () => {
    const f = setup(); f.audio.enable(); f.audio.say(caption('error')); f.finish(0, true); expect(f.audio.getSnapshot().speaking).toBe(false); expect(f.audio.say(caption('next'))).toBe(true); f.finish();
    f.createUtterance.mockImplementationOnce(() => { throw new Error('local constructor failed'); }); expect(f.audio.say(caption('bad-constructor'))).toBe(false); expect(f.audio.getSnapshot().speaking).toBe(false);
    f.synthesis.speak.mockImplementationOnce(() => { throw new Error('device unavailable'); }); expect(f.audio.say(caption('bad-speak'))).toBe(false); expect(f.audio.getSnapshot().speaking).toBe(false); expect(f.audio.say(caption('future'))).toBe(true); f.audio.dispose();
  });

  it('rejects blank, invalid and duplicate input without creating an utterance, fetching, recording or scheduling timers', () => {
    const f = setup(); f.audio.enable(); const network = vi.fn(() => { throw new Error('network forbidden'); }), timers = vi.fn(() => { throw new Error('timer forbidden'); }); vi.stubGlobal('fetch', network); vi.stubGlobal('setTimeout', timers); vi.stubGlobal('setInterval', timers);
    expect(f.audio.say(caption('', 4))).toBe(false); expect(f.audio.say(caption('x'.repeat(257)))).toBe(false); expect(f.audio.say(caption('blank', 4, ' \n '))).toBe(false); expect(f.audio.say(caption('invalid-actor', NaN))).toBe(false);
    expect(f.audio.say(caption('valid', 4, '你好\n  今天真好。'))).toBe(true); expect(f.utterances[0].text).toBe('你好 今天真好。'); expect(network).not.toHaveBeenCalled(); expect(timers).not.toHaveBeenCalled(); f.audio.dispose();
  });

  it('accesses native browser speech lazily and also works when no browser or local service exists', () => {
    const f = setup(), synthesis = vi.fn(() => f.synthesis), constructor = vi.fn(function (text: string) { return f.host.createUtterance(text); });
    vi.stubGlobal('window', { get speechSynthesis() { return synthesis(); }, SpeechSynthesisUtterance: constructor });
    const audio = createHomeLocalSpeech(); expect(synthesis).not.toHaveBeenCalled(); expect(constructor).not.toHaveBeenCalled(); expect(audio.enable()).toBe(true); expect(audio.say(caption())).toBe(true); expect(constructor).toHaveBeenCalledTimes(1); expect(f.utterances[0].voice?.localService).toBe(true); audio.dispose();
    vi.stubGlobal('window', undefined); const absent = createHomeLocalSpeech(); expect(absent.enable()).toBe(false); expect(absent.getSnapshot().status).toBe('unavailable'); expect(absent.say(caption())).toBe(false); absent.dispose();
    const optOut = createHomeLocalSpeech(null); expect(optOut.enable()).toBe(false); expect(optOut.say(caption())).toBe(false); optOut.dispose();
  });
});
