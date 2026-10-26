/** Free presentation state. Persistent worlds consume server assignments; this controller never sends requests. */
export const HOME_LEISURE_ACTIVITIES = ['tea', 'television', 'mahjong', 'bench'] as const;
export type HomeLeisureActivity = typeof HOME_LEISURE_ACTIVITIES[number];
export type HomeLeisureScope = Readonly<{ groupId: string; ownerId: string; synthetic: boolean; optIn: boolean; persistent?: boolean }>;
export type HomeLeisureActor = Readonly<{ id: number; ownerId?: string; activity?: string; available?: boolean }>;
export type HomeLeisureSeat = Readonly<{
  id: string; station: HomeLeisureActivity; area: 'indoor' | 'outdoor'; x: number; y: number; z: number; yaw: number;
  physicalId?: string; reservedByActorId?: number; available?: boolean; cupId?: string;
  approach?: Readonly<{x:number;z:number}>; support?: readonly string[];
}>;
export type HomeLeisureInput = Readonly<{ scope: HomeLeisureScope; actors: readonly HomeLeisureActor[]; seats: readonly HomeLeisureSeat[] }>;
export type HomeLeisureAssignment = Readonly<{
  actorId: number; seatId: string; activity: HomeLeisureActivity; originalActivity: string | null; startedAtElapsed: number;
}>;
export type HomeLeisureSnapshot = Readonly<{
  revision: number; scope: HomeLeisureScope; permitted: boolean;
  assignments: readonly HomeLeisureAssignment[];
  television: Readonly<{ powered: boolean; watchingActorIds: readonly number[] }>;
}>;
export type HomeLeisureError = 'forbidden' | 'invalid_input' | 'unknown_activity' | 'unknown_actor' | 'unknown_seat'
  | 'actor_unavailable' | 'actor_busy' | 'seat_busy' | 'station_mismatch' | 'insufficient_actors' | 'insufficient_seats';
export type HomeLeisureResult = Readonly<
  { ok: true; changed: boolean; snapshot: HomeLeisureSnapshot } | { ok: false; error: HomeLeisureError; snapshot: HomeLeisureSnapshot }
>;
type Seat = HomeLeisureSeat & { physicalId: string };
const activity = (v: unknown): v is HomeLeisureActivity => typeof v === 'string' && (HOME_LEISURE_ACTIVITIES as readonly string[]).includes(v);
const id = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const label = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128 && v.trim() === v;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const bool = (v: unknown) => v === undefined || typeof v === 'boolean';
const elapsed = (v: unknown) => v === undefined || (finite(v) && v >= 0);

export function createHomeLeisureController(initial: HomeLeisureInput) {
  let scope: HomeLeisureScope = Object.freeze({ groupId: '', ownerId: '', synthetic: false, optIn: false });
  let valid = false, powered = false, revision = 0;
  let actors = new Map<number, HomeLeisureActor>(), seats = new Map<string, Seat>(), reservations = new Map<string, number>();
  let assignments = new Map<number, HomeLeisureAssignment>();
  const permitted = () => valid && (scope.synthetic === true || scope.persistent === true) && scope.optIn === true;
  function getSnapshot(): HomeLeisureSnapshot {
    const list = [...assignments.values()].sort((a, b) => a.actorId - b.actorId).map(a => Object.freeze({ ...a }));
    return Object.freeze({ revision, scope, permitted: permitted(), assignments: Object.freeze(list), television: Object.freeze({
      powered, watchingActorIds: Object.freeze(list.filter(a => a.activity === 'television').map(a => a.actorId)),
    }) });
  }
  const success = (changed = false): HomeLeisureResult => ({ ok: true, changed, snapshot: getSnapshot() });
  const failure = (error: HomeLeisureError): HomeLeisureResult => ({ ok: false, error, snapshot: getSnapshot() });
  const seatPermitted = (seat: Seat, actorId: number) => seat.available !== false
    && (!reservations.has(seat.physicalId) || reservations.get(seat.physicalId) === actorId);
  function reset(): HomeLeisureResult {
    const changed = assignments.size > 0 || powered; assignments.clear(); powered = false;
    if (changed) revision++; return success(changed);
  }
  function reconcile(input: HomeLeisureInput): HomeLeisureResult {
    const nextActors = new Map<number, HomeLeisureActor>(), nextSeats = new Map<string, Seat>(), nextReservations = new Map<string, number>();
    let nextValid = !!input && !!input.scope && label(input.scope.groupId) && label(input.scope.ownerId)
      && typeof input.scope.synthetic === 'boolean' && typeof input.scope.optIn === 'boolean' && bool(input.scope.persistent)
      && Array.isArray(input.actors) && Array.isArray(input.seats);
    if (nextValid) {
      for (const actor of input.actors) {
        if (!actor || !id(actor.id) || nextActors.has(actor.id) || !bool(actor.available)
          || (actor.ownerId !== undefined && !label(actor.ownerId))
          || (actor.activity !== undefined && (typeof actor.activity !== 'string' || actor.activity.length > 64))) { nextValid = false; break; }
        nextActors.set(actor.id, Object.freeze({ id: actor.id,
          ...(actor.ownerId === undefined ? {} : { ownerId: actor.ownerId }),
          ...(actor.activity === undefined ? {} : { activity: actor.activity }),
          ...(actor.available === undefined ? {} : { available: actor.available }) }));
      }
      for (const seat of input.seats) {
        if (!seat || !label(seat.id) || nextSeats.has(seat.id) || !activity(seat.station)
          || !['indoor', 'outdoor'].includes(seat.area) || ![seat.x, seat.y, seat.z, seat.yaw].every(finite)
          || (seat.physicalId !== undefined && !label(seat.physicalId)) || !bool(seat.available)
          || (seat.reservedByActorId !== undefined && !id(seat.reservedByActorId))
          || (seat.cupId !== undefined && !label(seat.cupId))) { nextValid = false; break; }
        const physicalId = seat.physicalId ?? seat.id;
        if (seat.reservedByActorId !== undefined) {
          if (nextReservations.has(physicalId) && nextReservations.get(physicalId) !== seat.reservedByActorId) { nextValid = false; break; }
          nextReservations.set(physicalId, seat.reservedByActorId);
        }
        nextSeats.set(seat.id, Object.freeze({ id: seat.id, station: seat.station, area: seat.area,
          x: seat.x, y: seat.y, z: seat.z, yaw: seat.yaw, physicalId,
          ...(seat.reservedByActorId === undefined ? {} : { reservedByActorId: seat.reservedByActorId }),
          ...(seat.available === undefined ? {} : { available: seat.available }),
          ...(seat.cupId === undefined ? {} : { cupId: seat.cupId }) }));
      }
    }
    const changedScope = !nextValid || scope.groupId !== input.scope.groupId || scope.ownerId !== input.scope.ownerId;
    const previous = JSON.stringify({ scope, actors: [...actors.values()], seats: [...seats.values()], assignments: [...assignments.values()], powered, valid });
    const oldActors = actors;
    scope = nextValid ? Object.freeze({ groupId: input.scope.groupId, ownerId: input.scope.ownerId,
      synthetic: input.scope.synthetic, optIn: input.scope.optIn,
      ...(input.scope.persistent === undefined ? {} : { persistent: input.scope.persistent }) }) : Object.freeze({ groupId: '', ownerId: '', synthetic: false, optIn: false });
    actors = nextValid ? nextActors : new Map(); seats = nextValid ? nextSeats : new Map(); reservations = nextValid ? nextReservations : new Map(); valid = nextValid;
    if (changedScope || !permitted()) { assignments.clear(); powered = false; }
    else {
      const retained = new Map<number, HomeLeisureAssignment>(), used = new Set<string>();
      // Existing oldest occupancy wins if geometry updates introduce an alias conflict.
      for (const assignment of [...assignments.values()].sort((a, b) => a.startedAtElapsed - b.startedAtElapsed || a.actorId - b.actorId)) {
        const actor = actors.get(assignment.actorId), seat = seats.get(assignment.seatId);
        if (!actor || actor.available === false || oldActors.get(actor.id)?.ownerId !== actor.ownerId || !seat
          || seat.station !== assignment.activity || !seatPermitted(seat, actor.id) || used.has(seat.physicalId)) continue;
        retained.set(actor.id, assignment); used.add(seat.physicalId);
      }
      assignments = retained;
      if (![...seats.values()].some(s => s.station === 'television' && s.available !== false)) powered = false;
    }
    const changed = previous !== JSON.stringify({ scope, actors: [...actors.values()], seats: [...seats.values()], assignments: [...assignments.values()], powered, valid });
    if (changed) revision++;
    return !nextValid ? failure('invalid_input') : success(changed);
  }
  function chooseSeat(station: HomeLeisureActivity, actorId: number, used: Set<string>) {
    return [...seats.values()].filter(s => s.station === station && seatPermitted(s, actorId) && !used.has(s.physicalId))
      .sort((a, b) => Number(reservations.get(b.physicalId) === actorId) - Number(reservations.get(a.physicalId) === actorId)
        || a.id.localeCompare(b.id, 'en'))[0];
  }
  function assign(options: { activity: HomeLeisureActivity; actorId: number; seatId?: string; elapsed?: number }): HomeLeisureResult {
    if (!permitted()) return failure('forbidden');
    if (!options || !activity(options.activity)) return failure('unknown_activity');
    if (!id(options.actorId) || !elapsed(options.elapsed) || (options.seatId !== undefined && !label(options.seatId))) return failure('invalid_input');
    const actor = actors.get(options.actorId); if (!actor) return failure('unknown_actor');
    if (actor.available === false) return failure('actor_unavailable');
    const current = assignments.get(actor.id);
    // Explicit per-actor selection may switch stations; commit only after a free seat is found.
    if (current && current.activity === options.activity && (options.seatId === undefined || options.seatId === current.seatId)) return success();
    const used = new Set([...assignments.values()].filter(a => a.actorId !== actor.id).map(a => seats.get(a.seatId)!.physicalId));
    let seat: Seat | undefined;
    if (options.seatId !== undefined) {
      seat = seats.get(options.seatId); if (!seat) return failure('unknown_seat');
      if (seat.station !== options.activity) return failure('station_mismatch');
      if (!seatPermitted(seat, actor.id) || used.has(seat.physicalId)) return failure('seat_busy');
    } else seat = chooseSeat(options.activity, actor.id, used);
    if (!seat) return failure('insufficient_seats');
    assignments.set(actor.id, Object.freeze({ actorId: actor.id, seatId: seat.id, activity: options.activity,
      originalActivity: current?.originalActivity ?? actor.activity ?? null, startedAtElapsed: options.elapsed ?? 0 }));
    revision++; return success(true);
  }
  function start(station: HomeLeisureActivity, options: { actorIds?: readonly number[]; count?: number; elapsed?: number } = {}): HomeLeisureResult {
    if (!permitted()) return failure('forbidden');
    if (!activity(station)) return failure('unknown_activity');
    if (!options || !elapsed(options.elapsed)) return failure('invalid_input');
    if (options.actorIds !== undefined && (!Array.isArray(options.actorIds) || !options.actorIds.length || !options.actorIds.every(id)
      || new Set(options.actorIds).size !== options.actorIds.length)) return failure('invalid_input');
    const count = options.count ?? options.actorIds?.length ?? (station === 'mahjong' ? 4 : 1);
    if (!Number.isSafeInteger(count) || count < 1 || count > 10 || (options.actorIds && options.actorIds.length !== count)) return failure('invalid_input');
    const selected: HomeLeisureActor[] = [];
    if (options.actorIds) {
      for (const actorId of options.actorIds) {
        const actor = actors.get(actorId); if (!actor) return failure('unknown_actor');
        if (actor.available === false) return failure('actor_unavailable');
        const current = assignments.get(actor.id); if (current && current.activity !== station) return failure('actor_busy');
        selected.push(actor);
      }
    } else {
      const existing = [...assignments.values()].filter(a => a.activity === station).sort((a, b) => a.actorId - b.actorId);
      for (const current of existing.slice(0, count)) selected.push(actors.get(current.actorId)!);
      const reservedActors = new Set([...seats.values()].filter(s => s.station === station && s.available !== false)
        .map(s => reservations.get(s.physicalId)).filter((value): value is number => value !== undefined));
      if (selected.length < count) for (const actor of [...actors.values()].sort((a, b) => Number(reservedActors.has(b.id)) - Number(reservedActors.has(a.id)) || a.id - b.id)) {
        if (assignments.has(actor.id) || actor.available === false || (actor.available !== true && ['walk', 'sleep'].includes(actor.activity ?? ''))) continue;
        selected.push(actor); if (selected.length === count) break;
      }
    }
    if (selected.length < count) return failure('insufficient_actors');
    const planned = new Map(assignments), used = new Set([...assignments.values()].map(a => seats.get(a.seatId)!.physicalId));
    let changed = false;
    for (const actor of selected) {
      if (planned.has(actor.id)) continue;
      const seat = chooseSeat(station, actor.id, used); if (!seat) return failure('insufficient_seats');
      planned.set(actor.id, Object.freeze({ actorId: actor.id, seatId: seat.id, activity: station,
        originalActivity: actor.activity ?? null, startedAtElapsed: options.elapsed ?? 0 }));
      used.add(seat.physicalId); changed = true;
    }
    if (changed) { assignments = planned; revision++; } return success(changed);
  }
  function stop(options: { activity?: HomeLeisureActivity; actorId?: number }): HomeLeisureResult {
    if (!permitted()) return failure('forbidden');
    if (!options || (options.activity === undefined && options.actorId === undefined)) return failure('invalid_input');
    if (options.activity !== undefined && !activity(options.activity)) return failure('unknown_activity');
    if (options.actorId !== undefined && (!id(options.actorId) || !actors.has(options.actorId))) return failure('unknown_actor');
    let changed = false;
    for (const a of assignments.values()) if ((options.activity === undefined || a.activity === options.activity)
      && (options.actorId === undefined || a.actorId === options.actorId)) { assignments.delete(a.actorId); changed = true; }
    if (changed) revision++; return success(changed);
  }
  function setTelevisionPower(value: boolean): HomeLeisureResult {
    if (!permitted()) return failure('forbidden');
    if (typeof value !== 'boolean') return failure('invalid_input');
    if (![...seats.values()].some(s => s.station === 'television' && s.available !== false)) return failure('insufficient_seats');
    const changed = powered !== value; powered = value; if (changed) revision++; return success(changed);
  }
  reconcile(initial);
  return Object.freeze({ getSnapshot, assign, start, stop, reset, reconcile, setTelevisionPower });
}
export type HomeLeisureController = ReturnType<typeof createHomeLeisureController>;

/** Optional local gesture phase, with no loop/timer: caller owns elapsed time and cup mesh. */
export function sampledTeaGesture(phase: number) {
  const elapsed = Number.isFinite(phase) ? Math.max(0, phase) : 0, cycle = elapsed % 12;
  const progress = cycle < 3 ? cycle / 3 : cycle < 5 ? 1 : cycle < 8 ? 1 - (cycle - 5) / 3 : 0;
  const lift = progress * progress * (3 - 2 * progress);
  return Object.freeze({ lift, shoulderX: -lift * .8, elbowX: -lift * 1.05, cupPitch: -lift * .25 });
}
