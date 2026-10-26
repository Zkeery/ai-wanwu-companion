import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering, type Gathering } from '@/lib/gatherings';
import { homeWorldPoint } from '@/lib/living-home-world';
import { createLivingNavigation } from '@/lib/living-navigation';
import { homeNavigationBounds } from '@/lib/living-home-navigation';
import { collectHomeJourneyObstacles } from '@/lib/living-home-journey-geometry';
import { worldAnchor } from '@/lib/shared-living-3d';

const ENTRY = 'home-main-entry-door', ROOM = 'home-room-connection-door';
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

type Area = 'outdoor' | 'indoor' | 'bedroom';
type Journey = { phase: 'walk' | 'turn' | 'portal' | 'wait-door' | 'dock' | 'undock' | 'blocked' | 'idle'; position: { x: number; z: number }; area: Area; targetArea: Area; targetKey: string; waitingFor?: string | null };
type Renderer = typeof gpu.instances[number];
const worlds: Array<ReturnType<typeof createLivingWorld>> = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); gpu.instances.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('home transition integration must remain offline'); }));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
});
afterEach(() => {
  worlds.splice(0).forEach(world => world.dispose()); expect(fetch).not.toHaveBeenCalled();
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function snapshot(activity = 'observe', area: Area = 'outdoor'): Gathering {
  return parseGathering({ id: 'synthetic-room-transition', title: '本地连续进屋休息', scene_type: 'home', revision: 1,
    closed: false, is_manager: true, me: 'owner', members: [{ id: 'owner', name: '合成成员', manager: true }],
    companions: [{ id: 4, owner_id: 'owner', name: '合成杯子伙伴', activity, area, x: .62, y: .68,
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features' } }],
    items: [{ id: 'transition-saved-bench', kind: 'bench', x: .2, y: .7, mine: true, contributor_name: '合成成员', growth_status: null }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
function intent(group: Gathering, activity: Gathering['companions'][number]['activity'], area: Area): Gathering {
  return { ...group, revision: group.revision + 1, companions: group.companions.map(c => ({ ...c, activity, area })) };
}
function setup(group = snapshot(), overrides: { realistic?: boolean; localLeisurePreview?: boolean; localRoomTransitions?: boolean } = {}) {
  const host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } }); document.body.append(host, labels);
  const options = { realistic: true, localLeisurePreview: true, localRoomTransitions: true, ...overrides };
  const world = createLivingWorld(host, labels, group, vi.fn(), vi.fn(), options); worlds.push(world);
  return { world, host, group, renderer: gpu.instances.at(-1)! };
}
function avatar(renderer: Renderer) {
  const root = renderer.scene!.children.find(object => object.userData.characterId === 4); expect(root).toBeDefined(); return root!;
}
function journey(root: THREE.Object3D) { return root.userData.homeJourney as Journey | undefined; }
function step(renderer: Renderer, delta = 100) {
  vi.setSystemTime(Date.now() + delta); expect(renderer.loop).toBeTypeOf('function'); renderer.loop!(Date.now());
}
function openDoors(fixture: ReturnType<typeof setup>) {
  fixture.world.setHouseView('interior'); fixture.world.setDoorOpen(ENTRY, true); fixture.world.setDoorOpen(ROOM, true);
}
function visibleEnvelope(root: THREE.Object3D) {
  const box = new THREE.Box3(), point = new THREE.Vector3();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) return;
    const vertices = object.geometry.getAttribute('position'), indices = object.geometry.index;
    for (let i = 0; i < (indices?.count ?? vertices.count); i++) box.expandByPoint(point.fromBufferAttribute(vertices, indices ? indices.getX(i) : i).applyMatrix4(object.matrixWorld));
  });
  expect(box.isEmpty()).toBe(false); return box;
}
function furniture(renderer: Renderer) {
  const scene = renderer.scene!, rows: Array<{ name?: string; item?: string; matrix: number[] }> = [];
  for (const name of ['home-farmhouse-tea-table', 'home-mahjong-table', 'home-common-gabled-roof', ENTRY + '-frame', ROOM + '-frame', 'room-bed-0-mattress']) {
    const object = scene.getObjectByName(name); expect(object, name).toBeDefined(); rows.push({ name, matrix: object!.matrixWorld.toArray() });
  }
  scene.traverse(object => { if (typeof object.userData.homeItemId === 'string') rows.push({ item: object.userData.homeItemId, matrix: object.matrixWorld.toArray() }); });
  return () => rows.forEach(row => {
    let object = row.name ? scene.getObjectByName(row.name) : undefined;
    if (row.item) scene.traverse(candidate => { if (candidate.userData.homeItemId === row.item) object = candidate; });
    expect(object, row.name ?? row.item).toBeDefined(); expect(object!.matrixWorld.toArray()).toEqual(row.matrix);
  });
}
function structuralMeshes(scene: THREE.Scene) {
  const meshes: THREE.Mesh[] = [];
  scene.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) {
      const role = parent.userData.architectureRole;
      if (typeof role === 'string' && (role.startsWith('exterior-wall') || role === 'interior-partition' || role === 'courtyard-wall')) { meshes.push(object); return; }
    }
  });
  expect(meshes.length).toBeGreaterThan(0); return meshes;
}
function trace(renderer: Renderer, standingScale = avatar(renderer).scale.clone()) {
  const root = avatar(renderer), scale = standingScale.clone(), crossings: string[] = [], phases: string[] = [];
  const portalSides = new Map<string, number>();
  let previous = root.position.clone(), travelled = 0, frames = 0;
  return {
    crossings, phases,
    get travelled() { return travelled; },
    next(delta = 100) {
      step(renderer, delta); const current = avatar(renderer), state = journey(current), point = current.position.clone();
      expect(current.visible, 'a travelling companion must remain rendered').toBe(true);
      expect(point.distanceTo(previous), `frame ${frames}: actual root cannot jump between journey phases ${JSON.stringify({ delta, previous: previous.toArray(), current: point.toArray(), previousPhase: phases.at(-1), phase: state?.phase })}`).toBeLessThan(.2);
      travelled += Math.hypot(point.x - previous.x, point.z - previous.z); frames++;
      if (state) {
        if (phases.at(-1) !== state.phase) phases.push(state.phase);
        // A completed idle bed pose resumes the existing breathing support;
        // its recorded arrival point is no longer an active journey position.
        if (state.phase !== 'idle') { expect(state.position.x).toBeCloseTo(point.x, 6); expect(state.position.z).toBeCloseTo(point.z, 6); }
        expect(current.userData.homeRegion).toBe(state.area);
        if (['walk', 'turn', 'portal', 'wait-door', 'blocked'].includes(state.phase)) {
          expect(current.userData.roomRestSeat).toBeUndefined(); expect(current.userData.sleepingBed).toBeUndefined();
          expect(current.scale.toArray(), 'walking through an aperture cannot shrink the real body').toEqual(scale.toArray());
        }
      }
      const envelope = visibleEnvelope(current), scene = renderer.scene!;
      for (const id of [ENTRY, ROOM]) {
        const door = scene.getObjectByName(id)!, opening = door.userData.opening as { center: { x: number; z: number }; along: 'x' | 'z'; min: number; max: number };
        expect(opening).toBeDefined();
        const along = opening.along, normal = along === 'x' ? 'z' : 'x', plane = opening.center[normal];
        const was = previous[normal] - plane, now = point[normal] - plane;
        const time = was === now ? 0 : was / (was - now), across = THREE.MathUtils.lerp(previous[along], point[along], time);
        const previousSide = portalSides.get(id) ?? (Math.abs(was) > 1e-6 ? Math.sign(was) : 0), side = Math.abs(now) > 1e-6 ? Math.sign(now) : 0;
        if (previousSide && side && side !== previousSide && across >= opening.min && across <= opening.max) {
          crossings.push(id); expect(door.userData.homeDoorOpenness, `${id}: cannot cross a partly closed leaf`).toBeCloseTo(1, 7);
        }
        if (side) portalSides.set(id, side);
        if (envelope.min[normal] < plane - .015 && envelope.max[normal] > plane + .015 && envelope.max[along] > opening.min && envelope.min[along] < opening.max) {
          expect(door.userData.homeDoorOpenness, `${id}: body may enter its portal only after full opening`).toBeCloseTo(1, 7);
          expect(envelope.min[along], `${id}: actual body must fit the aperture`).toBeGreaterThanOrEqual(opening.min - .002);
          expect(envelope.max[along], `${id}: actual body must fit the aperture`).toBeLessThanOrEqual(opening.max + .002);
        }
      }
      const from = previous.clone().add(new THREE.Vector3(0, .8, 0)), to = point.clone().add(new THREE.Vector3(0, .8, 0)), direction = to.clone().sub(from), length = direction.length();
      if (length > 1e-6) {
        const walls = structuralMeshes(scene), leaves = [ENTRY, ROOM].map(id => scene.getObjectByName(id + '-leaf')!);
        for (const [origin, vector] of [[from, direction], [to, direction.clone().negate()]] as const) {
          const ray = new THREE.Raycaster(origin, vector.clone().normalize(), 1e-5, Math.max(1e-5, length - 1e-5));
          expect(ray.intersectObjects([...walls, ...leaves], true).map(hit => hit.object.name), 'actual root swept through a wall or door leaf').toEqual([]);
        }
      }
      previous = point; return current;
    },
    until(predicate: (root: THREE.Object3D) => boolean, limit = 1000) {
      for (let i = 0; i < limit; i++) { const current = this.next(); if (predicate(current)) return current; }
      throw new Error('journey did not finish: ' + JSON.stringify({ journey: journey(avatar(renderer)), position: avatar(renderer).position.toArray(), travelled, crossings, phases }));
    },
  };
}
function assertContact(renderer: Renderer, activity: 'rest' | 'sleep') {
  const root = avatar(renderer);
  if (activity === 'rest') {
    expect(root.userData.roomRestSeat?.characterId).toBe(4); expect(root.userData.sleepingBed).toBeUndefined();
    const expected = homeWorldPoint('indoor', root.userData.roomRestSeat);
    expect(root.userData.homeRegion).toBe('indoor'); expect(root.position.x).toBeCloseTo(expected.x, 6); expect(root.position.z).toBeCloseTo(expected.z, 6);
  } else {
    expect(root.userData.sleepingBed?.characterId).toBe(4); expect(root.userData.roomRestSeat).toBeUndefined(); expect(root.userData.homeRegion).toBe('bedroom');
    const mattress = new THREE.Box3().setFromObject(renderer.scene!.getObjectByName('room-bed-0-mattress')!);
    expect(root.position.x).toBeGreaterThanOrEqual(mattress.min.x); expect(root.position.x).toBeLessThanOrEqual(mattress.max.x);
    expect(root.position.z).toBeGreaterThanOrEqual(mattress.min.z); expect(root.position.z).toBeLessThanOrEqual(mattress.max.z);
    const support = new THREE.Box3(), point = new THREE.Vector3();
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh) || !object.userData.sleepBodySupport) return;
      for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) return;
      const vertices = object.geometry.getAttribute('position'), indices = object.geometry.index;
      for (let i = 0; i < (indices?.count ?? vertices.count); i++) support.expandByPoint(point.fromBufferAttribute(vertices, indices ? indices.getX(i) : i).applyMatrix4(object.matrixWorld));
    });
    expect(support.isEmpty()).toBe(false); expect(support.min.y).toBeCloseTo(mattress.max.y, 5);
  }
}

describe('local realistic home physical room transitions', () => {
  it('restores a cold snapshot in place and keeps the new journey behind every explicit local gate', () => {
    for (const [activity, area] of [['rest', 'indoor'], ['sleep', 'bedroom']] as const) {
      const group = snapshot(activity, area), original = JSON.stringify(group), fixture = setup(group), initial = avatar(fixture.renderer).position.clone();
      assertContact(fixture.renderer, activity); expect(['walk', 'wait-door', 'undock']).not.toContain(journey(avatar(fixture.renderer))?.phase);
      fixture.world.setMotion(true); for (let i = 0; i < 30; i++) step(fixture.renderer);
      const current = avatar(fixture.renderer); expect(current.position.distanceTo(initial), 'cold restoration must stay at its contact pose, allowing its existing breathing support').toBeLessThan(.01);
      assertContact(fixture.renderer, activity); expect(['walk', 'wait-door', 'undock']).not.toContain(journey(current)?.phase); expect(JSON.stringify(group)).toBe(original);
    }
    for (const overrides of [{ localRoomTransitions: false }, { localLeisurePreview: false }, { realistic: false }, {}]) {
      const group = snapshot(); if (Object.keys(overrides).length === 0) group.id = 'ordinary-production-gathering';
      const fixture = setup(group, overrides), next = intent(group, 'rest', 'indoor'); fixture.world.update(next, null);
      expect(journey(avatar(fixture.renderer))).toBeUndefined(); assertContact(fixture.renderer, 'rest');
    }
  });

  it.each([['rest', 'indoor', [ENTRY]], ['sleep', 'bedroom', [ENTRY, ROOM]]] as const)('walks from the actual courtyard position to %s through real apertures before docking', (activity, area, expectedDoors) => {
    const group = snapshot(), next = intent(group, activity, area), originals = [JSON.stringify(group), JSON.stringify(next)], fixture = setup(group);
    openDoors(fixture); const checkFurniture = furniture(fixture.renderer), start = avatar(fixture.renderer).position.clone();
    fixture.world.update(next, null, area); expect(avatar(fixture.renderer).position.toArray()).toEqual(start.toArray());
    expect(journey(avatar(fixture.renderer))?.targetArea).toBe(area); expect(avatar(fixture.renderer).userData.roomRestSeat).toBeUndefined(); expect(avatar(fixture.renderer).userData.sleepingBed).toBeUndefined();
    const path = trace(fixture.renderer); fixture.world.setMotion(true); path.until(root => !!root.userData[activity === 'rest' ? 'roomRestSeat' : 'sleepingBed']);
    expect(path.crossings).toEqual(expectedDoors); expect(path.travelled).toBeGreaterThan(5); assertContact(fixture.renderer, activity); checkFurniture();
    expect([JSON.stringify(group), JSON.stringify(next)]).toEqual(originals);
    console.info('HOME_JOURNEY_ACTUAL ' + JSON.stringify({ activity, travelled: path.travelled, crossings: path.crossings, phases: path.phases, final: avatar(fixture.renderer).position.toArray() }));
  });

  it('waits at both actual closed doors and only proceeds after each animated leaf fully opens', () => {
    const group = snapshot(), fixture = setup(group); fixture.world.setHouseView('interior'); fixture.world.setDoorOpen(ENTRY, false); fixture.world.setDoorOpen(ROOM, false);
    fixture.world.update(intent(group, 'sleep', 'bedroom'), null, 'bedroom'); const path = trace(fixture.renderer); fixture.world.setMotion(true);
    for (const id of [ENTRY, ROOM] as const) {
      const waiting = path.until(root => journey(root)?.phase === 'wait-door' && journey(root)?.waitingFor === id), stopped = waiting.position.clone();
      expect(waiting.userData.sleepingBed).toBeUndefined(); expect(journey(waiting)?.area).toBe(id === ENTRY ? 'outdoor' : 'indoor');
      for (let i = 0; i < 100; i++) {
        const current = path.next(); expect(current.position.x).toBe(stopped.x); expect(current.position.z).toBe(stopped.z);
        expect(Math.abs(current.position.y - stopped.y), 'waiting may settle its gait bob without moving its floor location').toBeLessThan(.03);
      }
      expect(fixture.renderer.scene!.getObjectByName(id)!.userData.homeDoorOpenness).toBe(0); fixture.world.setDoorOpen(id, true);
    }
    path.until(root => !!root.userData.sleepingBed); expect(path.crossings).toEqual([ENTRY, ROOM]); assertContact(fixture.renderer, 'sleep');
  });

  it('freezes an unfinished journey through a one-hour pause and resumes from the same physical position', () => {
    const group = snapshot(), next = intent(group, 'sleep', 'bedroom'), fixture = setup(group); openDoors(fixture); fixture.world.update(next, null);
    const path = trace(fixture.renderer); fixture.world.setMotion(true); path.until(() => path.travelled > .4);
    fixture.world.setMotion(false); const stopped = avatar(fixture.renderer).position.toArray(), state = JSON.stringify(journey(avatar(fixture.renderer)));
    vi.setSystemTime(Date.now() + 3_600_000); for (let i = 0; i < 3; i++) { fixture.world.reset(); fixture.world.update({ ...next, revision: next.revision + i }, null, 'bedroom'); }
    expect(avatar(fixture.renderer).position.toArray()).toEqual(stopped); expect(JSON.stringify(journey(avatar(fixture.renderer)))).toBe(state); expect(avatar(fixture.renderer).userData.sleepingBed).toBeUndefined();
    fixture.world.setMotion(true); path.next(50); path.until(root => !!root.userData.sleepingBed); assertContact(fixture.renderer, 'sleep');
  });

  it('does not restart an in-progress route when equivalent snapshots or camera views repeat', () => {
    const group = snapshot(), next = intent(group, 'rest', 'indoor'), fixture = setup(group); openDoors(fixture); fixture.world.update(next, null);
    const path = trace(fixture.renderer); fixture.world.setMotion(true); path.until(() => path.travelled > .8);
    const point = avatar(fixture.renderer).position.toArray(), before = JSON.stringify(journey(avatar(fixture.renderer)));
    for (const view of ['outdoor', 'indoor', 'overview'] as const) { fixture.world.update({ ...next, revision: next.revision + 1 }, null, view); fixture.world.reset(); expect(avatar(fixture.renderer).position.toArray()).toEqual(point); expect(JSON.stringify(journey(avatar(fixture.renderer)))).toBe(before); }
    path.until(root => !!root.userData.roomRestSeat); expect(path.crossings).toEqual([ENTRY]); assertContact(fixture.renderer, 'rest');
  });

  it('replans observe from the actual current area and redirects without resurrecting the obsolete bed destination', () => {
    const group = snapshot(), sleeping = intent(group, 'sleep', 'bedroom'), fixture = setup(group); openDoors(fixture); fixture.world.update(sleeping, null);
    const path = trace(fixture.renderer); fixture.world.setMotion(true); path.until(() => path.travelled > .5);
    fixture.world.setMotion(false); const point = avatar(fixture.renderer).position.toArray(), currentArea = journey(avatar(fixture.renderer))!.area;
    const cancelled = intent(sleeping, 'observe', currentArea); fixture.world.update(cancelled, null); expect(avatar(fixture.renderer).position.toArray()).toEqual(point);
    // scope.md defines an activity change as replanning from the physical point;
    // observe can walk continuously back to this area's saved floor anchor.
    expect(journey(avatar(fixture.renderer))?.targetArea).toBe(currentArea); expect(journey(avatar(fixture.renderer))?.targetKey).toMatch(/^floor\/observe\//);
    fixture.world.setMotion(true); for (let i = 0; i < 30; i++) { path.next(); expect(avatar(fixture.renderer).userData.sleepingBed).toBeUndefined(); }
    const redirectedFrom = avatar(fixture.renderer).position.toArray(), resting = intent(cancelled, 'rest', 'indoor'); fixture.world.update(resting, null); expect(avatar(fixture.renderer).position.toArray()).toEqual(redirectedFrom);
    expect(journey(avatar(fixture.renderer))?.targetKey).toMatch(/^seat\//);
    path.until(root => !!root.userData.roomRestSeat); const seated = avatar(fixture.renderer).position.toArray();
    for (let i = 0; i < 600; i++) { step(fixture.renderer); expect(avatar(fixture.renderer).position.toArray()).toEqual(seated); expect(avatar(fixture.renderer).userData.sleepingBed).toBeUndefined(); }
    assertContact(fixture.renderer, 'rest');
  });

  it('clears pending journeys on departure, gathering replacement, scene replacement, and disposal', () => {
    for (const mode of ['departure', 'scope', 'scene', 'dispose'] as const) {
      const group = snapshot(), next = intent(group, 'sleep', 'bedroom'), originals = [JSON.stringify(group), JSON.stringify(next)], fixture = setup(group); openDoors(fixture); fixture.world.update(next, null);
      const path = trace(fixture.renderer); fixture.world.setMotion(true); path.until(() => path.travelled > .3);
      if (mode === 'dispose') {
        const staleLoop = fixture.renderer.loop!, root = avatar(fixture.renderer); fixture.world.dispose(); const point = root.position.toArray();
        expect(fixture.renderer.loop).toBeNull(); expect(fixture.host.querySelector('canvas')).toBeNull(); vi.setSystemTime(Date.now() + 100_000); staleLoop(Date.now()); expect(root.position.toArray()).toEqual(point);
      } else {
        if (mode === 'departure') { fixture.world.update({ ...next, revision: 3, companions: [] }, null); expect(fixture.renderer.scene!.children.some(o => o.userData.characterId === 4)).toBe(false); }
        if (mode === 'scope') fixture.world.update({ ...group, id: 'synthetic-replacement-world', revision: 3 }, null);
        if (mode === 'scene') fixture.world.update({ ...group, revision: 3, scene_type: 'forest' }, null);
        for (let i = 0; i < 50; i++) step(fixture.renderer);
        if (mode !== 'departure') { expect(journey(avatar(fixture.renderer))).toBeUndefined(); expect(avatar(fixture.renderer).userData.sleepingBed).toBeUndefined(); }
        const returned = { ...group, id: 'synthetic-fresh-return', revision: 4 }; fixture.world.update(returned, null); const point = avatar(fixture.renderer).position.toArray();
        for (let i = 0; i < 600; i++) { step(fixture.renderer); expect(avatar(fixture.renderer).position.toArray()).toEqual(point); expect(avatar(fixture.renderer).userData.sleepingBed).toBeUndefined(); expect(journey(avatar(fixture.renderer))).toBeUndefined(); }
      }
      expect([JSON.stringify(group), JSON.stringify(next)]).toEqual(originals);
    }
  });

  it.each([['rest', 'indoor', [ENTRY]], ['sleep', 'bedroom', [ROOM, ENTRY]]] as const)('undocks a cold %s pose onto safe standing floor before walking back through the doors to the courtyard', (activity, area, expectedDoors) => {
    const group = snapshot(activity, area), next = intent(group, 'walk', 'outdoor'), originals = [JSON.stringify(group), JSON.stringify(next)];
    const control = setup(intent(group, 'observe', area)), standingScale = avatar(control.renderer).scale.clone(); control.world.dispose();
    const fixture = setup(group); openDoors(fixture); assertContact(fixture.renderer, activity);
    const checkFurniture = furniture(fixture.renderer), start = avatar(fixture.renderer).position.toArray();
    fixture.world.update(next, null, 'outdoor'); expect(avatar(fixture.renderer).position.toArray()).toEqual(start);
    expect(journey(avatar(fixture.renderer))?.phase).toBe('undock'); expect(journey(avatar(fixture.renderer))?.targetArea).toBe('outdoor');
    const path = trace(fixture.renderer, standingScale); fixture.world.setMotion(true);
    const standing = path.until(root => journey(root)?.phase === 'walk');
    expect(path.phases[0]).toBe('undock'); expect(path.crossings).toEqual([]); expect(standing.userData.homeRegion).toBe(area);
    expect(standing.scale.toArray()).toEqual(standingScale.toArray()); expect(standing.rotation.x).toBeCloseTo(0, 7);
    expect(standing.userData.roomRestSeat).toBeUndefined(); expect(standing.userData.sleepingBed).toBeUndefined();
    const actual = { x: standing.position.x, z: standing.position.z }, floor = createLivingNavigation({
      bounds: homeNavigationBounds(area), blocked: collectHomeJourneyObstacles(fixture.renderer.scene!, null), clearance: standing.userData.navigationClearance, step: .16,
    });
    expect(floor.isSegmentClear(actual, actual), 'undocking must finish at an actual safe floor point outside its furniture').toBe(true);
    path.until(root => root.userData.homeRegion === 'outdoor' && (!journey(root) || journey(root)?.phase === 'idle'));
    expect(path.crossings).toEqual(expectedDoors); expect(path.travelled).toBeGreaterThan(5);
    const afterArrival = path.travelled;
    for (let i = 0; i < 300; i++) {
      const current = path.next(); expect(current.userData.homeRegion).toBe('outdoor'); expect(current.userData.roomRestSeat).toBeUndefined(); expect(current.userData.sleepingBed).toBeUndefined();
      expect(current.scale.toArray()).toEqual(standingScale.toArray()); expect(current.rotation.x).toBeCloseTo(0, 7);
      expect(journey(current)?.targetKey ?? 'floor/walk/outdoor').not.toMatch(/^(bed|seat)\//);
    }
    expect(path.travelled - afterArrival, 'the returned actor must continue its new walk activity').toBeGreaterThan(.5);
    checkFurniture(); expect([JSON.stringify(group), JSON.stringify(next)]).toEqual(originals);
    console.info('HOME_JOURNEY_RETURN_ACTUAL ' + JSON.stringify({ activity, travelled: path.travelled, crossings: path.crossings, phases: path.phases, final: avatar(fixture.renderer).position.toArray() }));
  });

  it('reserves a travelling body before placing newly added observers or walkers at its exact business anchor', () => {
    type Body = { position: THREE.Vector3; envelope: THREE.Box3; radius: number };
    const body = (root: THREE.Object3D): Body => {
      expect(root.visible, 'both the traveller and newcomer must remain rendered').toBe(true);
      const envelope = visibleEnvelope(root), position = root.position.clone();
      const radius = Math.max(...[envelope.min.x, envelope.max.x].flatMap(x => [envelope.min.z, envelope.max.z].map(z => Math.hypot(x - position.x, z - position.z))));
      return { position, envelope, radius };
    };
    const sweepDistance = (a0: Body, a1: Body, b0: Body, b1: Body) => {
      const x = a0.position.x - b0.position.x, z = a0.position.z - b0.position.z;
      const dx = a1.position.x - a0.position.x - b1.position.x + b0.position.x, dz = a1.position.z - a0.position.z - b1.position.z + b0.position.z;
      const length = dx * dx + dz * dz, time = length < 1e-14 ? 0 : Math.max(0, Math.min(1, -(x * dx + z * dz) / length));
      return Math.hypot(x + time * dx, z + time * dz);
    };
    const separate = (a: Body, b: Body, frame: number) => {
      const overlap = a.envelope.min.x < b.envelope.max.x - 1e-5 && a.envelope.max.x > b.envelope.min.x + 1e-5
        && a.envelope.min.z < b.envelope.max.z - 1e-5 && a.envelope.max.z > b.envelope.min.z + 1e-5;
      expect(overlap, `frame ${frame}: actual rendered body envelopes must not overlap`).toBe(false);
      expect(Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z), `frame ${frame}: body clearance`).toBeGreaterThanOrEqual(a.radius + b.radius - 1e-4);
    };
    for (const activity of ['observe', 'walk'] as const) {
      const group = snapshot(), next = intent(group, 'rest', 'indoor'), fixture = setup(group); openDoors(fixture);
      const checkFurniture = furniture(fixture.renderer); fixture.world.update(next, null); const path = trace(fixture.renderer); fixture.world.setMotion(true);
      const traveller = path.until(root => root.userData.homeRegion === 'outdoor' && root.position.z < 3.3 && root.position.z > 3);
      const beforeAddition = traveller.position.clone(), center = homeWorldPoint('outdoor', { x: 0, y: 0, z: 0 });
      // Invert the existing business-position projection, then verify through
      // worldAnchor so peer spreading cannot silently change the test trigger.
      const x = ((beforeAddition.x - center.x) * 9.75 + 39) / 78, y = ((beforeAddition.z - center.z) * 10.5 + 30.6) / 68;
      const added: Gathering = { ...next, revision: next.revision + 1, companions: [...next.companions, { ...group.companions[0], id: 5, name: '旅途中新增伙伴', activity, area: 'outdoor', x, y }] };
      const anchor = homeWorldPoint('outdoor', { ...worldAnchor(added, 5)!, y: 0 }), originals = [JSON.stringify(group), JSON.stringify(next), JSON.stringify(added)];
      expect(anchor.x).toBeCloseTo(beforeAddition.x, 7); expect(anchor.z).toBeCloseTo(beforeAddition.z, 7);
      fixture.world.update(added, null, 'indoor'); expect(avatar(fixture.renderer).position.distanceTo(beforeAddition), 'adding an actor cannot displace the existing journey').toBeLessThan(1e-8);
      const newcomer = fixture.renderer.scene!.children.find(object => object.userData.characterId === 5); expect(newcomer).toBeDefined();
      let previous = [body(avatar(fixture.renderer)), body(newcomer!)]; separate(previous[0], previous[1], 0);
      const afterAddition = path.travelled; let completedAt: number | null = null;
      for (let frame = 1; frame <= 1000; frame++) {
        const currentRoot = path.next(), current = [body(currentRoot), body(newcomer!)]; separate(current[0], current[1], frame);
        expect(current[1].position.distanceTo(previous[1].position), `frame ${frame}: newcomer cannot jump`).toBeLessThan(.2);
        expect(sweepDistance(previous[0], current[0], previous[1], current[1]), `frame ${frame}: swept actual body clearance`).toBeGreaterThanOrEqual(Math.max(previous[0].radius, current[0].radius) + Math.max(previous[1].radius, current[1].radius) - 1e-4);
        previous = current;
        if (currentRoot.userData.roomRestSeat && completedAt === null) completedAt = frame;
        if (completedAt !== null && frame >= completedAt + 30) break;
      }
      expect(completedAt, 'the reserved traveller must finish its original journey despite the new actor').not.toBeNull();
      expect(path.travelled - afterAddition).toBeGreaterThan(3); assertContact(fixture.renderer, 'rest'); checkFurniture();
      expect([JSON.stringify(group), JSON.stringify(next), JSON.stringify(added)]).toEqual(originals);
      console.info('HOME_JOURNEY_NEW_ACTOR_ACTUAL ' + JSON.stringify({ activity, businessAnchor: [anchor.x, anchor.z], placed: previous[1].position.toArray(), completedAt, travelledAfterAddition: path.travelled - afterAddition }));
    }
  }, 15_000);
});
