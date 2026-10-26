import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering, type Gathering } from '@/lib/gatherings';
import type { HomeWorldDoorId } from '@/lib/living-home-world-meshes';

const ENTRY: HomeWorldDoorId = 'home-main-entry-door', ROOM: HomeWorldDoorId = 'home-room-connection-door', DOORS = [ENTRY, ROOM];
const gpu = vi.hoisted(() => ({ instances: [] as Array<{ scene: THREE.Scene | null; loop: ((time: number) => void) | null }> }));
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class OfflineRenderer {
    domElement = document.createElement('canvas'); shadowMap = { enabled: false, type: 0 }; outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 1;
    scene: THREE.Scene | null = null; loop: ((time: number) => void) | null = null;
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn();
    setAnimationLoop = vi.fn((loop: ((time: number) => void) | null) => { this.loop = loop; });
    render = vi.fn((scene: THREE.Scene, camera: THREE.Camera) => { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); this.scene = scene; });
    constructor() { gpu.instances.push(this); }
  }
  return { ...actual, WebGLRenderer: OfflineRenderer };
});
type Renderer = typeof gpu.instances[number];
type Flags = { realistic?: boolean; localLeisurePreview?: boolean; localRoomTransitions?: boolean; localCompanionDoors?: boolean; localReferenceVilla?: boolean };
type DoorEvent = { id: HomeWorldDoorId; open: boolean; source?: 'manual' | 'companion'; at: number };
type Body = { root: THREE.Object3D; position: THREE.Vector3; box: THREE.Box3; radius: number };
const worlds: Array<ReturnType<typeof createLivingWorld>> = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); gpu.instances.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('autonomous home doors must remain offline'); }));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
});
afterEach(() => {
  worlds.splice(0).forEach(world => world.dispose()); expect(fetch).not.toHaveBeenCalled(); document.body.replaceChildren();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function snapshot(opposed = false): Gathering {
  const rows = opposed ? [
    { id: 4, name: '离床回院子的伙伴', activity: 'sleep', area: 'bedroom', x: .75, y: .65 },
    { id: 5, name: '进屋睡觉的伙伴', activity: 'observe', area: 'outdoor', x: .35, y: .55 },
  ] : [{ id: 4, name: '自主过门的伙伴', activity: 'observe', area: 'outdoor', x: .35, y: .55 }];
  return parseGathering({ id: 'synthetic-autonomous-home-doors', title: '伙伴自主开关房门', scene_type: 'home', revision: 1, closed: false, is_manager: true, me: 'A',
    members: [{ id: 'A', name: '合成主人', manager: true }], companions: rows.map(c => ({ ...c, owner_id: 'A',
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features' } })),
    items: [{ id: 'saved-tree', kind: 'tree', x: .15, y: .22, mine: true, contributor_name: '合成', growth_status: null },
      { id: 'saved-bench', kind: 'bench', x: .75, y: .65, mine: true, contributor_name: '合成', growth_status: null }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
function target(group: Gathering, activity: 'sleep' | 'walk' | 'observe'): Gathering {
  return { ...group, revision: group.revision + 1, companions: group.companions.map(c => ({ ...c, activity, area: activity === 'sleep' ? 'bedroom' : 'outdoor' })) };
}
function setup(group = snapshot(), flags: Flags = {}, legacy?: (id: HomeWorldDoorId, open: boolean) => void) {
  const host = document.createElement('div'), labels = document.createElement('div'), events: DoorEvent[] = [];
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } }); document.body.append(host, labels);
  const changed = vi.fn((id: HomeWorldDoorId, open: boolean, source?: 'manual' | 'companion') => { events.push({ id, open, source, at: Date.now() / 1000 }); legacy?.(id, open); });
  const options = { realistic: true, localLeisurePreview: true, localRoomTransitions: true, localCompanionDoors: true, ...flags };
  const world = createLivingWorld(host, labels, group, vi.fn(), changed, options); worlds.push(world);
  return { world, renderer: gpu.instances.at(-1)!, group, host, events, changed };
}
function actor(renderer: Renderer, id = 4) { const root = renderer.scene!.children.find(o => o.userData.characterId === id); expect(root).toBeDefined(); return root!; }
function door(renderer: Renderer, id: HomeWorldDoorId) { const root = renderer.scene!.getObjectByName(id); expect(root).toBeDefined(); return root!; }
function openness(renderer: Renderer, id: HomeWorldDoorId) { return door(renderer, id).userData.homeDoorOpenness as number; }
function closed(renderer: Renderer) { return DOORS.every(id => openness(renderer, id) === 0); }
function step(renderer: Renderer, delta = 100) { vi.setSystemTime(Date.now() + delta); expect(renderer.loop).toBeTypeOf('function'); renderer.loop!(Date.now()); }
function body(root: THREE.Object3D): Body {
  expect(root.visible, 'door traffic cannot hide an ordinary companion').toBe(true);
  const box = new THREE.Box3(), point = new THREE.Vector3(); let radius = 0;
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) return;
    const vertices = object.geometry.getAttribute('position'), indices = object.geometry.index;
    for (let i = 0; i < (indices?.count ?? vertices.count); i++) {
      point.fromBufferAttribute(vertices, indices ? indices.getX(i) : i).applyMatrix4(object.matrixWorld); box.expandByPoint(point);
      radius = Math.max(radius, Math.hypot(point.x - root.position.x, point.z - root.position.z));
    }
  });
  expect(box.isEmpty()).toBe(false); return { root, position: root.position.clone(), box, radius };
}
function bodies(renderer: Renderer) { return renderer.scene!.children.filter(o => typeof o.userData.characterId === 'number').map(body); }
function furniture(renderer: Renderer) {
  const scene = renderer.scene!, rows: Array<{ name?: string; item?: string; matrix: number[] }> = [];
  for (const name of ['home-farmhouse-tea-table', 'home-mahjong-table', 'home-common-gabled-roof', ENTRY + '-frame', ROOM + '-frame', 'room-bed-0-mattress']) {
    const object = scene.getObjectByName(name); expect(object, name).toBeDefined(); rows.push({ name, matrix: object!.matrixWorld.toArray() });
  }
  scene.traverse(object => { if (typeof object.userData.homeItemId === 'string') rows.push({ item: object.userData.homeItemId, matrix: object.matrixWorld.toArray() }); });
  expect(rows.filter(row => row.item).map(row => row.item).sort()).toEqual(['saved-bench', 'saved-tree']);
  return () => rows.forEach(row => {
    let object = row.name ? scene.getObjectByName(row.name) : undefined;
    if (row.item) scene.traverse(candidate => { if (candidate.userData.homeItemId === row.item) object = candidate; });
    expect(object, row.name ?? row.item).toBeDefined(); expect(object!.matrixWorld.toArray()).toEqual(row.matrix);
  });
}
function trace(fixture: ReturnType<typeof setup>) {
  const { renderer } = fixture, lastUse = new Map<HomeWorldDoorId, number>(), angles = new Map(DOORS.map(id => [id, door(renderer, id).getObjectByName(id + '-leaf')!.rotation.y]));
  const sweeps = new Map<string, THREE.Box3[]>(), sides = new Map<string, number>(), crossings = new Map<number, string[]>();
  let previous = bodies(renderer), frame = 0, eventIndex = fixture.events.length, minimumGap = Infinity;
  const tail: unknown[] = [];
  function fullSweep(id: HomeWorldDoorId) {
    const group = door(renderer, id), leaf = group.getObjectByName(id + '-leaf')!; let boxes = sweeps.get(leaf.uuid); if (boxes) return boxes;
    const inverse = leaf.matrixWorld.clone().invert(), meshes: Array<{ object: THREE.Mesh; relative: THREE.Matrix4 }> = [];
    leaf.traverse(object => { if (object instanceof THREE.Mesh) meshes.push({ object, relative: new THREE.Matrix4().multiplyMatrices(inverse, object.matrixWorld) }); });
    boxes = [];
    for (let n = 0; n <= 24; n++) {
      const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), group.userData.homeDoorOpenAngle * n / 24);
      const local = new THREE.Matrix4().compose(leaf.position, quaternion, leaf.scale), world = new THREE.Matrix4().multiplyMatrices(leaf.parent!.matrixWorld, local), box = new THREE.Box3(), point = new THREE.Vector3();
      for (const { object, relative } of meshes) {
        const matrix = new THREE.Matrix4().multiplyMatrices(world, relative), vertices = object.geometry.getAttribute('position'), indices = object.geometry.index;
        for (let i = 0; i < (indices?.count ?? vertices.count); i++) box.expandByPoint(point.fromBufferAttribute(vertices, indices ? indices.getX(i) : i).applyMatrix4(matrix));
      }
      boxes.push(box);
    }
    sweeps.set(leaf.uuid, boxes); return boxes;
  }
  const describe = () => bodies(renderer).map(b => ({ id: b.root.userData.characterId, position: b.position.toArray(), phase: b.root.userData.homeJourney?.phase, area: b.root.userData.homeRegion, portal: b.root.userData.journeyPortal }));
  return {
    crossings,
    report() { return { frame, minimumGap, crossings: Object.fromEntries(crossings), doors: DOORS.map(id => ({ id, openness: openness(renderer, id) })), actors: describe(), events: fixture.events, tail }; },
    next(delta = 100) {
      step(renderer, delta); frame++; const current = bodies(renderer), now = Date.now() / 1000, scene = renderer.scene!;
      tail.push({ frame, actors: describe(), doors: DOORS.map(id => openness(renderer, id)) }); if (tail.length > 20) tail.shift();
      const context = () => JSON.stringify({ frame, actors: describe(), doors: DOORS.map(id => openness(renderer, id)) });
      for (const row of current) {
        const old = previous.find(b => b.root.userData.characterId === row.root.userData.characterId); if (!old) continue;
        expect(row.position.distanceTo(old.position), 'actual body jumped ' + context()).toBeLessThan(.2);
        for (const id of DOORS) {
          const group = door(renderer, id), opening = group.userData.opening as { along: 'x' | 'z'; center: { x: number; z: number }; min: number; max: number };
          const along = opening.along, normal = along === 'x' ? 'z' : 'x', was = old.position[normal] - opening.center[normal], value = row.position[normal] - opening.center[normal], key = row.root.userData.characterId + '/' + id;
          const before = sides.get(key) ?? (Math.abs(was) > 1e-6 ? Math.sign(was) : 0), side = Math.abs(value) > 1e-6 ? Math.sign(value) : 0;
          const t = was === value ? 0 : was / (was - value), across = THREE.MathUtils.lerp(old.position[along], row.position[along], t);
          if (before && side && side !== before && across >= opening.min && across <= opening.max) {
            const rows = crossings.get(row.root.userData.characterId) ?? []; rows.push(id); crossings.set(row.root.userData.characterId, rows);
            expect(openness(renderer, id), 'actual center crossed a partly open door ' + context()).toBeCloseTo(1, 7);
          }
          if (side) sides.set(key, side);
          if (row.box.min[normal] < opening.center[normal] - .015 && row.box.max[normal] > opening.center[normal] + .015 && row.box.max[along] > opening.min && row.box.min[along] < opening.max) {
            expect(openness(renderer, id), 'body entered a partly open aperture ' + context()).toBeCloseTo(1, 7);
            expect(row.box.min[along], context()).toBeGreaterThanOrEqual(opening.min - .002); expect(row.box.max[along], context()).toBeLessThanOrEqual(opening.max + .002);
          }
        }
      }
      for (const id of DOORS) {
        const sweep = fullSweep(id), angle = door(renderer, id).getObjectByName(id + '-leaf')!.rotation.y;
        if (current.some(row => row.root.userData.journeyPortal === id || sweep.some(box => row.box.intersectsBox(box)))) lastUse.set(id, now);
        if (Math.abs(angle - angles.get(id)!) > 1e-8) for (const row of [...previous, ...current]) expect(sweep.some(box => row.box.intersectsBox(box)), 'moving leaf full sweep intersects a real body ' + id + ' ' + context()).toBe(false);
        angles.set(id, angle);
      }
      for (const event of fixture.events.slice(eventIndex)) if (event.source === 'companion' && !event.open) expect(event.at - (lastUse.get(event.id) ?? -Infinity), 'automatic close before the 0.8s idle window').toBeGreaterThanOrEqual(.69);
      eventIndex = fixture.events.length;
      for (let i = 0; i < current.length; i++) for (let j = i + 1; j < current.length; j++) {
        const a = current[i], b = current[j], oldA = previous.find(v => v.root === a.root)!, oldB = previous.find(v => v.root === b.root)!;
        expect(a.box.min.x < b.box.max.x - 1e-5 && a.box.max.x > b.box.min.x + 1e-5 && a.box.min.z < b.box.max.z - 1e-5 && a.box.max.z > b.box.min.z + 1e-5, 'real bodies overlap ' + context()).toBe(false);
        const x = oldA.position.x - oldB.position.x, z = oldA.position.z - oldB.position.z, dx = a.position.x - oldA.position.x - b.position.x + oldB.position.x, dz = a.position.z - oldA.position.z - b.position.z + oldB.position.z;
        const length = dx * dx + dz * dz, time = length < 1e-14 ? 0 : Math.max(0, Math.min(1, -(x * dx + z * dz) / length));
        const gap = Math.hypot(x + time * dx, z + time * dz) - Math.max(a.radius, oldA.radius) - Math.max(b.radius, oldB.radius); minimumGap = Math.min(minimumGap, gap); expect(gap, context()).toBeGreaterThanOrEqual(-1e-4);
      }
      const physicalSaved: THREE.Object3D[] = [];
      scene.traverse(object => { if (object.userData.homeNavObstacle !== true) return; for (let p: THREE.Object3D | null = object; p; p = p.parent) if (['saved-tree', 'saved-bench'].includes(p.userData.homeItemId)) { physicalSaved.push(object); return; } });
      expect(physicalSaved.length).toBeGreaterThanOrEqual(2);
      for (const row of current) for (const solid of physicalSaved) expect(row.box.intersectsBox(new THREE.Box3().setFromObject(solid, true)), 'body crossed saved furniture ' + context()).toBe(false);
      previous = current; return current;
    },
    until(predicate: () => boolean, limit = 900) { for (let i = 0; i < limit; i++) { this.next(); if (predicate()) return; } throw new Error('AUTONOMOUS_DOOR_STALL ' + JSON.stringify(this.report())); },
  };
}
function noFlapping(events: DoorEvent[], maxOpens: number) {
  for (const id of DOORS) {
    const rows = events.filter(event => event.id === id && event.source === 'companion'); expect(rows.filter(row => row.open).length).toBeLessThanOrEqual(maxOpens);
    rows.forEach((row, i) => expect(row.open, id + ': duplicate or out-of-order automatic target event').toBe(i % 2 === 0));
  }
}

describe('real synthetic home companion-operated doors', () => {
  it('opens both initially closed doors without a manual command, sleeps, returns, and closes each idle auto-owned leaf', () => {
    const group = snapshot(), sleeping = target(group, 'sleep'), walking = target(sleeping, 'walk'), originals = [JSON.stringify(group), JSON.stringify(sleeping), JSON.stringify(walking)], fixture = setup(group);
    expect(closed(fixture.renderer)).toBe(true); expect(fixture.events).toEqual([]); const checkFurniture = furniture(fixture.renderer), before = actor(fixture.renderer).position.toArray();
    fixture.world.update(sleeping, null); expect(actor(fixture.renderer).position.toArray()).toEqual(before); let path = trace(fixture); fixture.world.setMotion(true);
    path.until(() => !!actor(fixture.renderer).userData.sleepingBed); expect(path.crossings.get(4)).toEqual([ENTRY, ROOM]); path.until(() => closed(fixture.renderer), 30);
    for (const id of DOORS) { expect(fixture.events.filter(row => row.id === id && row.open && row.source === 'companion')).toHaveLength(1); expect(fixture.events.filter(row => row.id === id && !row.open && row.source === 'companion')).toHaveLength(1); }
    const first = path.report(), bedPosition = actor(fixture.renderer).position.toArray(); fixture.world.update(walking, null); expect(actor(fixture.renderer).position.toArray()).toEqual(bedPosition); path = trace(fixture); path.until(() => actor(fixture.renderer).userData.homeRegion === 'outdoor' && !actor(fixture.renderer).userData.homeJourney?.active);
    expect(path.crossings.get(4)).toEqual([ROOM, ENTRY]); path.until(() => closed(fixture.renderer), 30); noFlapping(fixture.events, 2);
    expect(fixture.events.every(row => row.source === 'companion')).toBe(true); checkFurniture(); expect([JSON.stringify(group), JSON.stringify(sleeping), JSON.stringify(walking)]).toEqual(originals);
    console.info('AUTONOMOUS_DOORS_ROUNDTRIP ' + JSON.stringify({ outward: first, returned: path.report() }));
  }, 20_000);

  it('lets opposite actors open, share, and close the actual doors without clipping bodies, repeated flapping, or deadlock', () => {
    const group = snapshot(true), next: Gathering = { ...group, revision: 2, companions: group.companions.map(c => c.id === 4 ? { ...c, activity: 'walk', area: 'outdoor' } : { ...c, activity: 'sleep', area: 'bedroom' }) }, originals = [JSON.stringify(group), JSON.stringify(next)], fixture = setup(group);
    expect(closed(fixture.renderer)).toBe(true); const checkFurniture = furniture(fixture.renderer), before = [4, 5].map(id => actor(fixture.renderer, id).position.toArray()); fixture.world.update(next, null); expect([4, 5].map(id => actor(fixture.renderer, id).position.toArray())).toEqual(before); const path = trace(fixture); fixture.world.setMotion(true);
    path.until(() => actor(fixture.renderer, 4).userData.homeRegion === 'outdoor' && !actor(fixture.renderer, 4).userData.homeJourney?.active && !!actor(fixture.renderer, 5).userData.sleepingBed);
    expect(path.crossings.get(4)).toEqual([ROOM, ENTRY]); expect(path.crossings.get(5)).toEqual([ENTRY, ROOM]); path.until(() => closed(fixture.renderer), 40);
    noFlapping(fixture.events, 2); expect(fixture.events.every(row => row.source === 'companion')).toBe(true); checkFurniture(); expect([JSON.stringify(group), JSON.stringify(next)]).toEqual(originals);
    console.info('AUTONOMOUS_DOORS_OPPOSED ' + JSON.stringify(path.report()));
  }, 20_000);

  it('freezes an opening leaf and the actor through a long pause and resumes without a body or door-angle jump', () => {
    const group = snapshot(), next = target(group, 'sleep'), fixture = setup(group); fixture.world.update(next, null); const path = trace(fixture); fixture.world.setMotion(true);
    path.until(() => openness(fixture.renderer, ENTRY) > 0 && openness(fixture.renderer, ENTRY) < 1);
    const position = actor(fixture.renderer).position.toArray(), angles = DOORS.map(id => door(fixture.renderer, id).getObjectByName(id + '-leaf')!.rotation.y), events = fixture.events.length;
    fixture.world.setMotion(false); expect(DOORS.map(id => door(fixture.renderer, id).getObjectByName(id + '-leaf')!.rotation.y)).toEqual(angles);
    vi.setSystemTime(Date.now() + 3_600_000); for (let i = 0; i < 3; i++) { fixture.world.reset(); fixture.world.update({ ...next, revision: i + 3 }, null); }
    expect(actor(fixture.renderer).position.toArray()).toEqual(position); expect(DOORS.map(id => door(fixture.renderer, id).getObjectByName(id + '-leaf')!.rotation.y)).toEqual(angles); expect(fixture.events.length).toBe(events);
    fixture.world.setMotion(true); path.next(50); expect(Math.abs(door(fixture.renderer, ENTRY).getObjectByName(ENTRY + '-leaf')!.rotation.y - angles[0])).toBeLessThan(.4);
    path.until(() => !!actor(fixture.renderer).userData.sleepingBed); path.until(() => closed(fixture.renderer), 30); noFlapping(fixture.events, 1);
  }, 20_000);

  it('releases obsolete automatic requests on cancel, departure, scope replacement, and disposal', () => {
    for (const mode of ['cancel', 'remove', 'scope', 'dispose'] as const) {
      const group = snapshot(), next = target(group, 'sleep'), originals = [JSON.stringify(group), JSON.stringify(next)], fixture = setup(group); fixture.world.update(next, null); const path = trace(fixture); fixture.world.setMotion(true);
      path.until(() => openness(fixture.renderer, ENTRY) === 1);
      if (mode === 'dispose') {
        const staleLoop = fixture.renderer.loop!; fixture.world.dispose(); const count = fixture.events.length; vi.setSystemTime(Date.now() + 3_600_000); staleLoop(Date.now());
        expect(fixture.events.length).toBe(count); expect(fixture.renderer.loop).toBeNull(); expect(fixture.host.querySelector('canvas')).toBeNull();
      } else {
        const replacement = mode === 'cancel' ? target(next, 'observe') : mode === 'remove' ? { ...next, revision: 3, companions: [] } : { ...group, id: 'synthetic-replacement-autonomous-doors', revision: 3 };
        fixture.world.update(replacement, null);
        for (let i = 0; i < 500; i++) { if (mode === 'cancel') path.next(); else step(fixture.renderer); if (mode !== 'remove') expect(actor(fixture.renderer).userData.sleepingBed).toBeUndefined(); }
        expect(closed(fixture.renderer), mode + ': abandoned door ownership must not persist').toBe(true); noFlapping(fixture.events, 1);
        if (mode === 'remove') expect(fixture.renderer.scene!.children.some(o => o.userData.characterId === 4)).toBe(false);
      }
      expect([JSON.stringify(group), JSON.stringify(next)]).toEqual(originals);
    }
  }, 20_000);

  it('keeps manually opened doors open after the journey and preserves legacy two-argument callbacks', () => {
    const group = snapshot(), next = target(group, 'sleep'), legacy = vi.fn((id: HomeWorldDoorId, open: boolean) => ({ id, open })), fixture = setup(group, {}, legacy); fixture.world.setHouseView('interior');
    for (const id of DOORS) fixture.world.setDoorOpen(id, true);
    expect(fixture.events.map(row => row.source)).toEqual(['manual', 'manual']); expect(legacy.mock.calls).toEqual([[ENTRY, true], [ROOM, true]]);
    fixture.world.update(next, null); const path = trace(fixture); fixture.world.setMotion(true); path.until(() => !!actor(fixture.renderer).userData.sleepingBed);
    for (let i = 0; i < 50; i++) path.next(); expect(DOORS.map(id => openness(fixture.renderer, id))).toEqual([1, 1]); expect(fixture.events).toHaveLength(2);
    for (const id of DOORS) fixture.world.setDoorOpen(id, false); path.until(() => closed(fixture.renderer), 20); expect(fixture.events.every(row => row.source === 'manual')).toBe(true);
  }, 20_000);

  it('requires every explicit gate and leaves default-false door behavior identical to its legacy control', () => {
    for (const flags of [{ localCompanionDoors: undefined }, { localCompanionDoors: false }, { realistic: false }, { localLeisurePreview: false }, { localRoomTransitions: false }, {}] as Flags[]) {
      const group = snapshot(); if (Object.keys(flags).length === 0) group.id = 'ordinary-production-autonomous-doors';
      const actual = setup(group, flags), control = setup(group, { ...flags, localCompanionDoors: false });
      expect(DOORS.map(id => openness(actual.renderer, id))).toEqual(DOORS.map(id => openness(control.renderer, id)));
      const next = target(group, 'sleep'); actual.world.update(next, null); control.world.update(next, null); actual.world.setMotion(true); control.world.setMotion(true);
      for (let i = 0; i < 60; i++) { vi.setSystemTime(Date.now() + 100); actual.renderer.loop!(Date.now()); control.renderer.loop!(Date.now()); }
      expect(actual.events.some(row => row.source === 'companion')).toBe(false); expect(DOORS.map(id => openness(actual.renderer, id))).toEqual(DOORS.map(id => openness(control.renderer, id)));
      expect(actual.events.map(({ id, open, source }) => ({ id, open, source }))).toEqual(control.events.map(({ id, open, source }) => ({ id, open, source })));
    }
  }, 20_000);

  it('keeps the reference villa upper floor visual while autonomously using the original first-floor portals for a complete roundtrip', () => {
    const group = snapshot(), sleeping = target(group, 'sleep'), walking = target(sleeping, 'walk'), originals = [JSON.stringify(group), JSON.stringify(sleeping), JSON.stringify(walking)];
    const control = setup(group, { localReferenceVilla: false }), fixture = setup(group, { localReferenceVilla: true }), scene = fixture.renderer.scene!;
    expect(fixture.host.dataset.houseStyle).toBe('reference-villa'); expect(control.host.dataset.houseStyle).toBe('farmhouse');
    const upper = scene.getObjectByName('home-reference-villa-upper-and-roof'); expect(upper).toBeDefined(); expect(upper!.userData.homeUpperFloorAccessible).toBe(false);
    expect(new THREE.Box3().setFromObject(upper!, true).max.y, 'the flag must produce actual upper-floor and roof geometry').toBeGreaterThan(4);
    const environment = scene.children.find(object => object.userData.referenceVilla); expect(environment?.userData.referenceVilla).toMatchObject({ accessibleFloors: [1], localVisitFloors: [1, 2], upperFloorVisualOnly: false });
    for (const name of [ENTRY, ROOM, ENTRY + '-frame', ROOM + '-frame', 'sofa-main', 'home-farmhouse-tea-table', 'home-mahjong-table', 'room-bed-0-mattress']) {
      const before = control.renderer.scene!.getObjectByName(name), actual = scene.getObjectByName(name); expect(before, name).toBeDefined(); expect(actual, name).toBeDefined();
      expect(actual!.matrixWorld.toArray(), name + ': preserve the original first-floor world transform').toEqual(before!.matrixWorld.toArray());
    }
    for (const id of DOORS) expect(door(fixture.renderer, id).userData.opening).toEqual(door(control.renderer, id).userData.opening);
    for (const id of ['saved-tree', 'saved-bench']) {
      let original: THREE.Object3D | undefined, actual: THREE.Object3D | undefined;
      control.renderer.scene!.traverse(object => { if (object.userData.homeItemId === id) original = object; }); scene.traverse(object => { if (object.userData.homeItemId === id) actual = object; });
      expect(actual).toBeDefined(); expect(original).toBeDefined(); expect(actual!.matrixWorld.toArray()).toEqual(original!.matrixWorld.toArray());
    }
    control.world.dispose(); expect(closed(fixture.renderer)).toBe(true); expect(fixture.events).toEqual([]); const checkFurniture = furniture(fixture.renderer), initial = actor(fixture.renderer).position.toArray();
    fixture.world.update(sleeping, null); expect(actor(fixture.renderer).position.toArray()).toEqual(initial); let path = trace(fixture); fixture.world.setMotion(true);
    path.until(() => { expect(actor(fixture.renderer).position.y, 'companions remain on the accessible first floor').toBeLessThan(2); return !!actor(fixture.renderer).userData.sleepingBed; });
    expect(path.crossings.get(4)).toEqual([ENTRY, ROOM]); path.until(() => closed(fixture.renderer), 30); const outward = path.report(), bedPosition = actor(fixture.renderer).position.toArray();
    fixture.world.update(walking, null); expect(actor(fixture.renderer).position.toArray()).toEqual(bedPosition); path = trace(fixture);
    path.until(() => { expect(actor(fixture.renderer).position.y).toBeLessThan(2); return actor(fixture.renderer).userData.homeRegion === 'outdoor' && !actor(fixture.renderer).userData.homeJourney?.active; });
    expect(path.crossings.get(4)).toEqual([ROOM, ENTRY]); path.until(() => closed(fixture.renderer), 30); noFlapping(fixture.events, 2);
    expect(fixture.events.every(event => event.source === 'companion')).toBe(true); checkFurniture(); expect([JSON.stringify(group), JSON.stringify(sleeping), JSON.stringify(walking)]).toEqual(originals);
    console.info('AUTONOMOUS_DOORS_REFERENCE_VILLA ' + JSON.stringify({ outward, returned: path.report() }));
  }, 20_000);
});
