/** Local visual traffic only. Static furniture/doors remain the navigation caller's responsibility. */
export type PedestrianPoint = Readonly<{ x: number; z: number }>;
export type LivingPedestrianActor = Readonly<{
  id: number;
  region: string;
  position: PedestrianPoint;
  desired: PedestrianPoint;
  /** Original route tangent. Keeps sideways yielding from advancing the route clock. */
  heading?: PedestrianPoint;
  radius: number;
  walking: boolean;
  speed: number;
  canTraverse: (from: PedestrianPoint, to: PedestrianPoint) => boolean;
  /** The journey controller owns route/bay decisions; traffic only guards its swept body. */
  managedRoute?: boolean;
  /** Exact furniture contact only; envelopes include standing and every bent rig pose. */
  contacting?: boolean;
  contactRadius?: number;
}>;
export type LivingPedestrianStep = Readonly<{
  position: PedestrianPoint;
  moving: boolean;
  yielded: boolean;
  /** A normal move towards desired, rather than a sideways/passing manoeuvre. */
  progress: boolean;
  /** Multiply the caller's original dt by this value when advancing its route clock. */
  progressFraction: number;
}>;
type Actor = LivingPedestrianActor & { radius: number; speed: number };
const pairRadius = (actor: Actor, other: Actor) => (actor.contacting || other.contacting) && Number.isFinite(actor.contactRadius) && actor.contactRadius! > 0 ? actor.contactRadius! : actor.radius;
type YieldPlan = {
  blockerId: number; region: string; origin: PedestrianPoint; heading: PedestrianPoint;
  side: PedestrianPoint; clearance: number; passDistance: number; stage: 'clear' | 'pass';
};
const EPS = 1e-8;
const GAP = .035;
const MAX_DT = .1;
const point = (x: number, z: number): PedestrianPoint => ({ x, z });
const add = (a: PedestrianPoint, b: PedestrianPoint, scale = 1) => point(a.x + b.x * scale, a.z + b.z * scale);
const sub = (a: PedestrianPoint, b: PedestrianPoint) => point(a.x - b.x, a.z - b.z);
const dot = (a: PedestrianPoint, b: PedestrianPoint) => a.x * b.x + a.z * b.z;
const length = (a: PedestrianPoint) => Math.hypot(a.x, a.z);
const distance = (a: PedestrianPoint, b: PedestrianPoint) => length(sub(a, b));
const validPoint = (p: PedestrianPoint) => p && Number.isFinite(p.x) && Number.isFinite(p.z);
const unit = (v: PedestrianPoint) => length(v) > EPS ? add(point(0, 0), v, 1 / length(v)) : point(0, 0);
const towards = (from: PedestrianPoint, to: PedestrianPoint, budget: number) => add(from, sub(to, from), Math.min(1, budget / Math.max(EPS, distance(from, to))));

/** Closest simultaneous distance: tests both complete trajectories, not just their endpoints. */
function sweptDistance(a0: PedestrianPoint, a1: PedestrianPoint, b0: PedestrianPoint, b1: PedestrianPoint) {
  const start = sub(a0, b0), velocity = sub(sub(a1, a0), sub(b1, b0));
  const t = Math.max(0, Math.min(1, -dot(start, velocity) / Math.max(EPS, dot(velocity, velocity))));
  return length(add(start, velocity, t));
}

export function createLivingPedestrianTraffic() {
  const yielding = new Map<number, YieldPlan>();

  function step(input: readonly LivingPedestrianActor[], dt: number): Map<number, LivingPedestrianStep> {
    const actors: Actor[] = input.filter(a => Number.isFinite(a.id) && validPoint(a.position))
      .map(a => ({ ...a, radius: Number.isFinite(a.radius) ? Math.max(.01, a.radius) : .4, speed: Number.isFinite(a.speed) ? Math.max(0, a.speed) : 0 }))
      .sort((a, b) => a.id - b.id);
    const result = new Map<number, LivingPedestrianStep>();
    const byId = new Map(actors.map(a => [a.id, a]));
    for (const id of yielding.keys()) if (!byId.get(id)?.walking || byId.get(id)?.managedRoute) yielding.delete(id);
    const activeDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, MAX_DT) : 0;
    const fixed = (a: Actor, yielded = false): LivingPedestrianStep => ({ position: point(a.position.x, a.position.z), moving: false, yielded, progress: false, progressFraction: 0 });
    if (!activeDt) { for (const a of actors) result.set(a.id, fixed(a)); return result; }

    // ID order is stable regardless of input order. Earlier actors reserve their complete
    // trajectory; later actors test against that trajectory, and all others' initial positions.
    for (const a of actors) {
      if (!a.walking || !a.speed) { yielding.delete(a.id); result.set(a.id, fixed(a)); continue; }
      const budget = a.speed * activeDt;
      const desired = validPoint(a.desired) ? a.desired : a.position;
      const heading = unit(a.heading && validPoint(a.heading) && length(a.heading) > EPS ? a.heading : sub(desired, a.position));
      const neighbours = actors.filter(b => b.id !== a.id && b.region === a.region);
      const targetOf = (b: Actor) => result.get(b.id)?.position ?? b.position;
      const staticSegmentSafe = (from: PedestrianPoint, to: PedestrianPoint) => {
        try { return !!a.canTraverse(from, to); } catch { return false; }
      };
      const staticSafe = (to: PedestrianPoint) => staticSegmentSafe(a.position, to);
      const blockers = (to: PedestrianPoint, recovering = false) => neighbours.filter(b => {
        const end = targetOf(b), clearance = pairRadius(a, b) + pairRadius(b, a) + GAP;
        const start = sub(a.position, b.position), relativeMove = sub(sub(to, a.position), sub(end, b.position));
        if (recovering && length(start) < clearance - EPS) {
          // Legacy overlapping anchors recover gradually, never by teleporting or
          // moving deeper into an existing overlap. Other pairs remain fully swept.
          return dot(start, relativeMove) < -EPS || distance(to, end) < length(start) - EPS;
        }
        return sweptDistance(a.position, to, b.position, end) < clearance - EPS;
      }).sort((b, c) => distance(a.position, b.position) - distance(a.position, c.position) || b.id - c.id);
      const accept = (to: PedestrianPoint, recovering = false) => distance(a.position, to) <= budget + EPS && staticSafe(to) && !blockers(to, recovering).length;
      const finish = (to: PedestrianPoint, yielded: boolean, progress: boolean) => {
        const delta = sub(to, a.position), moving = length(delta) > EPS;
        // Use the original dt so a delayed browser frame never advances a whole
        // second of route time after only one capped visual movement step.
        const fraction = moving ? Math.max(0, Math.min(1, dot(delta, heading) / (a.speed * dt))) : 0;
        result.set(a.id, { position: to, moving, yielded, progress: progress && moving, progressFraction: fraction });
      };

      const overlap = neighbours.filter(b => distance(a.position, b.position) < pairRadius(a, b) + pairRadius(b, a) + GAP - EPS);
      if (overlap.length) {
        yielding.delete(a.id);
        let away = point(0, 0);
        for (const b of overlap) {
          const offset = sub(a.position, b.position);
          if (length(offset) > EPS) away = add(away, unit(offset));
          else {
            // Stable, opposite directions for a coincident pair; independent of array order.
            const angle = ((Math.min(a.id, b.id) * 73 + Math.max(a.id, b.id) * 37) % 360) * Math.PI / 180;
            away = add(away, point(Math.cos(angle), Math.sin(angle)), a.id < b.id ? -1 : 1);
          }
        }
        const startAngle = Math.atan2(away.z, away.x);
        const directions = [unit(away), ...Array.from({ length: 16 }, (_, i) => point(Math.cos(startAngle + i * Math.PI / 8), Math.sin(startAngle + i * Math.PI / 8)))];
        const recovery = directions.map(v => add(a.position, v, budget)).find(p => accept(p, true));
        if (recovery) finish(recovery, true, false); else result.set(a.id, fixed(a, true));
        // Recovery is never counted as route progress, even when its vector happens to align.
        const recovered = result.get(a.id)!; result.set(a.id, { ...recovered, progressFraction: 0 });
        continue;
      }

      // Do not chase a yielding walker sideways through a crossing. Give it time
      // to leave the priority route before taking the next forward step.
      if (!a.managedRoute && [...yielding.values()].some(p => p.blockerId === a.id && p.region === a.region && p.stage === 'clear')) {
        result.set(a.id, fixed(a, true)); continue;
      }

      let plan = yielding.get(a.id);
      const blocker = plan && byId.get(plan.blockerId);
      if (plan && (!blocker || blocker.region !== a.region || plan.region !== a.region ||
        dot(sub(a.position, plan.origin), plan.heading) >= plan.passDistance ||
        dot(sub(blocker.position, a.position), plan.heading) < -(a.radius + blocker.radius + .12))) {
        yielding.delete(a.id); plan = undefined;
      }
      if (!plan) {
        const direct = towards(a.position, desired, budget);
        if (accept(direct)) { finish(direct, false, true); continue; }
        if (a.managedRoute) { result.set(a.id, fixed(a, true)); continue; }
        const blockedBy = blockers(direct)[0];
        // Right of way is fixed by ID. The other walker sidesteps; an immobile
        // neighbour cannot yield, so any walker may go around it.
        if (!blockedBy || (blockedBy.walking && blockedBy.speed > 0 && a.id < blockedBy.id)) { result.set(a.id, fixed(a, true)); continue; }
        const axis = length(heading) > EPS ? heading : unit(sub(blockedBy.position, a.position));
        const clearance = a.radius + blockedBy.radius + .16;
        const right = point(axis.z, -axis.x);
        const passDistance = Math.max(.2, dot(sub(blockedBy.position, a.position), axis) + clearance);
        const side = [right, add(point(0, 0), right, -1)].find(v => {
          const lateral = add(a.position, v, clearance), pass = add(lateral, axis, passDistance);
          return staticSegmentSafe(a.position, lateral) && staticSegmentSafe(lateral, pass) && accept(add(a.position, v, Math.min(clearance, budget)));
        });
        if (!side) { result.set(a.id, fixed(a, true)); continue; }
        plan = { blockerId: blockedBy.id, region: a.region, origin: a.position, heading: axis, side, clearance,
          passDistance, stage: 'clear' };
        yielding.set(a.id, plan);
      }
      const clearTarget = add(plan.origin, plan.side, plan.clearance);
      if (plan.stage === 'clear' && distance(a.position, clearTarget) < .025) plan.stage = 'pass';
      const detourTarget = plan.stage === 'clear' ? clearTarget : add(clearTarget, plan.heading, plan.passDistance);
      const detour = towards(a.position, detourTarget, budget);
      if (accept(detour)) {
        finish(detour, true, false);
        // Pure sidesteps do not advance the route clock (roundoff must not do so either).
        if (plan.stage === 'clear') result.set(a.id, { ...result.get(a.id)!, progressFraction: 0 });
      } else result.set(a.id, fixed(a, true));
    }
    return result;
  }
  return { step, reset: () => yielding.clear() };
}
