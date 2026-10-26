import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleHomeLeisurePose } from '../lib/living-home-leisure-pose';

const activities = ['tea', 'television', 'mahjong', 'bench'] as const;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('frozen-clock synthetic leisure poses', () => {
  it('takes a tea cup smoothly from table-front to mouth, holds it, and puts it back', () => {
    const poses = Array.from({ length: 1_501 }, (_, i) => sampleHomeLeisurePose('tea', i / 100, 1));
    expect(poses[0].cupLift).toBe(0);
    expect(poses.some(p => p.cupLift === 1)).toBe(true);
    const raised = poses.find(p => p.cupLift === 1)!;
    expect(raised.rightArmX).toBeLessThan(poses[0].rightArmX - .6);
    expect(raised.rightArmZ).toBeLessThan(poses[0].rightArmZ - .5);
    const held = poses.filter(p => p.cupLift === 1);
    expect(held.length).toBeGreaterThan(100);
    expect(poses.slice(800, 1100).some(p => p.cupLift === 0)).toBe(true);
    expect(poses.every(p => p.cupLift >= 0 && p.cupLift <= 1)).toBe(true);
  });

  it.each(activities)('%s remains continuous across reaching/holding/returning and cycle boundaries', activity => {
    let previous = sampleHomeLeisurePose(activity, 0, 3);
    for (let i = 1; i <= 10_000; i++) {
      const next = sampleHomeLeisurePose(activity, i / 100, 3);
      for (const key of Object.keys(next) as (keyof typeof next)[]) expect(Math.abs(next[key] - previous[key])).toBeLessThan(.02);
      previous = next;
    }
  });

  it('keeps TV hands on the lap with only small motion and never produces a cup', () => {
    const poses = Array.from({ length: 400 }, (_, i) => sampleHomeLeisurePose('television', i / 5, 2));
    expect(poses.every(p => p.cupLift === 0)).toBe(true);
    expect(poses.every(p => p.leftArmX > -.6 && p.leftArmX < -.35 && p.rightArmX > -.6 && p.rightArmX < -.35)).toBe(true);
    expect(Math.max(...poses.map(p => p.rightArmX)) - Math.min(...poses.map(p => p.rightArmX))).toBeGreaterThan(.02);
    expect(Math.max(...poses.map(p => Math.abs(p.lookYaw)))).toBeLessThan(.025);
  });

  it('mahjong reaches for tiles with alternating hands, never raising both together or showing a tea cup', () => {
    const poses = Array.from({ length: 800 }, (_, i) => sampleHomeLeisurePose('mahjong', i / 20, 4));
    expect(poses.some(p => p.leftArmX < -.9)).toBe(true);
    expect(poses.some(p => p.rightArmX < -.9)).toBe(true);
    expect(poses.every(p => !(p.leftArmX < -.6 && p.rightArmX < -.6))).toBe(true);
    expect(poses.every(p => p.cupLift === 0)).toBe(true);
  });

  it('freezes exactly at the supplied elapsed value and varies deterministic gestures by actor', () => {
    for (const activity of activities) expect(sampleHomeLeisurePose(activity, 12.345, 6)).toEqual(sampleHomeLeisurePose(activity, 12.345, 6));
    expect(sampleHomeLeisurePose('tea', 2.2, 6)).not.toEqual(sampleHomeLeisurePose('tea', 2.2, 7));
    expect(sampleHomeLeisurePose('tea', 2.2, 6)).not.toEqual(sampleHomeLeisurePose('tea', 3, 6));
    expect(Object.isFrozen(sampleHomeLeisurePose('bench', 2, 4))).toBe(true);
  });

  it('has finite bounded outputs for invalid clocks, actor identifiers and unsupported activities', () => {
    for (const activity of activities) for (const time of [-1, NaN, Infinity, Number.MAX_VALUE]) for (const actor of [NaN, -1, Infinity, 8]) {
      const result = sampleHomeLeisurePose(activity, time, actor);
      expect(Object.values(result).every(Number.isFinite)).toBe(true);
      expect(Math.abs(result.sway)).toBeLessThan(.02); expect(Math.abs(result.lookYaw)).toBeLessThan(.05);
    }
    expect(sampleHomeLeisurePose('unknown' as never, 100, 2)).toEqual(sampleHomeLeisurePose('unknown' as never, 0, 2));
  });

  it('does not read the wall clock, random source, network or start its own timer', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('no clock'); });
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('no random'); });
    vi.spyOn(globalThis, 'setInterval').mockImplementation(() => { throw new Error('no timer'); });
    vi.stubGlobal('fetch', () => { throw new Error('no network'); });
    for (const activity of activities) expect(sampleHomeLeisurePose(activity, 3.5, 1).cupLift).toBeGreaterThanOrEqual(0);
  });
});
