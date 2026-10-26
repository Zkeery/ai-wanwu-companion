import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHomeLeisureController, sampledTeaGesture, type HomeLeisureActor, type HomeLeisureInput, type HomeLeisureSeat } from '../lib/living-home-leisure';

const scope = { groupId: 'synthetic-home', ownerId: 'local-owner', synthetic: true, optIn: true };
const seat = (id: string, station: HomeLeisureSeat['station'], extra: Partial<HomeLeisureSeat> = {}): HomeLeisureSeat => ({ id, station, area: 'indoor', x: 0, y: .6, z: 0, yaw: 0, ...extra });
const seats = [seat('tea-1', 'tea'), seat('tea-2', 'tea'), ...[1, 2, 3].map(i => seat('tv-' + i, 'television')),
  ...[1, 2, 3, 4].map(i => seat('mahjong-' + i, 'mahjong')), seat('bench-1', 'bench', { area: 'outdoor' })];
function input(actors: readonly HomeLeisureActor[] = [{ id: 1, activity: 'rest' }, { id: 2, activity: 'observe' }, { id: 3, activity: 'walk' }], slots = seats): HomeLeisureInput {
  return { scope, actors, seats: slots };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('synthetic home leisure controller', () => {
  it('allows tea, TV and the untouched walking companion in different areas at the same time', () => {
    const source = input(), before = JSON.stringify(source), controller = createHomeLeisureController(source);
    expect(controller.start('tea').ok).toBe(true);
    expect(controller.start('television').ok).toBe(true);
    expect(controller.getSnapshot().assignments.map(a => [a.actorId, a.activity])).toEqual([[1, 'tea'], [2, 'television']]);
    expect(controller.getSnapshot().assignments.some(a => a.actorId === 3)).toBe(false);
    expect(JSON.stringify(source)).toBe(before);
    expect(controller.stop({ actorId: 1 }).ok).toBe(true);
    expect(source.actors[0].activity).toBe('rest');
  });

  it('keeps four mahjong players, one tea drinker, a viewer, a sleeper and a walker separate with eight actors', () => {
    const actors = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, activity: i === 6 ? 'sleep' : i === 7 ? 'walk' : 'rest' }));
    const controller = createHomeLeisureController(input(actors));
    expect(controller.start('mahjong').ok).toBe(true);
    expect(controller.start('tea').ok).toBe(true);
    expect(controller.start('television').ok).toBe(true);
    expect(controller.getSnapshot().assignments.map(a => [a.actorId, a.activity])).toEqual([
      [1, 'mahjong'], [2, 'mahjong'], [3, 'mahjong'], [4, 'mahjong'], [5, 'tea'], [6, 'television'],
    ]);
    expect(actors.slice(6).map(a => a.activity)).toEqual(['sleep', 'walk']);
    expect(new Set(controller.getSnapshot().assignments.map(a => a.seatId)).size).toBe(6);
  });

  it('distinguishes missing actors and missing seats with no partial group assignment', () => {
    const tooFew = createHomeLeisureController(input([{ id: 1 }, { id: 2 }, { id: 3 }]));
    expect(tooFew.start('mahjong')).toMatchObject({ ok: false, error: 'insufficient_actors' });
    expect(tooFew.getSnapshot().assignments).toEqual([]);
    const noSeats = createHomeLeisureController(input([{ id: 1 }], []));
    expect(noSeats.start('tea')).toMatchObject({ ok: false, error: 'insufficient_seats' });
    const partial = createHomeLeisureController(input([{ id: 1 }, { id: 2 }], [seat('single-tea', 'tea')]));
    expect(partial.start('tea', { count: 2 })).toMatchObject({ ok: false, error: 'insufficient_seats' });
    expect(partial.getSnapshot().assignments).toEqual([]);
  });

  it('returns explicit errors for unknown objects and does not grab an actor already seated elsewhere', () => {
    const controller = createHomeLeisureController(input());
    expect(controller.assign({ activity: 'tea', actorId: 99 })).toMatchObject({ ok: false, error: 'unknown_actor' });
    expect(controller.assign({ activity: 'tea', actorId: 1, seatId: 'missing' })).toMatchObject({ ok: false, error: 'unknown_seat' });
    expect(controller.assign({ activity: 'tea', actorId: 1, seatId: 'tv-1' })).toMatchObject({ ok: false, error: 'station_mismatch' });
    controller.assign({ activity: 'tea', actorId: 1 });
    const before = controller.getSnapshot();
    expect(controller.start('mahjong', { actorIds: [1] })).toMatchObject({ ok: false, error: 'actor_busy' });
    expect(controller.getSnapshot()).toEqual(before);
  });

  it('treats repeated simultaneous starts as the same intent, without expanding the party', async () => {
    const controller = createHomeLeisureController(input([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]));
    const results = await Promise.all(Array.from({ length: 20 }, async () => controller.start('tea', { elapsed: 123 })));
    expect(results.every(r => r.ok)).toBe(true);
    expect(results.filter(r => r.ok && r.changed)).toHaveLength(1);
    expect(controller.getSnapshot().assignments).toHaveLength(1);
    expect(controller.getSnapshot().assignments[0].startedAtElapsed).toBe(123);
  });

  it('physical aliases on a shared bench are mutually exclusive, including after stop releases it', () => {
    const slots = [seat('bench-tea', 'tea', { physicalId: 'real-bench' }), seat('bench-rest', 'bench', { physicalId: 'real-bench' })];
    const controller = createHomeLeisureController(input([{ id: 1 }, { id: 2 }], slots));
    expect(controller.assign({ activity: 'tea', actorId: 1 }).ok).toBe(true);
    expect(controller.assign({ activity: 'bench', actorId: 2 })).toMatchObject({ ok: false, error: 'insufficient_seats' });
    controller.stop({ actorId: 1 });
    expect(controller.assign({ activity: 'bench', actorId: 2 }).ok).toBe(true);
  });

  it('respects original sofa reservations across aliases and prioritizes an actor taking their own reserved seat', () => {
    const slots = [seat('a-free', 'tea'), seat('z-reserved', 'tea', { physicalId: 'sofa-original', reservedByActorId: 1 }),
      seat('sofa-tv-alias', 'television', { physicalId: 'sofa-original' })];
    const controller = createHomeLeisureController(input([{ id: 1 }, { id: 2 }], slots));
    expect(controller.assign({ activity: 'television', actorId: 2 })).toMatchObject({ ok: false, error: 'insufficient_seats' });
    expect(controller.start('tea', { actorIds: [1, 2] }).ok).toBe(true);
    expect(controller.getSnapshot().assignments.map(a => [a.actorId, a.seatId])).toEqual([[1, 'z-reserved'], [2, 'a-free']]);
  });

  it('automatically chooses the idle owner of the only reserved seat instead of reporting a false shortage', () => {
    const controller = createHomeLeisureController(input([{ id: 1 }, { id: 2 }], [seat('tea-only', 'tea', { reservedByActorId: 2 })]));
    expect(controller.start('tea').ok).toBe(true);
    expect(controller.getSnapshot().assignments.map(a => a.actorId)).toEqual([2]);
  });

  it('rejects explicitly unavailable actors and unknown activities before changing a snapshot', () => {
    const controller = createHomeLeisureController(input([{ id: 1, available: false }]));
    expect(controller.assign({ activity: 'tea', actorId: 1 })).toMatchObject({ ok: false, error: 'actor_unavailable' });
    expect(controller.start('tea', { actorIds: [1] })).toMatchObject({ ok: false, error: 'actor_unavailable' });
    expect(controller.start('unknown' as never)).toMatchObject({ ok: false, error: 'unknown_activity' });
    expect(controller.getSnapshot().assignments).toEqual([]);
  });

  it('geometry reconciliation releases removed/disabled seats, deleted actors and conflicting new aliases', () => {
    const actors = [{ id: 1 }, { id: 2 }], slots = [seat('tea-1', 'tea'), seat('bench-1', 'bench')];
    const controller = createHomeLeisureController(input(actors, slots));
    controller.assign({ activity: 'tea', actorId: 1, elapsed: 1 }); controller.assign({ activity: 'bench', actorId: 2, elapsed: 2 });
    controller.reconcile(input(actors, slots.map(s => ({ ...s, physicalId: 'now-shared' }))));
    expect(controller.getSnapshot().assignments.map(a => a.actorId)).toEqual([1]);
    controller.reconcile(input(actors, [seat('tea-1', 'tea', { available: false })]));
    expect(controller.getSnapshot().assignments).toEqual([]);
    controller.reconcile(input(actors, slots)); controller.assign({ activity: 'tea', actorId: 1 });
    controller.reconcile(input([{ id: 2 }], slots));
    expect(controller.getSnapshot().assignments).toEqual([]);
  });

  it('new original occupancy takes precedence over a stale renderer override', () => {
    const actors = [{ id: 1 }, { id: 2 }], controller = createHomeLeisureController(input(actors, [seat('tv', 'television')]));
    controller.assign({ activity: 'television', actorId: 1 });
    controller.reconcile(input(actors, [seat('tv', 'television', { reservedByActorId: 2 })]));
    expect(controller.getSnapshot().assignments).toEqual([]);
    expect(controller.assign({ activity: 'television', actorId: 2 }).ok).toBe(true);
  });

  it('screen power and viewers are independent; switching off never evicts a watcher', () => {
    const controller = createHomeLeisureController(input());
    controller.start('television', { actorIds: [1] });
    expect(controller.getSnapshot().television).toEqual({ powered: false, watchingActorIds: [1] });
    controller.setTelevisionPower(true); controller.setTelevisionPower(false);
    expect(controller.getSnapshot().television).toEqual({ powered: false, watchingActorIds: [1] });
    controller.setTelevisionPower(true); controller.stop({ activity: 'television' });
    expect(controller.getSnapshot().television).toEqual({ powered: true, watchingActorIds: [] });
    controller.reset(); expect(controller.getSnapshot().television.powered).toBe(false);
  });

  it.each(['groupId', 'ownerId'] as const)('clears assignments and television state on %s change', key => {
    const source = input(), controller = createHomeLeisureController(source);
    controller.start('tea'); controller.setTelevisionPower(true);
    controller.reconcile({ ...source, scope: { ...scope, [key]: 'another-synthetic-context' } });
    expect(controller.getSnapshot().assignments).toEqual([]);
    expect(controller.getSnapshot().television.powered).toBe(false);
  });

  it('drops an override when the same actor id changes owner and restores the untouched original source', () => {
    const source = input([{ id: 1, ownerId: 'old', activity: 'sleep' }]);
    const controller = createHomeLeisureController(source);
    controller.assign({ activity: 'tea', actorId: 1 });
    expect(controller.getSnapshot().assignments[0].originalActivity).toBe('sleep');
    controller.reconcile({ ...source, actors: [{ id: 1, ownerId: 'new', activity: 'walk' }] });
    expect(controller.getSnapshot().assignments).toEqual([]);
    expect(source.actors[0].activity).toBe('sleep');
  });

  it.each([{ synthetic: false, optIn: true }, { synthetic: true, optIn: false }, { synthetic: false, optIn: false }])('never operates without both synthetic and opt-in guard: %j', flags => {
    const source = input(), controller = createHomeLeisureController({ ...source, scope: { ...scope, ...flags } });
    expect(controller.start('tea')).toMatchObject({ ok: false, error: 'forbidden' });
    expect(controller.assign({ activity: 'tea', actorId: 1 })).toMatchObject({ ok: false, error: 'forbidden' });
    expect(controller.setTelevisionPower(true)).toMatchObject({ ok: false, error: 'forbidden' });
    expect(controller.getSnapshot().assignments).toEqual([]);
  });

  it('revoking opt-in clears active local overlays immediately', () => {
    const source = input(), controller = createHomeLeisureController(source); controller.start('tea'); controller.setTelevisionPower(true);
    controller.reconcile({ ...source, scope: { ...scope, optIn: false } });
    expect(controller.getSnapshot()).toMatchObject({ permitted: false, assignments: [], television: { powered: false } });
  });

  it('rejects duplicate/invalid input or ambiguous original reservations rather than overlapping occupants', () => {
    const source = input(); const controller = createHomeLeisureController(source); controller.start('tea');
    expect(controller.reconcile(input([{ id: 1 }, { id: 1 }]))).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(controller.getSnapshot().assignments).toEqual([]);
    expect(controller.start('tea')).toMatchObject({ ok: false, error: 'forbidden' });
    expect(controller.reconcile(input([{ id: 1 }], [seat('bad', 'tea', { x: NaN })]))).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(controller.reconcile(input([{ id: 1 }, { id: 2 }], [seat('a', 'tea', { physicalId: 'one', reservedByActorId: 1 }),
      seat('b', 'bench', { physicalId: 'one', reservedByActorId: 2 })]))).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('has no timer, network, wall clock or business write side effects, and exposes detached frozen snapshots', () => {
    vi.stubGlobal('fetch', () => { throw new Error('no network'); });
    vi.spyOn(globalThis, 'setInterval').mockImplementation(() => { throw new Error('no timer'); });
    vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('no wall clock'); });
    const source = input(), before = JSON.stringify(source), controller = createHomeLeisureController(source);
    controller.assign({ activity: 'tea', actorId: 1, elapsed: 12 });
    expect(sampledTeaGesture(2)).toEqual(sampledTeaGesture(14));
    const snapshot = controller.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.assignments)).toBe(true);
    expect(Object.isFrozen(snapshot.assignments[0])).toBe(true);
    controller.stop({ actorId: 1 }); expect(snapshot.assignments).toHaveLength(1);
    expect(JSON.stringify(source)).toBe(before);
  });
});
