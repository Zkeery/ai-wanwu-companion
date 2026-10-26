import * as THREE from 'three';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering, type Gathering } from '@/lib/gatherings';
import { collectNaturalLeisureSeats } from '@/lib/living-natural-leisure-scene';
import type { HomeLeisureActivity, HomeLeisureSeat } from '@/lib/living-home-leisure';

const gpu = vi.hoisted(() => ({ instances: [] as Array<{ scene: THREE.Scene | null; loop: ((time: number) => void) | null }> }));
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class OfflineRenderer {
    domElement = document.createElement('canvas'); shadowMap = { enabled: false, type: 0 };
    outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 1;
    scene: THREE.Scene | null = null; loop: ((time: number) => void) | null = null;
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn();
    setAnimationLoop = vi.fn((loop: ((time: number) => void) | null) => { this.loop = loop; });
    render = vi.fn((scene: THREE.Scene, camera: THREE.Camera) => { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); this.scene = scene; });
    constructor() { gpu.instances.push(this); }
  }
  return { ...actual, WebGLRenderer: OfflineRenderer };
});
type Kind = 'forest' | 'desert';
type Flags = NonNullable<Parameters<typeof createLivingWorld>[5]>;
type Resource = THREE.BufferGeometry | THREE.Material | THREE.Texture;
const ENTRY = 'home-main-entry-door', ROOM = 'home-room-connection-door', DOORS = [ENTRY, ROOM] as const;
const worlds: Array<ReturnType<typeof createLivingWorld>> = [];
beforeEach(() => {
  if (continuedTea || continuedThree) return;
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); gpu.instances.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  for (const name of ['fetch', 'Audio', 'AudioContext']) vi.stubGlobal(name, vi.fn(() => { throw new Error('natural leisure acceptance is free and network isolated'); }));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
function cleanup() {
  worlds.splice(0).forEach(world => world.dispose());
  expect(fetch).not.toHaveBeenCalled(); expect(Audio).not.toHaveBeenCalled(); expect(AudioContext).not.toHaveBeenCalled();
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
}
afterEach(context => {
  if ((continuedTea || continuedThree) && context.task.result?.state !== 'fail') return;
  continuedTea = null; continuedThree = null; cleanup();
});
afterAll(() => { if (continuedTea || continuedThree) { continuedTea = null; continuedThree = null; cleanup(); } });
function snapshot(kind: Kind): Gathering {
  return parseGathering({ id: 'synthetic-natural-leisure-' + kind, title: '本地自然住处喝茶', scene_type: kind, revision: 1, closed: false, is_manager: true, me: 'owner',
    members: [{ id: 'owner', name: '合成成员', manager: true }],
    companions: ['cup', 'plant', 'bouquet'].map((avatarKind, i) => ({ id: i + 4, owner_id: 'owner', name: '合成伙伴' + (i + 1), activity: 'observe', area: 'outdoor', x: .3 + i * .2, y: .8,
      avatar3d: { version: 1, kind: avatarKind, body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: i + 4, source: 'procedural_existing_features' } })),
    items: [{ id: 'natural-saved-bench', kind: 'bench', x: .76, y: .7, mine: true, contributor_name: '合成成员', growth_status: null }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
function resting(group: Gathering, activity: 'rest' | 'sleep', id = 4): Gathering {
  return { ...group, companions: group.companions.map(c => c.id === id ? { ...c, activity, area: activity === 'sleep' ? 'bedroom' : 'indoor' } : c) };
}
function setup(group = snapshot('forest'), flags: Flags = {}) {
  const host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } }); document.body.append(host, labels);
  const world = createLivingWorld(host, labels, group, vi.fn(), vi.fn(), { realistic: true, localNaturalWorld: true, localRoomTransitions: true, localCompanionDoors: true, localLeisurePreview: true, localNaturalLeisure: true, ...flags });
  worlds.push(world); const renderer = gpu.instances.at(-1)!;
  return { world, host, labels, group, renderer, scene: renderer.scene! };
}
type Fixture = ReturnType<typeof setup>;
function actor(f: Fixture, id = 4) { const object = f.scene.children.find(o => o.userData.characterId === id); expect(object).toBeDefined(); return object!; }
function step(f: Fixture, delta = 100) { vi.setSystemTime(Date.now() + delta); expect(f.renderer.loop).toBeTypeOf('function'); f.renderer.loop!(Date.now()); }
function seatList(f: Fixture) { const environment = f.scene.children.find(o => o.userData.naturalScene === f.group.scene_type) ?? null, items = f.scene.children.find(o => o.children.some(c => c.userData.homeItemId)) ?? null; return collectNaturalLeisureSeats(environment, items, f.group, f.world.getLocalLeisure()); }
function seat(f: Fixture, id = 4) { const assignment = f.world.getLocalLeisure().assignments.find(a => a.actorId === id); expect(assignment).toBeDefined(); const result = seatList(f).find(s => s.id === assignment!.seatId); expect(result).toBeDefined(); return result!; }
function cup(f: Fixture, slot: HomeLeisureSeat) { expect(slot.cupId).toBeTypeOf('string'); const result = f.scene.getObjectByName(slot.cupId!); expect(result).toBeDefined(); return result!; }
function visibleVertices(root: THREE.Object3D, visit: (p: THREE.Vector3) => void) {
  const p = new THREE.Vector3(), matrix = new THREE.Matrix4(), instance = new THREE.Matrix4();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) return;
    const positions = object.geometry.getAttribute('position');
    for (let j = 0; j < (object instanceof THREE.InstancedMesh ? object.count : 1); j++) {
      matrix.copy(object.matrixWorld); if (object instanceof THREE.InstancedMesh) { object.getMatrixAt(j, instance); matrix.multiply(instance); }
      for (let i = 0; i < positions.count; i++) visit(p.fromBufferAttribute(positions, i).applyMatrix4(matrix));
    }
  });
}
function bodyBox(root: THREE.Object3D) { const box = new THREE.Box3(); visibleVertices(root, p => box.expandByPoint(p)); expect(box.isEmpty()).toBe(false); return box; }
function triangleContact(root: THREE.Object3D, volume: THREE.Box3) {
  const inner = volume.clone().expandByScalar(-.006);
  if (!new THREE.Box3().setFromObject(root, true).intersectsBox(inner)) return false;
  const triangle = new THREE.Triangle(), vertex = new THREE.Vector3(); let hit = false;
  root.traverse(object => {
    if (hit || !(object instanceof THREE.Mesh)) return;
    const positions = object.geometry.getAttribute('position'), indices = object.geometry.index;
    for (let i = 0; i < (indices?.count ?? positions.count); i += 3) {
      for (const [offset, p] of [[0, triangle.a], [1, triangle.b], [2, triangle.c]] as const) p.copy(vertex.fromBufferAttribute(positions, indices ? indices.getX(i + offset) : i + offset).applyMatrix4(object.matrixWorld));
      if (inner.intersectsTriangle(triangle)) { hit = true; return; }
    }
  }); return hit;
}
function trace(f: Fixture, ids = [4]) {
  const staticSolids: THREE.Object3D[] = [], leaves = DOORS.map(id => f.scene.getObjectByName(id + '-leaf')!);
  f.scene.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) {
      const role = parent.userData.architectureRole;
      if (typeof role === 'string' && (role.includes('wall') || role === 'interior-partition')) { staticSolids.push(object); return; }
    }
  });
  expect(staticSolids.length).toBeGreaterThan(4); expect(leaves.every(Boolean)).toBe(true);
  const teaSlots = seatList(f).filter(s => s.station === 'tea'), propSolids: THREE.Object3D[] = []; f.scene.traverse(object => { if (object.userData.naturalNavObstacle && !DOORS.some(d => object.name.startsWith(d))) propSolids.push(object); });
  const walls = staticSolids.map(object => ({ object, box: new THREE.Box3().setFromObject(object, true), matrix: object.matrixWorld.toArray() }));
  let previous = ids.map(id => actor(f, id).position.clone()), frames = 0;
  const crossed = new Map(ids.map(id => [id, [] as string[]])), tail: unknown[] = [], sides = new Map<string, number>();
  return {
    crossed,
    next() {
      step(f); frames++;
      for (const wall of walls) expect(wall.object.matrixWorld.toArray()).toEqual(wall.matrix);
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index], root = actor(f, id), p = root.position.clone(), body = bodyBox(root), phase = root.userData.homeJourney?.phase;
        tail.push({ frame: frames, id, p: p.toArray(), phase, area: root.userData.homeRegion }); if (tail.length > 6) tail.shift();
        expect(root.visible).toBe(true); expect(p.distanceTo(previous[index]), JSON.stringify(tail)).toBeLessThan(.2);
        for (const wall of walls) if (body.clone().expandByScalar(-.006).intersectsBox(wall.box)) throw new Error('actual body crossed wall ' + wall.object.name + JSON.stringify(tail));
        for (const [i, id0] of DOORS.entries()) {
          const portal = f.scene.getObjectByName(id0)!, opening = portal.userData.opening as { along: 'x' | 'z'; center: { x: number; z: number }; min: number; max: number };
          if (triangleContact(leaves[i], body)) throw new Error('actual moving door crossed body ' + JSON.stringify(tail));
          const along = opening.along, normal = along === 'x' ? 'z' : 'x', plane = opening.center[normal], was = previous[index][normal] - plane, now = p[normal] - plane;
          const t = was === now ? 0 : was / (was - now), across = THREE.MathUtils.lerp(previous[index][along], p[along], t), key = id + '/' + id0;
          const prior = sides.get(key) ?? (Math.abs(was) > 1e-6 ? Math.sign(was) : 0), side = Math.abs(now) > 1e-6 ? Math.sign(now) : 0;
          if (prior && side && prior !== side && across >= opening.min && across <= opening.max) { crossed.get(id)!.push(id0); expect(portal.userData.homeDoorOpenness).toBeCloseTo(1, 6); }
          if (side) sides.set(key, side);
          if (body.min[normal] < plane - .015 && body.max[normal] > plane + .015 && body.max[along] > opening.min && body.min[along] < opening.max) {
            expect(portal.userData.homeDoorOpenness).toBeCloseTo(1, 6); expect(body.min[along]).toBeGreaterThanOrEqual(opening.min - .002); expect(body.max[along]).toBeLessThanOrEqual(opening.max + .002);
          }
        }
        if (root.userData.homeJourney?.active) for (const slot of teaSlots) expect(cup(f, slot).parent, 'cup remains on the table throughout every active journey, including docking').not.toBe(root.getObjectByName('right-arm'));
        if (['walk', 'turn', 'portal', 'wait-door', 'blocked'].includes(phase)) {
          expect(root.userData.roomRestSeat).toBeUndefined(); expect(root.userData.sleepingBed).toBeUndefined();
          for (const obstacle of propSolids) {
            let belongsToActor = false; for (let parent: THREE.Object3D | null = obstacle; parent; parent = parent.parent) if (parent === root) belongsToActor = true;
            if (!belongsToActor && triangleContact(obstacle, body)) throw new Error('actual standing body intersected physical prop ' + obstacle.name + JSON.stringify(tail));
          }
        }
      }
      for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
        const overlap = bodyBox(actor(f, ids[a])).intersect(bodyBox(actor(f, ids[b]))), size = overlap.getSize(new THREE.Vector3());
        expect(!overlap.isEmpty() && Math.min(size.x, size.y, size.z) > .006, 'actual peer bodies overlap').toBe(false);
      }
      previous = ids.map(id => actor(f, id).position.clone());
    },
    until(predicate: () => boolean, limit = 1200) { for (let i = 0; i < limit; i++) { this.next(); if (predicate()) return; } throw new Error('natural leisure travel did not complete ' + JSON.stringify({ tail, leisure: f.world.getLocalLeisure(), actors: ids.map(id => ({ id, position: actor(f, id).position.toArray(), journey: actor(f, id).userData.homeJourney, navigation: actor(f, id).userData.homeNavigation, seat: actor(f, id).userData.roomRestSeat, clearance: actor(f, id).userData.navigationClearance })) })); },
  };
}
function seated(f: Fixture, activity: HomeLeisureActivity, id = 4) { const a = f.world.getLocalLeisure().assignments.find(a => a.actorId === id); return a?.activity === activity && actor(f, id).userData.roomRestSeat?.seatId === a.seatId && !actor(f, id).userData.homeJourney?.active; }
function seatContact(f: Fixture, id = 4) {
  const root = actor(f, id), slot = seat(f, id), body = root.getObjectByName('body'); expect(body).toBeDefined(); expect(slot.support?.length).toBeGreaterThan(0);
  const surfaces = slot.support!.map(name => { let object = f.scene.getObjectByName(name); if (!object) f.scene.traverse(value => { if (value.userData.naturalLeisureSupportId === name) object = value; }); expect(object, name).toBeDefined(); return object!; });
  const ray = new THREE.Raycaster(new THREE.Vector3(slot.x, slot.y + 2, slot.z), new THREE.Vector3(0, -1, 0)), hits = ray.intersectObjects(surfaces, true);
  expect(hits.length, 'real seat triangle under actual contact').toBeGreaterThan(0); expect(hits[0].point.y).toBeCloseTo(slot.y, 5);
  expect(root.position.x).toBeCloseTo(slot.x, 8); expect(root.position.z).toBeCloseTo(slot.z, 8);
  expect(Math.abs(bodyBox(body!).min.y - hits[0].point.y), 'seated body is supported by the real surface').toBeLessThan(.02);
  if (slot.station === 'bench') for (const surface of surfaces) if (triangleContact(surface, bodyBox(body!))) throw new Error('seated upper body intersects real bench back ' + JSON.stringify({ slot, body: { min: bodyBox(body!).min.toArray(), max: bodyBox(body!).max.toArray() }, root: root.position.toArray() }));
}
function grip(f: Fixture, id = 4) {
  const root = actor(f, id), held = cup(f, seat(f, id)), arm = root.getObjectByName('right-arm'); expect(arm).toBeDefined(); expect(held.parent).toBe(arm);
  const hand = new THREE.Vector3(.075, -.265, .045).applyMatrix4(arm!.matrixWorld), handle = new THREE.Vector3(.075, .0415, -.035).applyMatrix4(held.matrixWorld);
  expect(hand.distanceTo(handle), 'cup grip frame is anchored to the actual palm').toBeLessThan(1e-7);
  const palm = arm!.children.find(object => object instanceof THREE.Mesh && object.geometry instanceof THREE.SphereGeometry && object.position.distanceTo(new THREE.Vector3(.075, -.265, .045)) < 1e-8); expect(palm).toBeDefined();
  expect(triangleContact(held, bodyBox(palm!)), 'actual cup surface must touch the actual palm volume').toBe(true);
  const bottom = new THREE.Vector3().applyMatrix4(held.matrixWorld), top = new THREE.Vector3(0, .083, 0).applyMatrix4(held.matrixWorld);
  expect(top.distanceTo(bottom)).toBeCloseTo(.083, 8); expect(top.clone().sub(bottom).normalize().distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-7);
}
function unchanged(f: Fixture) {
  const json = JSON.stringify(f.group), items: Array<{ object: THREE.Object3D; matrix: number[] }> = [];
  f.scene.traverse(object => { if (object.userData.homeItemId) items.push({ object, matrix: object.matrixWorld.toArray() }); }); expect(items.length).toBe(f.group.items.length);
  return () => { expect(JSON.stringify(f.group)).toBe(json); for (const row of items) expect(row.object.matrixWorld.toArray()).toEqual(row.matrix); };
}
function resources(roots: THREE.Object3D[]) {
  const result = new Set<Resource>(); for (const root of roots) root.traverse(object => { if (!(object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points)) return; result.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : [object.material]) { result.add(material); for (const value of Object.values(material)) if (value instanceof THREE.Texture) result.add(value); } }); return result;
}
function frozen(f: Fixture) {
  const actors = f.scene.children.filter(o => typeof o.userData.characterId === 'number'), effects = f.scene.getObjectByName('home-local-activity-effects'); expect(effects).toBeDefined();
  const cups: number[][] = []; f.scene.traverse(object => { if (object.userData.homeTeaCup) cups.push(object.matrixWorld.toArray()); }); expect(cups.length).toBe(2);
  const environmentMotion: Array<{name: string; kind: string; matrix: number[]}> = []; f.scene.traverse(object => { if (object.userData.localMotion === 'leaf' || object.userData.localMotion === 'fire') environmentMotion.push({name: object.name, kind: object.userData.localMotion, matrix: object.matrixWorld.toArray()}); });
  if (f.group.scene_type === 'forest') { expect(environmentMotion.some(o => o.kind === 'leaf')).toBe(true); expect(environmentMotion.some(o => o.kind === 'fire')).toBe(true); }
  return JSON.stringify({ environmentMotion, cups, actors: actors.map(a => ({ matrix: a.matrixWorld.toArray(), id: a.userData.characterId, parts: a.children.map(p => ({ name: p.name, matrix: p.matrixWorld.toArray() })) })), effects: effects!.children.map(object => ({ matrix: object.matrixWorld.toArray(), vertices: object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points ? Array.from(object.geometry.getAttribute('position').array) : null })) });
}

function assertSameFrame(before: string, after: string, reason: string) {
  if (before === after) return;
  const differences: unknown[] = [];
  const walk = (a: unknown, b: unknown, path: string) => { if (a === b || differences.length >= 12) return; if (a && b && typeof a === 'object' && typeof b === 'object') { for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], path + '/' + key); } else differences.push({ path, before: a, after: b }); };
  walk(JSON.parse(before), JSON.parse(after), ''); throw new Error(reason + JSON.stringify(differences));
}
type ContinuedTea = { f: Fixture; kind: Kind; activity: 'rest' | 'sleep'; original: () => void; root: THREE.Object3D; held: THREE.Object3D; originalCupParent: THREE.Object3D | null; originalCupLocal: number[]; originalCupWorld: number[]; arrivedAt: number; path: ReturnType<typeof trace> };
let continuedTea: ContinuedTea | null = null;
type ContinuedThree = { f: Fixture; ids: number[]; roots: THREE.Object3D[]; original: () => void; cups: Array<{ object: THREE.Object3D; parent: THREE.Object3D | null; local: number[]; world: number[] }>; arrivedAt: number; path: ReturnType<typeof trace> };
let continuedThree: ContinuedThree | null = null;

describe('actual natural tea and saved bench local leisure', () => {
  it.each(['forest', 'desert'] as const)('requires every explicit %s gate, and cannot enable television or mahjong', kind => {
    const gates: Array<keyof Flags> = ['realistic', 'localNaturalWorld', 'localRoomTransitions', 'localCompanionDoors', 'localLeisurePreview', 'localNaturalLeisure'];
    for (const gate of gates) { const f = setup(snapshot(kind), { [gate]: false }); expect(f.world.startLocalLeisure('tea', 4)).toBe(false); expect(f.world.startLocalLeisure('bench', 4)).toBe(false); expect(f.world.getLocalLeisure().assignments).toEqual([]); f.world.dispose(); }
    const live = snapshot(kind); live.id = 'ordinary-live-natural'; const blocked = setup(live); expect(blocked.world.startLocalLeisure('tea', 4)).toBe(false); expect(blocked.world.getLocalLeisure().assignments).toEqual([]); blocked.world.dispose();
    const f = setup(snapshot(kind), { localMahjongGame: true }); for (const activity of ['television', 'mahjong'] as const) { expect(f.world.startLocalLeisure(activity, 4)).toBe(false); expect(f.world.toggleLocalLeisure(activity)).toBe(false); expect(f.world.focusLocalLeisure(activity)).toBe(false); }
    expect(f.world.getLocalMahjong().status).toBe('waiting'); expect(f.scene.getObjectByName('home-television-screen')).toBeUndefined(); expect(f.scene.getObjectByName('home-mahjong-table')).toBeUndefined();
  });
  for (const kind of ['forest', 'desert'] as const) for (const activity of ['rest', 'sleep'] as const) {
    it('gets up from actual ' + kind + ' ' + activity + ' furniture and crosses real doors to tea before borrowing the cup', () => {
      const f = setup(resting(snapshot(kind), activity)), original = unchanged(f), root = actor(f), contact = root.position.clone();
      expect(root.userData[activity === 'sleep' ? 'sleepingBed' : 'roomRestSeat']).toBeDefined(); expect(f.world.startLocalLeisure('tea', 4)).toBe(true); expect(root.position.equals(contact)).toBe(true);
      const slot = seat(f), tableCup = cup(f, slot), parent = tableCup.parent, originalCupLocal = tableCup.matrix.toArray(), originalCupWorld = tableCup.matrixWorld.toArray(); expect(parent).not.toBe(root.getObjectByName('right-arm')); f.world.setMotion(true);
      const path = trace(f); path.until(() => seated(f, 'tea')); expect(path.crossed.get(4)).toEqual(activity === 'sleep' ? [ROOM, ENTRY] : [ENTRY]); step(f); seatContact(f); grip(f); original();
      expect(f.world.getLocalLeisure().assignments[0].originalActivity).toBe(activity);
      continuedTea = { f, kind, activity, original, root, held: tableCup, originalCupParent: parent, originalCupLocal, originalCupWorld, arrivedAt: Date.now(), path };
    });
    it('returns that same ' + kind + ' tea cup and resumes the saved ' + activity + ' through real doors without reconstructing the world', () => {
      const current = continuedTea; expect(current?.kind).toBe(kind); expect(current?.activity).toBe(activity); if (!current) throw new Error('preceding real tea journey must have completed');
      try {
        const { f, root, held, original, path, originalCupParent, originalCupLocal, originalCupWorld, arrivedAt } = current; expect(actor(f)).toBe(root); expect(Date.now()).toBe(arrivedAt); grip(f); const contact = root.position.clone(), oldCrossings = path.crossed.get(4)!.slice();
        expect(f.world.stopLocalLeisure(4)).toBe(true); expect(root.position.equals(contact)).toBe(true); expect(held.parent).toBe(originalCupParent); expect(held.matrix.toArray()).toEqual(originalCupLocal); expect(held.matrixWorld.toArray()).toEqual(originalCupWorld);
        path.until(() => !!root.userData[activity === 'sleep' ? 'sleepingBed' : 'roomRestSeat'] && !root.userData.homeJourney?.active);
        expect(path.crossed.get(4)).toEqual([...oldCrossings, ...(activity === 'sleep' ? [ENTRY, ROOM] : [ENTRY])]); expect(f.world.getLocalLeisure().assignments).toEqual([]); expect(f.group.companions[0].activity).toBe(activity); original();
      } finally { continuedTea = null; }
    });
  }
  it.each(['forest', 'desert'] as const)('assigns two distinct %s tea contacts, rejects the third, and never overlaps real bodies or moves saved items', kind => {
    const f = setup(snapshot(kind)), original = unchanged(f); expect(f.world.startLocalLeisure('tea', 4)).toBe(true); expect(f.world.startLocalLeisure('tea', 5)).toBe(true);
    const before = JSON.stringify(f.world.getLocalLeisure().assignments); expect(f.world.startLocalLeisure('tea', 6)).toBe(false); expect(JSON.stringify(f.world.getLocalLeisure().assignments)).toBe(before);
    expect(seat(f, 4).physicalId).not.toBe(seat(f, 5).physicalId); expect(seat(f, 4).cupId).not.toBe(seat(f, 5).cupId); f.world.setMotion(true);
    const path = trace(f, [4, 5]); path.until(() => seated(f, 'tea', 4) && seated(f, 'tea', 5)); step(f); seatContact(f, 4); seatContact(f, 5); grip(f, 4); grip(f, 5); original();
  });
  it.each(['forest', 'desert'] as const)('uses only one real saved %s bench seat and returns it without moving the saved bench', kind => {
    const f = setup(snapshot(kind)), original = unchanged(f); const benches = seatList(f).filter(s => s.station === 'bench'); expect(benches).toHaveLength(1); expect(benches[0].physicalId).toContain('natural-saved-bench'); expect(f.world.focusLocalLeisure('bench')).toBe(true);
    const idle = [5, 6].map(id => ({ id, x: actor(f, id).position.x, z: actor(f, id).position.z })), idleUnmoved = () => { for (const saved of idle) if (!actor(f,saved.id).userData.homeIdleYield) expect(Math.hypot(actor(f, saved.id).position.x - saved.x, actor(f, saved.id).position.z - saved.z), 'unselected idle companion ' + saved.id + ' must not change location when another uses the bench').toBeLessThan(1e-7); };
    expect(f.world.startLocalLeisure('bench', 4)).toBe(true); expect(f.world.startLocalLeisure('bench', 5)).toBe(false); idleUnmoved(); f.world.setMotion(true); const path = trace(f, [4, 5, 6]); path.until(() => seated(f, 'bench')); seatContact(f); idleUnmoved();
    expect(f.world.stopLocalLeisure(4)).toBe(true); path.until(() => !actor(f).userData.homeJourney?.active && !actor(f).userData.roomRestSeat); expect(f.group.companions[0].activity).toBe('observe'); idleUnmoved(); original();
  });
  it('returns all three forest companions in one continuous world: all three arrive and hold the tea cups', () => {
    const group = snapshot('forest'); group.id = 'synthetic-unified'; group.me = 'A'; group.members = [{ id: 'A', name: '合成A', manager: true }, { id: 'B', name: '合成B', manager: false }];
    group.companions = (['cup', 'plant', 'bouquet'] as const).map((kind, index) => ({ id: index + 1, name: '合成伙伴' + (index + 1), owner_id: 'A', dialogue_allowed: false, activity: (index === 2 ? 'observe' : 'walk') as Gathering['companions'][number]['activity'], area: 'outdoor', x: .35 + index * .16, y: .55, avatar3d: { version: 1, kind, body: ['#f1eadb', '#86b293', '#b79ccd'][index], accent: '#d9bf91', detail: '#4b4853', seed: index, source: 'procedural_existing_features' } }));
    group.items = [{ id: 'saved-tree', kind: 'tree', x: .15, y: .22, mine: true, contributor_name: '合成', growth_status: null }, { id: 'saved-bench', kind: 'bench', x: .75, y: .65, mine: true, contributor_name: '合成', growth_status: null }];
    const f = setup(group), ids = [1, 2, 3], original = unchanged(f), roots = ids.map(id => actor(f, id));
    const initial = roots.map(root => root.position.clone()), cups = seatList(f).filter(slot => slot.station === 'tea').map(slot => { const object = cup(f, slot); return { object, parent: object.parent, local: object.matrix.toArray(), world: object.matrixWorld.toArray() }; });
    expect(cups).toHaveLength(2);
    for (const [activity, id] of [['tea', 1], ['tea', 2], ['bench', 3]] as const) { expect(f.world.startLocalLeisure(activity, id)).toBe(true); ids.forEach((id, index) => expect(actor(f, id).position.equals(initial[index]), 'assigning a seat cannot teleport any companion').toBe(true)); }
    expect(new Set(f.world.getLocalLeisure().assignments.map(row => seatList(f).find(slot => slot.id === row.seatId)!.physicalId)).size).toBe(3);
    f.world.setMotion(true); const path = trace(f, ids);
    try { path.until(() => seated(f, 'tea', 1) && seated(f, 'tea', 2) && seated(f, 'bench', 3)); } catch (error) { throw new Error('three-companion arrival failed: ' + String(error)); }
    step(f); ids.forEach(id => seatContact(f, id)); grip(f, 1); grip(f, 2); original();
    continuedThree = { f, ids, roots, original, cups, path, arrivedAt: Date.now() };
  });
  it('returns all three forest companions in one continuous world: stops all, returns cups and restores every saved activity', () => {
    const current = continuedThree; expect(current, 'the same preceding arrival must pass before all-stop validation').not.toBeNull(); if (!current) throw new Error('three-companion return requires the preceding real world');
    try {
      const { f, ids, roots, original, cups, path, arrivedAt } = current; expect(Date.now()).toBe(arrivedAt); ids.forEach((id, index) => { expect(actor(f, id)).toBe(roots[index]); seatContact(f, id); }); grip(f, 1); grip(f, 2); original();
      const contact = roots.map(root => root.position.clone()); expect(f.world.stopLocalLeisure()).toBe(true); expect(f.world.getLocalLeisure().assignments).toEqual([]);
      ids.forEach((id, index) => { expect(actor(f, id)).toBe(roots[index]); expect(actor(f, id).position.equals(contact[index]), 'stopping all activities cannot teleport a companion').toBe(true); });
      for (const row of cups) { expect(row.object.parent).toBe(row.parent); expect(row.object.matrix.toArray()).toEqual(row.local); expect(row.object.matrixWorld.toArray()).toEqual(row.world); }
      try { path.until(() => ids.every(id => actor(f, id).userData.homeRegion === 'outdoor' && !actor(f, id).userData.homeJourney?.active && !actor(f, id).userData.roomRestSeat && !actor(f, id).userData.sleepingBed)); } catch (error) { throw new Error('three-companion all-stop return failed: ' + String(error)); }
      expect(f.group.companions.map(companion => companion.activity)).toEqual(['walk', 'walk', 'observe']); expect(f.world.getLocalLeisure().assignments).toEqual([]); original();
    } finally { continuedThree = null; }
  });
  it.each(['forest', 'desert'] as const)('freezes actual %s steam, palm and cup on pause and hidden time without catch-up', kind => {
    const group = snapshot(kind); if (kind === 'forest') group.items.push({ id: 'synthetic-pause-campfire', kind: 'campfire', x: .95, y: .95, mine: true, contributor_name: '合成成员', growth_status: null });
    const f = setup(group); expect(f.world.startLocalLeisure('tea', 4)).toBe(true); f.world.setMotion(true); trace(f).until(() => seated(f, 'tea')); for (let i = 0; i < 30; i++) step(f); grip(f);
    expect(Object.keys(f.host.dataset).filter(key => key.startsWith('television'))).toEqual([]); expect(f.host.dataset.lifeAudioEnabled).toBeUndefined(); expect(f.host.dataset.lifeAudioVoices).toBeUndefined(); expect(f.world.getLocalLeisure().television.powered).toBe(false);
    const moving = frozen(f); step(f); expect(frozen(f)).not.toBe(moving); const staleLoop = f.renderer.loop!; f.world.setMotion(false); const paused = frozen(f); vi.setSystemTime(Date.now() + 3_600_000); staleLoop(Date.now()); assertSameFrame(paused, frozen(f), 'paused actual frame changed: ');
    f.world.setMotion(true); const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange')); const hiddenFrame = frozen(f); step(f, 3_600_000); assertSameFrame(hiddenFrame, frozen(f), 'hidden actual frame changed: ');
    hidden.mockRestore(); document.dispatchEvent(new Event('visibilitychange')); const resumed = frozen(f); step(f); expect(frozen(f)).not.toBe(resumed); grip(f);
  });
  it('restores borrowed cups and cleans scene-specific effects/resources on replacement, scope exit and disposal', () => {
    const f = setup(snapshot('forest')); expect(f.world.startLocalLeisure('tea', 4)).toBe(true); f.world.setMotion(true); trace(f).until(() => seated(f, 'tea')); step(f); const held = cup(f, seat(f)); grip(f);
    const oldRoots = f.scene.children.filter(o => o.userData.naturalScene || o.name === 'home-local-activity-effects'), oldResources = resources(oldRoots), disposal = new Map([...oldResources].map(r => [r, vi.spyOn(r, 'dispose')]));
    const next = snapshot('desert'); f.world.update(next, null); expect(held.parent).not.toBe(actor(f).getObjectByName('right-arm')); expect(f.world.getLocalLeisure().assignments).toEqual([]); expect(actor(f).userData.roomRestSeat).toBeUndefined();
    const currentResources = resources(f.scene.children); for (const [value, spy] of disposal) if (!currentResources.has(value)) expect(spy).toHaveBeenCalledTimes(1);
    expect(f.scene.children.filter(o => o.name === 'home-local-activity-effects')).toHaveLength(1); const live = [...currentResources].map(resource => vi.spyOn(resource, 'dispose')); for (const spy of live) expect(spy).not.toHaveBeenCalled();
    f.world.update({ ...next, id: 'ordinary-live-scope' }, null); expect(f.world.getLocalLeisure().assignments).toEqual([]); expect(f.scene.getObjectByName('home-local-activity-effects')).toBeUndefined();
    const loop = f.renderer.loop!, root = actor(f); f.world.dispose(); const matrix = root.matrixWorld.toArray(); stepClockOnly(500_000); loop(Date.now()); expect(root.matrixWorld.toArray()).toEqual(matrix); expect(f.renderer.loop).toBeNull(); expect(f.host.querySelector('canvas')).toBeNull(); expect(f.labels.childElementCount).toBe(0);
    function stepClockOnly(delta: number) { vi.setSystemTime(Date.now() + delta); }
  });
});
