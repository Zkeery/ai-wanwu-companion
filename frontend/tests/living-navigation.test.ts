import { describe, expect, it } from 'vitest';
import { createLivingNavigation, sampleLivingNavigation, type NavBounds, type NavPoint, type LivingNavigationRoute } from '../lib/living-navigation';

const room: NavBounds = { minX: -4.6, maxX: 4.6, minZ: -3.2, maxZ: 3.2 };
const chair: NavBounds = { minX: -.65, maxX: .65, minZ: -.6, maxZ: .6 };

// Independent continuous segment/rectangle oracle, not a call back into the planner.
function segmentHits(a: NavPoint, b: NavPoint, obstacle: NavBounds, rx: number, rz = rx) {
  const box = { minX: obstacle.minX - rx, maxX: obstacle.maxX + rx, minZ: obstacle.minZ - rz, maxZ: obstacle.maxZ + rz };
  let enter = 0, exit = 1;
  for (const axis of ['x', 'z'] as const) {
    const from = a[axis], delta = b[axis] - from;
    const min = axis === 'x' ? box.minX : box.minZ, max = axis === 'x' ? box.maxX : box.maxZ;
    if (delta === 0) { if (from < min || from > max) return false; }
    else {
      const near = Math.min((min - from) / delta, (max - from) / delta), far = Math.max((min - from) / delta, (max - from) / delta);
      enter = Math.max(enter, near); exit = Math.min(exit, far);
      if (enter > exit) return false;
    }
  }
  return true;
}
function assertRouteSafe(route: LivingNavigationRoute, bounds: NavBounds, blocked: NavBounds[], rx: number, rz = rx) {
  expect(route.points.length).toBeGreaterThan(2);
  expect(route.points[0]).toEqual(route.points[route.points.length - 1]);
  for (let i = 0; i < route.points.length; i++) {
    const a = route.points[i];
    expect(a.x - rx).toBeGreaterThanOrEqual(bounds.minX);
    expect(a.x + rx).toBeLessThanOrEqual(bounds.maxX);
    expect(a.z - rz).toBeGreaterThanOrEqual(bounds.minZ);
    expect(a.z + rz).toBeLessThanOrEqual(bounds.maxZ);
    if (i) for (const obstacle of blocked) expect(segmentHits(route.points[i - 1], a, obstacle, rx, rz)).toBe(false);
  }
}

describe('regional visual navigation', () => {
  it('makes a closed swept-safe route around a chair instead of a decorative orbit through it', () => {
    const route = createLivingNavigation({ bounds: room, blocked: [chair], clearance: .4 }).plan({ anchor: { x: -2.2, z: 0 }, id: 4 });
    expect(route.blocked).toBeNull();
    expect(route.length).toBeGreaterThan(5);
    assertRouteSafe(route, room, [chair], .4);
    const period = route.length / route.speed;
    for (let i = 0; i <= 2_000; i++) {
      const sample = sampleLivingNavigation(route, period * i / 2_000);
      expect(sample.position).not.toBeNull();
      expect(segmentHits(sample.position!, sample.position!, chair, .4)).toBe(false);
    }
  });

  it('stays within the original connected side of a wall or closed door', () => {
    const wall = { minX: -.1, maxX: .1, minZ: -3.3, maxZ: 3.3 };
    const route = createLivingNavigation({ bounds: room, blocked: [wall], clearance: .28 }).plan({ anchor: { x: -2, z: 0 }, id: 5 });
    expect(route.blocked).toBeNull();
    assertRouteSafe(route, room, [wall], .28);
    expect(route.points.every(p => p.x < -.38)).toBe(true);
  });

  it('cannot squeeze a wide footprint through a narrow gap, but a smaller one can', () => {
    const upper = { minX: -.1, maxX: .1, minZ: .35, maxZ: 3.3 };
    const lower = { minX: -.1, maxX: .1, minZ: -3.3, maxZ: -.35 };
    const large = createLivingNavigation({ bounds: room, blocked: [upper, lower], clearance: .4 }).plan({ anchor: { x: -2, z: 0 }, id: 7 });
    const small = createLivingNavigation({ bounds: room, blocked: [upper, lower], clearance: .2 }).plan({ anchor: { x: -2, z: 0 }, id: 7 });
    expect(large.points.every(p => p.x < 0)).toBe(true);
    expect(small.points.some(p => p.x > .5)).toBe(true);
    assertRouteSafe(large, room, [upper, lower], .4);
    assertRouteSafe(small, room, [upper, lower], .2);
  });

  it('corrects an anchor already inside furniture once without changing the input', () => {
    const anchor = { x: 0, z: 0 }, before = JSON.stringify({ anchor, chair, room });
    const route = createLivingNavigation({ bounds: room, blocked: [chair], clearance: { x: .48, z: .31 } }).plan({ anchor, id: 6 });
    expect(route.anchorCorrected).toBe(true);
    expect(route.safeAnchor).not.toEqual(anchor);
    expect(sampleLivingNavigation(route, 0, false).position).toEqual(route.safeAnchor);
    assertRouteSafe(route, room, [chair], .48, .31);
    expect(JSON.stringify({ anchor, chair, room })).toBe(before);
  });

  it('clamps an outside anchor to an interior footprint-safe landing', () => {
    const route = createLivingNavigation({ bounds: room, blocked: [], clearance: .5 }).plan({ anchor: { x: 12, z: 8 }, id: 4 });
    expect(route.anchorCorrected).toBe(true);
    expect(route.safeAnchor!.x + .5).toBeLessThan(room.maxX);
    expect(route.safeAnchor!.z + .5).toBeLessThan(room.maxZ);
    assertRouteSafe(route, room, [], .5);
  });

  it('returns explicit stopped/no-position when furniture fills all safe floor', () => {
    const route = createLivingNavigation({ bounds: room, blocked: [room], clearance: .3 }).plan({ anchor: { x: 0, z: 0 }, id: 4 });
    const sample = sampleLivingNavigation(route, 40);
    expect(route.blocked).toBe('no-safe-point');
    expect(sample).toMatchObject({ position: null, moving: false, blocked: 'no-safe-point' });
  });

  it('keeps a valid isolated landing stopped rather than inventing a path', () => {
    const pocketWalls = [
      { minX: .01, maxX: .19, minZ: .01, maxZ: .07 },
      { minX: .01, maxX: .19, minZ: .13, maxZ: .19 },
      { minX: .01, maxX: .07, minZ: .07, maxZ: .13 },
      { minX: .13, maxX: .19, minZ: .07, maxZ: .13 },
    ];
    const anchor = { x: .1, z: .1 };
    const route = createLivingNavigation({ bounds: { minX: -1, maxX: 1, minZ: -1, maxZ: 1 }, blocked: pocketWalls, clearance: 0 }).plan({ anchor, id: 4 });
    expect(sampleLivingNavigation(route, 2).moving).toBe(false);
    expect(route.blocked).toBe('no-path');
    expect(sampleLivingNavigation(route, 2).position).toEqual(anchor);
  });

  it('rejects invalid obstacle/bounds instead of silently ignoring unknown collision data', () => {
    const route = createLivingNavigation({ bounds: room, blocked: [{ ...chair, minX: NaN }], clearance: .4 }).plan({ anchor: { x: 0, z: 0 }, id: 4 });
    expect(route.blocked).toBe('invalid-bounds');
    expect(sampleLivingNavigation(route, 10).position).toBeNull();
  });

  it('caches plans, reproduces samples and never resets the pause location to its anchor', () => {
    const planner = createLivingNavigation({ bounds: room, blocked: [chair], clearance: .32 });
    const args = { anchor: { x: -1.7, z: -.8 }, id: 4 };
    const route = planner.plan(args), copy = createLivingNavigation({ bounds: room, blocked: [chair], clearance: .32 }).plan(args);
    expect(planner.plan(args)).toBe(route);
    expect(copy).toEqual(route);
    const active = sampleLivingNavigation(route, 12.345), paused = sampleLivingNavigation(route, 12.345, false);
    expect(paused.position).toEqual(active.position);
    expect(paused.yaw).toBe(active.yaw);
    expect(paused.moving).toBe(false);
    expect(paused.position).not.toEqual(route.safeAnchor);
    expect(planner.plan({ ...args, id: 5 }).seed).not.toBe(route.seed);
  });

  it('is continuous at route turns and wrap, and yaw follows its actual straight segment', () => {
    const route = createLivingNavigation({ bounds: room, blocked: [chair], clearance: .36 }).plan({ anchor: { x: -2, z: 0 }, id: 9 });
    const period = route.length / route.speed, dt = .0001;
    for (const time of [...route.cumulative.map(d => d / route.speed), period, period * 2]) {
      const before = sampleLivingNavigation(route, Math.max(0, time - dt)), after = sampleLivingNavigation(route, time + dt);
      expect(Math.hypot(after.position!.x - before.position!.x, after.position!.z - before.position!.z)).toBeLessThanOrEqual(route.speed * dt * 2.01);
    }
    const time = route.cumulative[1] / route.speed / 2;
    const a = sampleLivingNavigation(route, time), b = sampleLivingNavigation(route, time + dt);
    expect(Math.atan2(b.position!.x - a.position!.x, b.position!.z - a.position!.z)).toBeCloseTo(a.yaw, 6);
  });
});

it('new placements stay in the entrance-connected component without changing the requested anchor',()=>{
 const graph=createLivingNavigation({bounds:{minX:-5,maxX:5,minZ:-5,maxZ:5},blocked:[{minX:-.2,maxX:.2,minZ:-5,maxZ:5}],clearance:.2,step:.2});const anchor={x:-3,z:0},entry={x:3,z:0};const safe=graph.findSafePoint(anchor,[],0,entry);expect(safe).not.toBeNull();expect(safe!.x).toBeGreaterThan(0);expect(graph.planTo({from:entry,to:safe!,id:1}).blocked).toBeNull();expect(anchor).toEqual({x:-3,z:0});
});


it('places a new roaming companion in the largest connected floor without moving fixed occupants or saved anchors',()=>{
 const graph=createLivingNavigation({bounds:{minX:-5,maxX:5,minZ:-3,maxZ:3},blocked:[{minX:-3.2,maxX:-2.8,minZ:-3,maxZ:3}],clearance:.2,step:.2});
 const anchor={x:-4,z:0},fixed=[{position:{x:0,z:0},radius:.3}],saved=JSON.stringify({anchor,fixed});
 const stationary=graph.findSafePoint(anchor,fixed),roaming=graph.findSafePoint(anchor,fixed,0,undefined,true);
 expect(stationary).toEqual(anchor);expect(roaming).not.toBeNull();expect(roaming!.x).toBeGreaterThan(-2.8);
 expect(graph.plan({anchor:roaming!,id:9}).diagnostics.componentSize).toBeGreaterThan(100);
 expect(JSON.stringify({anchor,fixed})).toBe(saved);
 expect(graph.findSafePoint(anchor,fixed,0,{x:-4,z:0},true)).toBeNull();
});
