import { describe, expect, it } from 'vitest';
import { createLivingPedestrianTraffic, type LivingPedestrianActor, type PedestrianPoint } from '../lib/living-pedestrian-traffic';

const dist = (a: PedestrianPoint, b: PedestrianPoint) => Math.hypot(a.x - b.x, a.z - b.z);
function walker(id: number, x: number, z: number, tx: number, tz: number, extra: Partial<LivingPedestrianActor> = {}): LivingPedestrianActor {
  const d = Math.hypot(tx - x, tz - z);
  return { id, region: 'yard', position: { x, z }, desired: { x: tx, z: tz }, heading: { x: (tx - x) / (d || 1), z: (tz - z) / (d || 1) },
    radius: .35, walking: true, speed: .8, canTraverse: () => true, ...extra };
}

// Independent disc intersection oracle. Solve |relativeStart + t * velocity|² < r²
// as a quadratic interval, including between-frame crossings with safe endpoints.
function bodiesIntersect(a0: PedestrianPoint, a1: PedestrianPoint, b0: PedestrianPoint, b1: PedestrianPoint, radius: number) {
  const x = a0.x - b0.x, z = a0.z - b0.z;
  const vx = a1.x - a0.x - b1.x + b0.x, vz = a1.z - a0.z - b1.z + b0.z;
  const A = vx * vx + vz * vz, B = 2 * (x * vx + z * vz), C = x * x + z * z - radius * radius;
  if (C < -1e-7) return true;
  if (A < 1e-12) return false;
  const discriminant = B * B - 4 * A * C;
  if (discriminant <= 1e-10) return false;
  const enter = (-B - Math.sqrt(discriminant)) / (2 * A), exit = (-B + Math.sqrt(discriminant)) / (2 * A);
  return Math.max(0, enter) < Math.min(1, exit) - 1e-7;
}

function simulate(initial: LivingPedestrianActor[], seconds = 16, reverse = false) {
  const traffic = createLivingPedestrianTraffic();
  let actors = initial.map(a => ({ ...a, position: { ...a.position } }));
  let yieldedFrames = 0, sideFrames = 0, progress = 0;
  const snapshots: string[] = [];
  for (let frame = 0; frame < seconds * 20; frame++) {
    const output = traffic.step(reverse ? [...actors].reverse() : actors, .05);
    const next = actors.map(a => ({ ...a, position: output.get(a.id)!.position }));
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i], n = next[i], r = output.get(a.id)!;
      expect(dist(a.position, n.position)).toBeLessThanOrEqual(a.speed * .05 + 1e-7);
      expect(r.progressFraction).toBeGreaterThanOrEqual(0); expect(r.progressFraction).toBeLessThanOrEqual(1);
      if (!a.walking) expect(n.position).toEqual(a.position);
      if (r.yielded) yieldedFrames++;
      if (r.moving && !r.progress && r.progressFraction === 0) sideFrames++;
      progress += r.progressFraction;
      for (let j = i + 1; j < actors.length; j++) if (a.region === actors[j].region) {
        expect(bodiesIntersect(a.position, n.position, actors[j].position, next[j].position, a.radius + actors[j].radius), `actors ${a.id}/${actors[j].id} at frame ${frame}`).toBe(false);
      }
    }
    actors = next;
    if (frame % 20 === 0) snapshots.push(JSON.stringify(actors.map(a => [a.id, a.position])));
  }
  return { actors, yieldedFrames, sideFrames, progress, snapshots };
}

describe('regional pedestrian traffic', () => {
  it('lets two head-on walkers sidestep, pass, and reach their own destinations', () => {
    const r = simulate([walker(1, -3, 0, 3, 0), walker(2, 3, 0, -3, 0)]);
    expect(r.yieldedFrames).toBeGreaterThan(0); expect(r.sideFrames).toBeGreaterThan(0);
    expect(dist(r.actors[0].position, { x: 3, z: 0 })).toBeLessThan(.03);
    expect(dist(r.actors[1].position, { x: -3, z: 0 })).toBeLessThan(.03);
  });

  it('resolves a perpendicular crossing without endpoint or swept-body overlap', () => {
    const r = simulate([walker(1, -3, 0, 3, 0), walker(2, 0, -3, 0, 3)]);
    for (const a of r.actors) expect(dist(a.position, a.desired), `actor ${a.id} ended at ${JSON.stringify(a.position)}`).toBeLessThan(.03);
  });

  it('a faster follower can pass a slower walker without walking through its back', () => {
    const r = simulate([walker(1, 0, 0, 5, 0, { speed: .35 }), walker(2, -2, 0, 5, 0, { speed: 1.1 })], 12);
    expect(r.yieldedFrames).toBeGreaterThan(0);
    expect(r.actors[1].position.x).toBeGreaterThan(3.8);
  });

  it.each([0, 9])('goes around a stationary actor with id %s and never moves that actor', stationaryId => {
    const r = simulate([walker(4, -3, 0, 3, 0), walker(stationaryId, 0, 0, 0, 0, { walking: false })]);
    expect(r.actors[1].position).toEqual({ x: 0, z: 0 });
    expect(dist(r.actors[0].position, { x: 3, z: 0 })).toBeLessThan(.03);
  });

  it('keeps actors in separate rooms independent even when their projected coordinates coincide', () => {
    const r = simulate([walker(1, -1, 0, 1, 0), walker(2, 1, 0, -1, 0, { region: 'bedroom' })], 4);
    expect(r.yieldedFrames).toBe(0);
    expect(r.actors.every(a => dist(a.position, a.desired) < .03)).toBe(true);
  });

  it('is deterministic after reversing the input array on every frame', () => {
    const initial = [walker(7, -3, 0, 3, 0), walker(2, 3, 0, -3, 0), walker(5, 0, -3, 0, 3)];
    expect(simulate(initial).snapshots).toEqual(simulate(initial, 16, true).snapshots);
  });

  it('preserves continuous clearance with ten walkers and gives all ten useful progress', () => {
    const actors = Array.from({ length: 10 }, (_, i) => {
      const row = Math.floor(i / 2), right = i % 2 === 1;
      return walker(i + 1, right ? 3 : -3, (row - 2) * 1.65, right ? -3 : 3, (row - 2) * 1.65);
    });
    const r = simulate(actors, 20);
    expect(r.actors.every(a => dist(a.position, a.desired) < .03)).toBe(true);
  });

  it('waits safely when walls leave no room to yield, rather than crossing or teleporting', () => {
    const corridor = (from: PedestrianPoint, to: PedestrianPoint) => Math.abs(from.z) < .001 && Math.abs(to.z) < .001;
    const r = simulate([walker(1, -1, 0, 1, 0, { canTraverse: corridor }), walker(2, 1, 0, -1, 0, { canTraverse: corridor })], 5);
    expect(r.actors[0].position.x).toBeLessThan(0);
    expect(r.actors[1].position.x).toBeGreaterThan(0);
    expect(r.actors.every(a => a.position.z === 0)).toBe(true);
  });

  it('checks every detour against the caller’s furniture/door segment validator', () => {
    const calls: Array<[PedestrianPoint, PedestrianPoint]> = [];
    const guard = (from: PedestrianPoint, to: PedestrianPoint) => {
      calls.push([from, to]);
      // A solid wall on the preferred (negative-z) side; the other side remains open.
      return Math.min(from.z, to.z) >= -.02;
    };
    const r = simulate([walker(2, -3, 0, 3, 0, { canTraverse: guard }), walker(1, 0, 0, 0, 0, { walking: false })]);
    expect(calls.some(([, to]) => to.z < -.02)).toBe(true);
    expect(r.actors[0].position.x).toBeGreaterThan(2.9);
  });

  it('chooses the other side before entering a furniture dead end partway through a sidestep', () => {
    const guard = (from: PedestrianPoint, to: PedestrianPoint) => Math.min(from.z, to.z) >= -.3;
    const r = simulate([walker(2, -3, 0, 3, 0, { canTraverse: guard }), walker(1, 0, 0, 0, 0, { walking: false })]);
    expect(dist(r.actors[0].position, r.actors[0].desired)).toBeLessThan(.03);
  });

  it('rejects a complete between-frame crossing even when both proposed endpoints would be clear', () => {
    const a = walker(1, -1, 0, 1, 0, { speed: 30 }), b = walker(2, 1, 0, -1, 0, { speed: 30 });
    const out = createLivingPedestrianTraffic().step([a, b], .1);
    expect(bodiesIntersect(a.position, out.get(1)!.position, b.position, out.get(2)!.position, a.radius + b.radius)).toBe(false);
    expect(out.get(1)!.position).not.toEqual(a.desired);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('freezes positions and route clocks for dt=%s', dt => {
    const traffic = createLivingPedestrianTraffic(), actors = [walker(1, -1, 0, 1, 0), walker(2, 1, 0, -1, 0)];
    const out = traffic.step(actors, dt);
    for (const a of actors) expect(out.get(a.id)).toMatchObject({ position: a.position, moving: false, progress: false, progressFraction: 0 });
  });

  it('caps a delayed browser frame and scales route progress to actual distance', () => {
    const a = walker(1, -3, 0, 3, 0), r = createLivingPedestrianTraffic().step([a], 5).get(1)!;
    expect(dist(a.position, r.position)).toBeCloseTo(.08, 8);
    expect(r.progressFraction).toBeCloseTo(.02, 8);
  });

  it('gradually separates legacy overlapping walking anchors without moving a fixed neighbour', () => {
    const traffic = createLivingPedestrianTraffic();
    let actors = [walker(1, 0, 0, 3, 0, { walking: false }), walker(2, 0, 0, 3, 0)];
    let previousGap = 0;
    for (let frame = 0; frame < 30; frame++) {
      const out = traffic.step(actors, .05), next = actors.map(a => ({ ...a, position: out.get(a.id)!.position }));
      const gap = dist(next[0].position, next[1].position);
      if (previousGap < .735) expect(gap).toBeGreaterThanOrEqual(previousGap - 1e-7);
      expect(dist(actors[1].position, next[1].position)).toBeLessThanOrEqual(.04 + 1e-7);
      expect(next[0].position).toEqual({ x: 0, z: 0 });
      actors = next; previousGap = gap;
    }
    expect(previousGap).toBeGreaterThan(.735);
  });

  it('does not mutate input positions or keep a removed actor’s stale yield plan', () => {
    const traffic = createLivingPedestrianTraffic(), moving = walker(2, -.75, 0, 3, 0), fixed = walker(1, 0, 0, 0, 0, { walking: false });
    const before = JSON.stringify([moving, fixed]); traffic.step([moving, fixed], .05);
    expect(JSON.stringify([moving, fixed])).toBe(before);
    traffic.step([], .05);
    const out = traffic.step([moving], .05).get(2)!;
    expect(out.yielded).toBe(false); expect(out.position.z).toBe(0);
    traffic.reset(); expect(traffic.step([moving], .05).get(2)).toEqual(out);
  });
});
