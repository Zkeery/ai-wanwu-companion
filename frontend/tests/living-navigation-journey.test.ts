import { describe, expect, it } from 'vitest';
import { createLivingNavigation, sampleLivingJourney, type LivingNavigationRoute, type NavBounds, type NavOccupied, type NavPoint } from '../lib/living-navigation';

const bounds: NavBounds = { minX: -4, maxX: 4, minZ: -3, maxZ: 3 };
const from = { x: -2.813, z: -.137 }, to = { x: 2.679, z: .183 };
const distance = (a: NavPoint, b: NavPoint) => Math.hypot(a.x - b.x, a.z - b.z);
function assertSafe(route: LivingNavigationRoute, blocked: NavBounds[], radius = .2, avoid: readonly NavOccupied[] = []) {
  expect(route.blocked).toBeNull(); expect(route.anchorCorrected).toBe(false);
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1], b = route.points[i];
    // Independently sample every segment densely, including both endpoints.
    const count = Math.max(256, Math.ceil(distance(a, b) / .002));
    for (let step = 0; step <= count; step++) {
      const p = { x: a.x + (b.x - a.x) * step / count, z: a.z + (b.z - a.z) * step / count };
      expect(p.x).toBeGreaterThanOrEqual(bounds.minX + radius); expect(p.x).toBeLessThanOrEqual(bounds.maxX - radius);
      expect(p.z).toBeGreaterThanOrEqual(bounds.minZ + radius); expect(p.z).toBeLessThanOrEqual(bounds.maxZ - radius);
      for (const box of blocked) expect(p.x > box.minX - radius && p.x < box.maxX + radius && p.z > box.minZ - radius && p.z < box.maxZ + radius).toBe(false);
      for (const other of avoid) expect(distance(p, other.position)).toBeGreaterThanOrEqual(radius + other.radius + .035 - 1e-6);
    }
  }
}

describe('exact one-way navigation journeys', () => {
  it('keeps non-grid endpoints exact, immutable, and open rather than closing a patrol loop', () => {
    const graph = createLivingNavigation({ bounds, blocked: [], clearance: .2 });
    const route = graph.planTo({ from, to, id: 4 });
    expect(route.points).toEqual([from, to]); expect(route.safeAnchor).toEqual(from);
    expect(route.length).toBeCloseTo(distance(from, to), 12);
    expect(Object.isFrozen(route.points)).toBe(true); expect(Object.isFrozen(route.points[0])).toBe(true);
    assertSafe(route, []);
  });

  it('routes around furniture with the full footprint while retaining exact endpoints', () => {
    const blocked = [{ minX: -.5, maxX: .5, minZ: -1.3, maxZ: 1.3 }];
    const route = createLivingNavigation({ bounds, blocked, clearance: .2 }).planTo({ from, to, id: 'guest' });
    expect(route.points.length).toBeGreaterThan(2); expect(route.points[0]).toEqual(from); expect(route.points.at(-1)).toEqual(to);
    assertSafe(route, blocked);
  });

  it('uses an open doorway and reports no-path when the same doorway is closed', () => {
    const walls = [{ minX: -.08, maxX: .08, minZ: -3, maxZ: -.5 }, { minX: -.08, maxX: .08, minZ: .5, maxZ: 3 }];
    const open = createLivingNavigation({ bounds, blocked: walls, clearance: .2 }).planTo({ from, to, id: 1 });
    assertSafe(open, walls);
    const closed = createLivingNavigation({ bounds, blocked: [...walls, { minX: -.08, maxX: .08, minZ: -.5, maxZ: .5 }], clearance: .2 }).planTo({ from, to, id: 1 });
    expect(closed.blocked).toBe('no-path'); expect(closed.points).toHaveLength(0); expect(closed.safeAnchor).toEqual(from);
    expect(sampleLivingJourney(closed, 100).position).toEqual(from);
  });

  it('rejects unsafe endpoints instead of projecting them out of furniture or across a boundary', () => {
    const graph = createLivingNavigation({ bounds, blocked: [{ minX: -.5, maxX: .5, minZ: -.5, maxZ: .5 }], clearance: .2 });
    for (const [start, end] of [[{ x: 0, z: 0 }, to], [from, { x: 0, z: 0 }], [{ x: -4, z: 0 }, to]]) {
      const route = graph.planTo({ from: start, to: end, id: 1 });
      expect(route.blocked).toBe('no-safe-point'); expect(route.anchorCorrected).toBe(false); expect(route.points).toHaveLength(0);
      if (start.x === 0 || start.x === -4) expect(route.safeAnchor).toBeNull();
    }
  });

  it('reroutes around occupied people with the established .035 gap and stable peer ordering', () => {
    const graph = createLivingNavigation({ bounds, blocked: [], clearance: .2 });
    const avoid = [{ position: { x: -.3, z: 0 }, radius: .4 }, { position: { x: .8, z: 0 }, radius: .35 }];
    const route = graph.planTo({ from, to, id: 6, avoid });
    expect(route.points.length).toBeGreaterThan(2); assertSafe(route, [], .2, avoid);
    expect(graph.planTo({ from, to, id: 6, avoid: [...avoid].reverse() }).points).toEqual(route.points);
    const occupiedEnd = graph.planTo({ from, to, id: 6, avoid: [{ position: to, radius: .3 }] });
    expect(occupiedEnd.blocked).toBe('no-safe-point'); expect(occupiedEnd.safeAnchor).toEqual(from);
  });

  it('detects a dynamically disconnected corridor instead of crossing its occupied discs', () => {
    const graph = createLivingNavigation({ bounds, blocked: [], clearance: .2 });
    const avoid = [-2.5, -1.25, 0, 1.25, 2.5].map(z => ({ position: { x: 0, z }, radius: .6 }));
    const route = graph.planTo({ from, to, id: 6, avoid });
    expect(route.blocked).toBe('no-path'); expect(route.points).toHaveLength(0);
  });

  it('accepts a safe zero-distance visit and preserves an arbitrarily short nonzero trip', () => {
    const graph = createLivingNavigation({ bounds, blocked: [], clearance: .2 });
    const same = graph.planTo({ from, to: from, id: 1 });
    expect(same.blocked).toBeNull(); expect(same.length).toBe(0); expect(same.points).toEqual([from]);
    expect(sampleLivingJourney(same, 0)).toMatchObject({ position: from, moving: false });
    const near = { x: from.x + 1e-7, z: from.z }, tiny = graph.planTo({ from, to: near, id: 1 });
    expect(tiny.points).toEqual([from, near]); expect(sampleLivingJourney(tiny, 100).position).toEqual(near);
  });

  it('moves continuously then stops exactly at its destination without wrapping after any number of old patrol periods', () => {
    const route = createLivingNavigation({ bounds, blocked: [], clearance: .2 }).planTo({ from, to, id: 8 });
    const duration = route.length / route.speed, middle = sampleLivingJourney(route, duration / 2);
    expect(middle.moving).toBe(true); expect(middle.position!.x).toBeCloseTo((from.x + to.x) / 2, 12);
    expect(sampleLivingJourney(route, duration / 2, false)).toMatchObject({ position: middle.position, moving: false });
    for (const t of [duration, duration * 2, duration * 100 + .1]) expect(sampleLivingJourney(route, t)).toMatchObject({ position: to, moving: false, blocked: null });
  });

  it('fails closed on non-finite coordinates, IDs, occupied inputs, and invalid elapsed times', () => {
    const graph = createLivingNavigation({ bounds, blocked: [], clearance: .2 });
    for (const input of [
      { from: { x: Number.NaN, z: 0 }, to, id: 1 }, { from, to: { x: 0, z: Infinity }, id: 1 }, { from, to, id: Number.NaN },
      { from, to, id: 1, avoid: [{ position: { x: 0, z: 0 }, radius: -1 }] },
      { from, to, id: 1, avoid: null as unknown as readonly NavOccupied[] },
    ]) { const route = graph.planTo(input); expect(route.blocked).toBe('invalid-bounds'); expect(route.points).toHaveLength(0); }
    const route = graph.planTo({ from, to, id: 1 });
    for (const t of [Number.NaN, Infinity, -1]) expect(sampleLivingJourney(route, t)).toMatchObject({ position: from, moving: false });
  });

  it('does not alter the previously cached patrol contract while preparing a journey', () => {
    const graph = createLivingNavigation({ bounds, blocked: [], clearance: .2 });
    const before = graph.plan({ anchor: from, id: 3 }), bytes = JSON.stringify(before);
    graph.planTo({ from, to, id: 3 });
    expect(graph.plan({ anchor: from, id: 3 })).toBe(before); expect(JSON.stringify(before)).toBe(bytes);
    expect(before.points[0]).toEqual(before.points.at(-1));
  });
});
