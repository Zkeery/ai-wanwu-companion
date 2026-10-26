import { describe, expect, it } from 'vitest';
import { courtyardHop } from '@/lib/courtyard-figure';

function hop() {
  return { x: 0, z: 0, fromX: 0, fromZ: 0, toX: 0, toZ: 0, started: 0, active: false, pending: 0 };
}

describe('courtyard hop', () => {
  it('stays put while idle', () => {
    const state = hop();
    expect(courtyardHop(state, 1, 0, 0)).toMatchObject({ x: 0, y: 0, z: 0, active: false });
  });

  it('covers a walk with hops instead of matching every sliding position', () => {
    const state = hop();
    const samples = Array.from({ length: 50 }, (_, index) => courtyardHop(state, index * 0.02, (index + 1) * 0.03, 0));
    expect(samples.some(sample => sample.y > 0.05)).toBe(true);
    expect(samples.every((sample, index) => Math.abs(sample.x - (index + 1) * 0.03) < 0.001)).toBe(false);
  });
});
