import { describe, expect, it } from 'vitest';
import { createLivingWalkAnimation, type LivingWalkSample } from '../lib/living-walk-animation';

const at = (x: number, delta = .05, extra: Partial<LivingWalkSample> = {}): LivingWalkSample => ({ position: { x, z: 0 }, targetYaw: 0, delta, moving: true, active: true, ...extra });
const angularDistance = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

describe('actual displacement walking animation', () => {
  it('starts facing its actual heading rather than visibly turning from zero', () => {
    const pose = createLivingWalkAnimation().sample(3, at(0, .05, { targetYaw: 2.7 }));
    expect(pose).toEqual({ yaw: 2.7, stride: 0, arm: 0, bob: 0, lean: 0 });
  });

  it('uses the same walked distance and time to produce the same gait at 20 and 60 fps', () => {
    function walk(frames: number) {
      const a = createLivingWalkAnimation(); let pose = a.sample(1, at(0));
      for (let frame = 1; frame <= frames; frame++) pose = a.sample(1, at(frame * .63 / frames, 1 / frames));
      return pose;
    }
    const slow = walk(20), fast = walk(60);
    for (const field of ['stride', 'arm', 'bob', 'lean', 'yaw'] as const) expect(slow[field]).toBeCloseTo(fast[field], 10);
    expect(Math.abs(slow.stride)).toBeGreaterThan(.1);
  });

  it('freezes every output on pause and resumes without catching up to paused positions', () => {
    const a = createLivingWalkAnimation(); a.sample(1, at(0));
    const before = a.sample(1, at(.04));
    for (const delta of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(a.sample(1, at(4, delta, { targetYaw: 2 }))).toEqual(before);
    // Both branches resume from the same position and advance the same actual distance.
    const control = createLivingWalkAnimation(); control.sample(1, at(3.96)); control.sample(1, at(4));
    const resumed = a.sample(1, at(4.04)), reference = control.sample(1, at(4.04));
    for (const field of ['stride', 'arm', 'bob', 'lean', 'yaw'] as const) expect(resumed[field]).toBeCloseTo(reference[field], 12);
  });

  it('turns across the ±pi boundary by the short route and respects angular speed', () => {
    const a = createLivingWalkAnimation(); a.sample(1, at(0, .05, { targetYaw: Math.PI - .02 }));
    const across = a.sample(1, at(.01, .05, { targetYaw: -Math.PI + .02 }));
    expect(angularDistance(across.yaw, Math.PI - .02)).toBeCloseTo(.04, 10);
    const turn = a.sample(1, at(.02, .01, { targetYaw: 0 }));
    expect(Math.abs(angularDistance(turn.yaw, across.yaw))).toBeLessThanOrEqual(.036 + 1e-10);
  });

  it('settles a stopped or yielding actor without cycling its feet in place', () => {
    const a = createLivingWalkAnimation(); a.sample(1, at(0));
    let pose = a.sample(1, at(.17)), previous = Math.abs(pose.stride);
    expect(previous).toBeGreaterThan(0);
    for (let frame = 0; frame < 40; frame++) {
      pose = a.sample(1, at(.17, .05, { moving: frame % 2 === 0 }));
      expect(Math.abs(pose.stride)).toBeLessThanOrEqual(previous + 1e-12);
      previous = Math.abs(pose.stride);
    }
    expect(pose.stride).toBe(0); expect(pose.arm).toBe(0); expect(pose.bob).toBe(0);
    expect(Math.abs(a.sample(1, at(.18)).stride)).toBeLessThan(.06);
  });

  it('cleans only the requested actor and active=false leaves other activities neutral', () => {
    const a = createLivingWalkAnimation(); a.sample(1, at(0)); a.sample(2, at(0));
    a.sample(1, at(.13)); const other = a.sample(2, at(.13));
    a.reset(1);
    expect(a.sample(1, at(8, .05, { targetYaw: 1.2 }))).toEqual({ yaw: 1.2, stride: 0, arm: 0, bob: 0, lean: 0 });
    expect(a.sample(2, at(.13, 0))).toEqual(other);
    expect(a.sample(2, at(.13, .05, { active: false, targetYaw: .8 }))).toEqual({ yaw: .8, stride: 0, arm: 0, bob: 0, lean: 0 });
    expect(a.sample(2, at(9, .05, { targetYaw: 2 }))).toEqual({ yaw: 2, stride: 0, arm: 0, bob: 0, lean: 0 });
    a.reset(); expect(a.sample(1, at(10))).toEqual({ yaw: 0, stride: 0, arm: 0, bob: 0, lean: 0 });
  });
});
