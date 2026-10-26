import { describe, expect, it, vi } from 'vitest';
import { createHomeAudio, HOME_AUDIO_PROFILES, synthesizeHomeAudioSamples, type HomeAudioActor, type HomeAudioArea } from '../lib/living-home-audio';
import { sampleHomeAmbience, sampleHomeExtraAudio, sampleHomeOutdoorAudio, type HomeAmbientSound } from '../lib/living-home-ambience';

class Node {
  disconnected = 0; connections: unknown[] = [];
  connect(target: unknown) { this.connections.push(target); return target; }
  disconnect() { this.disconnected++; this.connections = []; }
}
class Source extends Node {
  buffer: AudioBuffer | null = null; loop = false; onended: (() => void) | null = null;
  started: number | null = null; stops = 0; ended = false;
  start(when: number) { this.started = when; }
  stop() { this.stops++; }
  end() { if (this.ended) return; this.ended = true; this.onended?.(); }
}
class Context {
  state: AudioContextState = 'suspended'; sampleRate = 8000; currentTime = 0;
  destination = new Node(); sources: Source[] = []; buffers = 0; closeCalls = 0; resumeCalls = 0;
  async resume() { this.resumeCalls++; this.state = 'running'; }
  async close() { this.closeCalls++; this.state = 'closed'; }
  createBuffer(channels: number, length: number, rate: number) {
    this.buffers++; const data = new Float32Array(length);
    return { numberOfChannels: channels, length, sampleRate: rate, duration: length / rate, getChannelData: () => data } as unknown as AudioBuffer;
  }
  createBufferSource() { const source = new Source(); this.sources.push(source); return source; }
  createBiquadFilter() { return Object.assign(new Node(), { type: 'lowpass', frequency: { value: 0 }, Q: { value: 0 } }); }
  createGain() { return Object.assign(new Node(), { gain: { value: 0 } }); }
  advance(time: number) {
    this.currentTime = time;
    for (const source of this.sources) if (!source.loop && source.started !== null && !source.stops
      && source.started + (source.buffer?.duration ?? 0) <= time) source.end();
  }
}
function setup() {
  const context = new Context(), factory = vi.fn(() => context as unknown as AudioContext), audio = createHomeAudio(factory);
  const tick = (time: number, actors: readonly HomeAudioActor[] = [], area: HomeAudioArea | null = 'outdoor') => { context.advance(time); audio.tick(time, actors, area); };
  const kind = (source: Source) => (Object.entries(HOME_AUDIO_PROFILES).find(([, p]) => Math.abs(p.duration - (source.buffer?.duration ?? 0)) < .0002)?.[0]);
  const started = (type: HomeAmbientSound) => context.sources.filter(s => s.started !== null && kind(s) === type);
  return { context, factory, audio, tick, kind, started };
}
const newKinds: HomeAmbientSound[] = ['tile', 'wind', 'bird', 'pour', 'cup', 'step', 'door-open', 'door-close'];
describe('optional local home soundscape', () => {
  it.each(newKinds)('has deterministic finite bounded %s waveform with nonzero energy and soft edges', kind => {
    const a = synthesizeHomeAudioSamples(kind, 44100, 7), b = synthesizeHomeAudioSamples(kind, 44100, 7);
    expect(a).toEqual(b); expect(a.length).toBe(Math.ceil(HOME_AUDIO_PROFILES[kind].duration * 44100));
    let peak = 0, sum = 0, square = 0;
    for (const value of a) { expect(Number.isFinite(value)).toBe(true); peak = Math.max(peak, Math.abs(value)); sum += value; square += value * value; }
    expect(peak).toBeGreaterThan(.05); expect(peak).toBeLessThan(1);
    expect(Math.sqrt(square / a.length)).toBeGreaterThan(.005); expect(Math.abs(sum / a.length)).toBeLessThan(.025);
    expect(Math.abs(a[0])).toBeLessThan(.002); expect(Math.abs(a[a.length - 1])).toBeLessThan(.025);
  });
  it('does not construct or resume anything before the explicit enable click', async () => {
    const { audio, factory, context, tick } = setup(); audio.setEnabled(true); tick(0);
    expect(audio.triggerDoor('main', true)).toBe(false); expect(factory).not.toHaveBeenCalled();
    expect(await audio.enable()).toBe(true); expect(context.resumeCalls).toBe(1);
    tick(0); expect(audio.getSnapshot().ambientActive).toBe(true); expect(context.buffers).toBe(1); audio.dispose();
  });
  it('starts a quiet cached outdoor bed immediately, sparse birds only outside, and never rebuilds noise per frame', async () => {
    const { audio, tick, started, context } = setup(); await audio.enable(); tick(0);
    for (let i = 1; i <= 239; i++) tick(i / 100);
    expect(started('wind')).toHaveLength(1); expect(started('bird')).toHaveLength(0); expect(context.buffers).toBe(1);
    tick(2.4); expect(started('bird')).toHaveLength(1); for (let i = 0; i < 30; i++) tick(2.4);
    expect(started('bird')).toHaveLength(1); expect(context.buffers).toBe(2);
    tick(2.41, [], 'indoor'); expect(audio.getSnapshot().ambientActive).toBe(false); expect(started('wind')[0].stops).toBe(1);
    expect(started('bird')[0].stops).toBe(1); tick(2.42, [], 'bedroom'); expect(audio.getSnapshot().activeVoices).toBe(0); audio.dispose();
  });
  it('plays a new tea pour promptly then a cup clink and only makes steps while moving', async () => {
    const { audio, tick, started } = setup(); await audio.enable(); const tea = [{ actorId: 1, activity: 'tea' }];
    tick(0, tea, 'indoor'); for (let i = 1; i <= 70; i++) tick(i / 100, tea, 'indoor');
    expect(started('pour')).toHaveLength(1); expect(started('pour')[0].started).toBeLessThan(.6);
    for (let i = 71; i <= 1000; i++) tick(i / 100, tea, 'indoor'); expect(started('cup')).toHaveLength(1);
    const stationary = [{ actorId: 2, activity: 'walk', moving: false }];
    for (let i = 1001; i <= 1100; i++) tick(i / 100, stationary);
    expect(started('step')).toHaveLength(0);
    for (let i = 1101; i <= 1170; i++) tick(i / 100, [{ ...stationary[0], moving: true }]);
    expect(started('step').length).toBeGreaterThan(0);
    tick(11.71, stationary); const liveSteps = started('step').filter(s => !s.stops && !s.ended); expect(liveSteps).toHaveLength(0); audio.dispose();
  });
  it('keeps tea and walking silent for legacy two-argument callers', async () => {
    const { audio, context } = setup(); await audio.enable();
    for (let i = 0; i < 300; i++) { context.advance(i / 100); audio.tick(i / 100, [{ actorId: 1, activity: 'tea' }, { actorId: 2, activity: 'walk' }]); }
    expect(context.sources).toHaveLength(0); expect(audio.getSnapshot().cachedBuffers).toBe(0); audio.dispose();
  });
  it('deduplicates changed door targets, refuses paused or stale events, and never queues retries', async () => {
    const { audio, tick, context, started } = setup(); await audio.enable(); tick(0, [], 'indoor');
    expect(audio.triggerDoor('main', true)).toBe(true); expect(audio.triggerDoor('main', true)).toBe(false);
    expect(started('door-open')).toHaveLength(1); expect(audio.triggerDoor('main', false)).toBe(true);
    expect(started('door-open')[0].stops).toBe(1); expect(started('door-close')).toHaveLength(1);
    audio.pause(); expect(audio.triggerDoor('room', true)).toBe(false); tick(20, [], 'indoor');
    expect(started('door-open')).toHaveLength(1); context.advance(21); expect(audio.triggerDoor('room', true)).toBe(false);
    tick(21, [], 'indoor'); expect(started('door-open')).toHaveLength(1); expect(audio.triggerDoor('room', true)).toBe(true);
    audio.setEnabled(false); expect(audio.triggerDoor('room', false)).toBe(false); expect(context.closeCalls).toBe(1); audio.dispose();
  });
  it('synchronizes silent out-of-area door changes without constructing audio or suppressing the next audible change', async () => {
    const { audio, factory, context, tick, started } = setup();
    audio.syncDoorState('main', true); expect(factory).not.toHaveBeenCalled(); expect(context.sources).toHaveLength(0);
    await audio.enable(); tick(0, [], 'indoor');
    expect(audio.triggerDoor('main', false)).toBe(true);
    audio.syncDoorState('main', true); expect(started('door-open')).toHaveLength(0);
    expect(audio.triggerDoor('main', false)).toBe(true); expect(started('door-close')).toHaveLength(2);
    audio.pause(); audio.syncDoorState('room', true); expect(audio.triggerDoor('room', false)).toBe(false);
    tick(20, [], 'indoor'); expect(started('door-open')).toHaveLength(0);
    expect(audio.triggerDoor('room', false)).toBe(true);
    audio.setEnabled(false); const count = context.sources.length; audio.syncDoorState('main', true);
    expect(context.sources).toHaveLength(count); audio.dispose();
  });
  it('stops everything on pause and rebases frozen, backward or large elapsed jumps without historical cues', async () => {
    const { audio, tick, context, started } = setup(); await audio.enable(); const tea = [{ actorId: 1, activity: 'tea' }];
    tick(0, tea); for (let i = 1; i <= 55; i++) tick(i / 100, tea);
    expect(started('pour')).toHaveLength(1); audio.pause(); expect(audio.getSnapshot().activeVoices).toBe(0); expect(audio.getSnapshot().ambientActive).toBe(false);
    const before = context.sources.filter(s => !s.loop).length; tick(100, tea); tick(100, tea); tick(1, tea); tick(10000, tea);
    expect(context.sources.filter(s => !s.loop)).toHaveLength(before); expect(context.closeCalls).toBe(0);
    tick(Number.NaN, tea); expect(audio.getSnapshot().ambientActive).toBe(false); expect(audio.triggerDoor('main', true)).toBe(false); audio.dispose();
  });
  it('caps dense soundscapes at four short sounds plus one bed and reliably releases all nodes and cached buffers', async () => {
    const { audio, tick, context } = setup(); await audio.enable();
    const actors = Array.from({ length: 20 }, (_, i) => ({ actorId: i + 1, activity: 'walk', moving: true }));
    for (let i = 0; i <= 1500; i++) { tick(i / 100, actors); if (i % 31 === 0) audio.triggerDoor('main', i % 62 === 0);
      expect(audio.getSnapshot().activeVoices).toBeLessThanOrEqual(4); expect(audio.getSnapshot().cachedBuffers).toBeLessThanOrEqual(32);
      expect(context.sources.filter(s => s.loop && !s.stops && !s.ended).length).toBeLessThanOrEqual(1); }
    audio.setEnabled(false); expect(audio.getSnapshot().activeVoices).toBe(0); expect(audio.getSnapshot().cachedBuffers).toBe(0); expect(audio.getSnapshot().ambientActive).toBe(false);
    expect(context.sources.every(s => s.disconnected === 1)).toBe(true); expect(context.sources.every(s => s.stops === 1 || s.ended)).toBe(true);
    audio.dispose(); expect(context.closeCalls).toBe(1);
  });
  it('aligns a mahjong assignment beginning at global t=37 with both relative grab and release contacts', async () => {
    const { audio, tick, started } = setup(); await audio.enable();
    const actors = [{ actorId: 6, activity: 'mahjong', startedAtElapsed: 37 }];
    tick(37, actors, 'indoor'); const expected = new Map<number, number>();
    for (let frame = 1; frame <= 700; frame++) {
      const relative = frame / 100, cue = sampleHomeAmbience('mahjong', relative, 6).audio;
      if (cue && !expected.has(cue.episode)) expected.set(cue.episode, 37 + cue.startedAt);
      tick(37 + relative, actors, 'indoor');
    }
    const sounds = started('tile'); expect(sounds).toHaveLength(expected.size); expect(sounds.length).toBeGreaterThanOrEqual(2);
    [...expected.values()].forEach((time, index) => { expect(sounds[index].started).toBeGreaterThanOrEqual(time - 1e-9); expect(sounds[index].started! - time).toBeLessThan(.011); });
    expect(sounds[0].started).toBeGreaterThan(38); audio.dispose();
  });
  it('clears voices when assignment origin changes, rebases mid-contact without replay and shares the tea clock', async () => {
    const { audio, tick, started } = setup(); await audio.enable(); let actors = [{ actorId: 6, activity: 'mahjong', startedAtElapsed: 37 }];
    tick(37, actors, 'indoor'); let relativeContact = 0;
    for (let i = 0; i <= 600; i++) if (sampleHomeAmbience('mahjong', i / 100, 6).audio) { relativeContact = i / 100; break; }
    for (let i = 1; i <= Math.round(relativeContact * 100) + 2; i++) tick(37 + i / 100, actors, 'indoor');
    expect(started('tile')).toHaveLength(1); const first = started('tile')[0], now = 37 + relativeContact + .02;
    actors = [{ ...actors[0], startedAtElapsed: now - relativeContact - .04 }];
    tick(now + .01, actors, 'indoor'); expect(first.stops).toBe(1); tick(now + .02, actors, 'indoor'); expect(started('tile')).toHaveLength(1);
    const tea = [{ actorId: 1, activity: 'tea', startedAtElapsed: 50 }]; tick(50, tea, 'indoor');
    for (let i = 1; i <= 70; i++) tick(50 + i / 100, tea, 'indoor');
    expect(started('pour')).toHaveLength(1); expect(started('pour')[0].started).toBeGreaterThan(50.4); expect(started('pour')[0].started).toBeLessThan(50.6);
    audio.dispose();
  });
  it('consumes failed source starts once with no tick retry or resource leaks', async () => {
    const { audio, context, tick } = setup(); await audio.enable(); tick(0, [], 'indoor');
    const original = context.createBufferSource.bind(context);
    context.createBufferSource = () => { const source = original(); source.start = () => { throw new Error('synthetic start failure'); }; return source; };
    expect(audio.triggerDoor('main', true)).toBe(false); expect(audio.triggerDoor('main', true)).toBe(false); expect(context.sources).toHaveLength(1);
    expect(context.sources[0].stops).toBe(1); expect(context.sources[0].disconnected).toBe(1); tick(.1, [], 'indoor'); expect(context.sources).toHaveLength(1); audio.dispose();
  });
});
describe('extra presentation clocks', () => {
  it('contains no wall-clock catchup and accepts only finite valid actors', () => {
    for (const elapsed of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(sampleHomeExtraAudio('tea', elapsed, 1)).toBeNull(); expect(sampleHomeOutdoorAudio(elapsed)).toBeNull(); }
    for (const id of [0, -1, 1.5, Number.NaN]) expect(sampleHomeExtraAudio('walk', 2, id)).toBeNull();
    expect(sampleHomeExtraAudio('unknown', 2, 1)).toBeNull();
  });
  it('uses unique deterministic episodes for local pour, cup, steps and sparse birds', () => {
    for (const activity of ['tea', 'walk']) {
      const events = new Map<string, number>();
      for (let i = 0; i <= 3000; i++) { const t = i / 100, cue = sampleHomeExtraAudio(activity, t, 6);
        expect(cue).toEqual(sampleHomeExtraAudio(activity, t, 6)); if (cue) { const key = cue.kind + ':' + cue.episode;
          if (events.has(key)) expect(events.get(key)).toBe(cue.startedAt); events.set(key, cue.startedAt); expect(cue.progress).toBeGreaterThanOrEqual(0); expect(cue.progress).toBeLessThan(1); } }
      expect(events.size).toBeGreaterThan(activity === 'tea' ? 3 : 30);
    }
    expect(sampleHomeOutdoorAudio(2.4)?.kind).toBe('bird'); expect(sampleHomeOutdoorAudio(2.39)).toBeNull(); expect(sampleHomeOutdoorAudio(4)).toBeNull();
  });
});
