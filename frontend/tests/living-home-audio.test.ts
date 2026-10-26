import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHomeAudio, HOME_AUDIO_ORIGIN, type HomeAudioActor } from '../lib/living-home-audio';
import { sampleHomeAmbience, type HomeAmbientSound } from '../lib/living-home-ambience';

class MockNode {
  connections: unknown[] = []; disconnected = 0;
  connect(value: unknown) { this.connections.push(value); return value; }
  disconnect() { this.disconnected++; this.connections = []; }
}
class MockSource extends MockNode {
  buffer: { getChannelData(channel: number): Float32Array } | null = null;
  onended: (() => void) | null = null; starts = 0; stops = 0;
  start() { this.starts++; }
  stop() { this.stops++; }
  end() { this.onended?.(); }
}
class MockContext {
  state: AudioContextState = 'suspended'; sampleRate = 4000; currentTime = 0; destination = new MockNode();
  closeCalls = 0; resumeCalls = 0; sources: MockSource[] = []; nodes: MockNode[] = [];
  deferredResume: (() => Promise<void>) | null = null;
  async resume() { this.resumeCalls++; if (this.deferredResume) await this.deferredResume(); this.state = 'running'; }
  async close() { this.closeCalls++; this.state = 'closed'; }
  createGain() { const node = Object.assign(new MockNode(), { gain: { value: 1 } }); this.nodes.push(node); return node; }
  createBiquadFilter() { const node = Object.assign(new MockNode(), { type: '', frequency: { value: 0 }, Q: { value: 0 } }); this.nodes.push(node); return node; }
  createBufferSource() { const node = new MockSource(); this.sources.push(node); this.nodes.push(node); return node; }
  createBuffer(_channels: number, length: number) { const data = new Float32Array(length); return { getChannelData: () => data }; }
}
function setup() {
  const context = new MockContext(), factory = vi.fn(() => context as unknown as AudioContext);
  return { context, factory, audio: createHomeAudio(factory) };
}
function cueTime(activity: string, kind: HomeAmbientSound, actorId = 1) {
  for (let time = 1; time < 60; time += .01) {
    const event = sampleHomeAmbience(activity, time, actorId).audio;
    if (event?.kind === kind && event.startedAt > 1) return event.startedAt;
  }
  throw new Error('missing cue');
}
function run(audio: ReturnType<typeof createHomeAudio>, start: number, end: number, actors: readonly HomeAudioActor[]) {
  for (let time = start; time < end; time += .025) audio.tick(time, actors);
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('opt-in local WebAudio effects', () => {
  it('never constructs or resumes audio until explicit enable, even with live actors or setEnabled(true)', async () => {
    const { audio, factory, context } = setup();
    audio.tick(1, [{ actorId: 1, activity: 'sleep' }]); audio.setEnabled(true); audio.tick(2, [{ actorId: 1, activity: 'sleep' }]);
    expect(factory).not.toHaveBeenCalled(); expect(audio.getSnapshot().enabled).toBe(false);
    expect(await audio.enable()).toBe(true); expect(factory).toHaveBeenCalledTimes(1); expect(context.resumeCalls).toBe(1);
    expect(audio.getSnapshot().origin).toBe(HOME_AUDIO_ORIGIN); audio.dispose();
  });
  it.each([['sleep', 'snore'], ['television', 'laugh'], ['television', 'crunch'], ['mahjong', 'tile']] as const)('synthesizes one bounded %s/%s buffer per episode and never repeats frozen frames', async (activity, kind) => {
    const { audio, context } = setup(); await audio.enable(); const time = cueTime(activity, kind), actors = [{ actorId: 1, activity }];
    audio.tick(time - .02, actors); audio.tick(time + .02, actors);
    expect(context.sources.length).toBe(1); const source = context.sources[0];
    for (let i = 0; i < 20; i++) audio.tick(time + .02, actors);
    expect(context.sources.length).toBe(1); expect(source.starts).toBe(1);
    const values = source.buffer!.getChannelData(0);
    expect(values.every(Number.isFinite)).toBe(true); expect(values.some(x => Math.abs(x) > .005)).toBe(true);
    expect(Math.max(...values.map(Math.abs))).toBeLessThan(1);
    source.end(); expect(audio.getSnapshot().activeVoices).toBe(0); expect(source.disconnected).toBe(1);
    audio.dispose();
  });
  it('stops on pause, rebases on resume, and only plays future episodes without catch-up', async () => {
    const { audio, context } = setup(); await audio.enable(); const actors = [{ actorId: 1, activity: 'television' }], time = cueTime('television', 'laugh');
    audio.tick(time - .02, actors); audio.tick(time + .02, actors); expect(context.sources.length).toBe(1);
    audio.pause(); expect(context.sources[0].stops).toBe(1); expect(context.closeCalls).toBe(0);
    audio.tick(time + .04, actors); audio.tick(time + .06, actors); expect(context.sources.length).toBe(1);
    run(audio, time + .08, time + 15, actors); expect(context.sources.length).toBeGreaterThan(1);
    audio.dispose();
  });
  it('stops removed, changed and muted actors, closes on off/dispose, and never reopens from tick', async () => {
    const { audio, context, factory } = setup(); await audio.enable(); const time = cueTime('sleep', 'snore');
    audio.tick(time - .02, [{ actorId: 1, activity: 'sleep' }]); audio.tick(time + .02, [{ actorId: 1, activity: 'sleep' }]);
    audio.tick(time + .04, [{ actorId: 1, activity: 'walk' }]); expect(context.sources[0].stops).toBe(1);
    audio.setEnabled(false); expect(context.closeCalls).toBe(1); expect(audio.getSnapshot().activeVoices).toBe(0);
    audio.tick(time + .06, [{ actorId: 1, activity: 'sleep' }]); expect(factory).toHaveBeenCalledTimes(1);
    audio.dispose(); audio.dispose(); expect(context.closeCalls).toBe(1); expect(await audio.enable()).toBe(false);
  });
  it('keeps simultaneous voices bounded and releases all resources on scene teardown', async () => {
    const { audio, context } = setup(); await audio.enable();
    const actors = Array.from({ length: 9 }, (_, i) => ({ actorId: i + 1, activity: 'sleep' }));
    for (let time = 0; time < 20; time += .025) {
      audio.tick(time, actors); expect(audio.getSnapshot().activeVoices).toBeLessThanOrEqual(3);
    }
    expect(context.sources.length).toBeGreaterThan(0);
    audio.tick(20.01, []); expect(audio.getSnapshot().activeVoices).toBe(0);
    expect(context.sources.every(x => x.stops === 1 && x.disconnected === 1)).toBe(true); audio.dispose();
  });
  it('closes an opening context immediately when disabled and rejects a stale async completion', async () => {
    const { audio, context } = setup(); let resolve!: () => void;
    context.deferredResume = () => new Promise<void>(r => { resolve = r; });
    const pending = audio.enable(); audio.setEnabled(false); expect(context.closeCalls).toBe(1);
    resolve(); expect(await pending).toBe(false); expect(audio.getSnapshot().enabled).toBe(false);
    expect(context.closeCalls).toBe(1); audio.dispose();
  });
  it('shares concurrent enable calls and never retries a rejected factory without another explicit click', async () => {
    const { audio, factory } = setup(); expect(await Promise.all([audio.enable(), audio.enable()])).toEqual([true, true]);
    expect(factory).toHaveBeenCalledTimes(1); audio.dispose();
    const failing = vi.fn(() => { throw new Error('denied'); }), denied = createHomeAudio(failing);
    expect(await denied.enable()).toBe(false); run(denied, 0, 20, [{ actorId: 1, activity: 'sleep' }]);
    expect(failing).toHaveBeenCalledTimes(1); expect(await denied.enable()).toBe(false); expect(failing).toHaveBeenCalledTimes(2); denied.dispose();
  });
  it('drops clock jumps/history, invalid/muted actors and performs no network, random, recording or timer work', async () => {
    const { audio, context } = setup(); await audio.enable();
    vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock'); });
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('random'); });
    vi.spyOn(globalThis, 'setInterval').mockImplementation(() => { throw new Error('timer'); });
    vi.stubGlobal('fetch', () => { throw new Error('network'); });
    const time = cueTime('television', 'laugh'), actors = [{ actorId: 1, activity: 'television' }];
    audio.tick(0, actors); audio.tick(time + .02, actors); audio.tick(time + .03, actors); expect(context.sources.length).toBe(0);
    audio.tick(NaN, actors); audio.tick(time + .04, [{ actorId: 1, activity: 'television', audible: false }, { actorId: -1, activity: 'sleep' }]);
    expect(context.sources.length).toBe(0); audio.dispose();
  });
});
