import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleHomeAmbience, type HomeAmbientSound } from '../lib/living-home-ambience';
import { sampleHomeLeisurePose } from '../lib/living-home-leisure-pose';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('local home ambience rhythm', () => {
  it('gives deterministic actor-specific breathing, not a wall clock or generated AI action', () => {
    const a = sampleHomeAmbience('sleep', 12.345, 4);
    expect(a).toEqual(sampleHomeAmbience('sleep', 12.345, 4));
    expect(a).not.toEqual(sampleHomeAmbience('sleep', 12.345, 5));
    expect(a.sleep.breath).toBeGreaterThanOrEqual(0); expect(a.sleep.breath).toBeLessThanOrEqual(1);
    expect(Object.isFrozen(a)).toBe(true); expect(Object.isFrozen(a.sleep)).toBe(true);
  });
  it('keeps mahjong reach on the existing real pose clock and carries tiles with the reaching hand', () => {
    let sawLeft = false, sawRight = false, sawHold = false;
    for (let time = 0; time < 25; time += .02) {
      const a = sampleHomeAmbience('mahjong', time, 4), p = sampleHomeLeisurePose('mahjong', time, 4);
      const reach = Math.max(0, -Math.min(p.leftArmX, p.rightArmX) - .42) / .65;
      expect(a.mahjong.reach).toBeCloseTo(reach, 10);
      if (a.mahjong.hold) { sawHold = true; expect(a.mahjong.reach).toBeGreaterThan(0); }
      if (a.mahjong.reach > .5) { if (a.mahjong.hand === 'left') sawLeft = true; else sawRight = true; }
    }
    expect([sawLeft, sawRight, sawHold]).toEqual([true, true, true]);
  });
  it('makes the seed hand stay at the mouth during a crunch and keeps visual gestures continuous', () => {
    let crunches = 0, laughs = 0, last = sampleHomeAmbience('television', 0, 2).television;
    for (let i = 1; i <= 8000; i++) {
      const a = sampleHomeAmbience('television', i / 200, 2);
      if (a.audio?.kind === 'crunch') { crunches++; expect(a.television.seedHandLift).toBeGreaterThan(.99); }
      if (a.television.laugh > .2) laughs++;
      expect(Math.abs(a.television.seedHandLift - last.seedHandLift)).toBeLessThan(.025);
      last = a.television;
    }
    expect(crunches).toBeGreaterThan(0); expect(laughs).toBeGreaterThan(0);
  });
  it('uses a unique episode/start time for each snore, laugh, crunch and wood-tile cue', () => {
    for (const [activity, sounds] of [['sleep', ['snore']], ['television', ['laugh', 'crunch']], ['mahjong', ['tile']]] as const) {
      const keys = new Map<HomeAmbientSound, Set<number>>();
      for (let time = 0; time < 50; time += .025) {
        const cue = sampleHomeAmbience(activity, time, 1).audio;
        if (cue) { expect(cue.progress).toBeGreaterThanOrEqual(0); expect(cue.progress).toBeLessThan(1); expect(cue.startedAt).toBeLessThanOrEqual(time); (keys.get(cue.kind) ?? keys.set(cue.kind, new Set()).get(cue.kind)!).add(cue.episode); }
      }
      for (const sound of sounds) expect(keys.get(sound)!.size).toBeGreaterThan(2);
    }
  });
  it('samples tea steam at a steady supplied clock without creating an audio cue', () => {
    const a = sampleHomeAmbience('tea', 2, 3), b = sampleHomeAmbience('tea', 2.25, 3);
    expect(b.tea.steamTime - a.tea.steamTime).toBeCloseTo(.25, 10);
    expect(a.tea.steamStrength).toBeGreaterThan(.5); expect(a.audio).toBeNull();
  });
  it('has silent finite empty states for unknown activities and invalid actors, with no outside work', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock'); });
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('random'); });
    vi.spyOn(globalThis, 'setInterval').mockImplementation(() => { throw new Error('timer'); });
    vi.stubGlobal('fetch', () => { throw new Error('network'); });
    for (const actor of [0, -1, NaN, Infinity]) for (const activity of ['sleep', 'tea', 'mahjong', 'television']) {
      const a = sampleHomeAmbience(activity, NaN, actor); expect(a.audio).toBeNull(); expect(a.sleep.breath + a.television.laugh + a.tea.steamStrength + a.mahjong.reach).toBe(0);
    }
    expect(sampleHomeAmbience('walk', 10, 1).audio).toBeNull();
  });
});
