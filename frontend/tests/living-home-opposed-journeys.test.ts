import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering, type Gathering } from '@/lib/gatherings';

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
type Renderer = typeof gpu.instances[number];
type Area = 'indoor' | 'bedroom' | 'outdoor';
type Journey = { phase: string; active: boolean; area: Area; targetArea: Area; waitingFor?: string; targetKey: string; pose: { x: number; z: number } };
type Body = { id: number; root: THREE.Object3D; position: THREE.Vector3; envelope: THREE.Box3; radius: number; journey?: Journey };
const worlds: Array<ReturnType<typeof createLivingWorld>> = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); gpu.instances.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('opposed home journeys must remain offline'); }));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
});
afterEach(() => {
  worlds.splice(0).forEach(world => world.dispose()); expect(fetch).not.toHaveBeenCalled(); document.body.replaceChildren();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function snapshot(initial: 'rest' | 'sleep' = 'rest'): Gathering {
  return parseGathering({ id: 'synthetic-opposed-home-journeys', title: '真实房屋相向过门', scene_type: 'home', revision: 1,
    closed: false, is_manager: true, me: 'A', members: [{ id: 'A', name: '合成主人', manager: true }],
    companions: [
      { id: 4, owner_id: 'A', name: '离开房间的伙伴', activity: initial, area: initial === 'sleep' ? 'bedroom' : 'indoor', x: .75, y: .65 },
      { id: 5, owner_id: 'A', name: '走进房间的伙伴', activity: 'observe', area: 'outdoor', x: .35, y: .55 },
    ].map(c => ({ ...c, avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features' } })),
    items: [
      { id: 'saved-tree', kind: 'tree', x: .15, y: .22, mine: true, contributor_name: '合成', growth_status: null },
      { id: 'saved-bench', kind: 'bench', x: .75, y: .65, mine: true, contributor_name: '合成', growth_status: null },
    ], votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
function swap(group: Gathering, incoming: 'rest' | 'sleep'): Gathering {
  return { ...group, revision: group.revision + 1, companions: group.companions.map(c => c.id === 4
    ? { ...c, activity: 'walk', area: 'outdoor' } : { ...c, activity: incoming, area: incoming === 'sleep' ? 'bedroom' : 'indoor' }) };
}
function setup(group: Gathering, entryOpen = true) {
  const host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } }); document.body.append(host, labels);
  const world = createLivingWorld(host, labels, group, vi.fn(), vi.fn(), { realistic: true, localLeisurePreview: true, localRoomTransitions: true }); worlds.push(world);
  world.setHouseView('interior'); world.setDoorOpen(ENTRY, entryOpen); world.setDoorOpen(ROOM, true);
  return { world, renderer: gpu.instances.at(-1)!, group };
}
function actor(renderer: Renderer, id: number) {
  const root = renderer.scene!.children.find(object => object.userData.characterId === id); expect(root, `actor ${id}`).toBeDefined(); return root!;
}
function body(renderer: Renderer, id: number): Body {
  const root = actor(renderer, id), envelope = new THREE.Box3(), point = new THREE.Vector3(); let radius = 0;
  expect(root.visible, `actor ${id} must not disappear to resolve traffic`).toBe(true);
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) return;
    const vertices = object.geometry.getAttribute('position'), indices = object.geometry.index;
    for (let i = 0; i < (indices?.count ?? vertices.count); i++) {
      point.fromBufferAttribute(vertices, indices ? indices.getX(i) : i).applyMatrix4(object.matrixWorld); envelope.expandByPoint(point);
      radius = Math.max(radius, Math.hypot(point.x - root.position.x, point.z - root.position.z));
    }
  });
  expect(envelope.isEmpty(), `actor ${id} must have a real rendered body`).toBe(false);
  return { id, root, position: root.position.clone(), envelope, radius, journey: root.userData.homeJourney };
}
function sweptDistance(a0: Body, a1: Body, b0: Body, b1: Body) {
  const x = a0.position.x - b0.position.x, z = a0.position.z - b0.position.z;
  const dx = a1.position.x - a0.position.x - b1.position.x + b0.position.x, dz = a1.position.z - a0.position.z - b1.position.z + b0.position.z;
  const squared = dx * dx + dz * dz, time = squared < 1e-14 ? 0 : Math.max(0, Math.min(1, -(x * dx + z * dz) / squared));
  return Math.hypot(x + time * dx, z + time * dz);
}
function unchangedFurniture(renderer: Renderer) {
  const scene = renderer.scene!, saved: Array<{ name?: string; item?: string; matrix: number[] }> = [];
  for (const name of ['home-farmhouse-tea-table', 'home-mahjong-table', 'home-common-gabled-roof', ENTRY + '-frame', ROOM + '-frame', 'room-bed-0-mattress']) {
    const object = scene.getObjectByName(name); expect(object, name).toBeDefined(); saved.push({ name, matrix: object!.matrixWorld.toArray() });
  }
  scene.traverse(object => { if (typeof object.userData.homeItemId === 'string') saved.push({ item: object.userData.homeItemId, matrix: object.matrixWorld.toArray() }); });
  expect(saved.filter(row => row.item).map(row => row.item).sort()).toEqual(['saved-bench', 'saved-tree']);
  return () => saved.forEach(row => {
    let object = row.name ? scene.getObjectByName(row.name) : undefined;
    if (row.item) scene.traverse(candidate => { if (candidate.userData.homeItemId === row.item) object = candidate; });
    expect(object, row.name ?? row.item).toBeDefined(); expect(object!.matrixWorld.toArray()).toEqual(row.matrix);
  });
}
function trace(renderer: Renderer) {
  let previous = [body(renderer, 4), body(renderer, 5)], frame = 0, minimumGap = Infinity;
  const travel = new Map([[4, 0], [5, 0]]), crossings = new Map([[4, [] as string[]], [5, [] as string[]]]), sides = new Map<string, number>();
  const phases = new Map(previous.map(row => [row.id, [row.journey?.phase ?? 'idle']]));
  const tail: unknown[] = [];
  const description = (rows = previous) => rows.map(b => ({ id: b.id, position: b.position.toArray(), area: b.root.userData.homeRegion, phase: b.journey?.phase, target: b.journey?.targetKey, waitingFor: b.journey?.waitingFor, portal: b.root.userData.journeyPortal, avoidLast: b.root.userData.journeyAvoidLast }));
  function wallMeshes() {
    const walls: THREE.Mesh[] = [];
    renderer.scene!.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) {
        const role = parent.userData.architectureRole;
        if (typeof role === 'string' && (role.startsWith('exterior-wall') || role === 'interior-partition' || role === 'courtyard-wall')) { walls.push(object); return; }
      }
    });
    expect(walls.length).toBeGreaterThan(0); return walls;
  }
  function savedSolids() {
    const solids: THREE.Object3D[] = [];
    renderer.scene!.traverse(object => {
      if (object.userData.homeNavObstacle !== true) return;
      for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (['saved-tree', 'saved-bench'].includes(parent.userData.homeItemId)) { solids.push(object); return; }
    });
    expect(solids.length, 'the saved tree and bench must remain physical obstacles').toBeGreaterThanOrEqual(2); return solids;
  }
  return {
    crossings, travel, tail,
    report() { return { frame, minimumGap, travel: Object.fromEntries(travel), crossings: Object.fromEntries(crossings), phases: Object.fromEntries(phases), actors: description(), tail }; },
    next(delta = 100) {
      vi.setSystemTime(Date.now() + delta); expect(renderer.loop).toBeTypeOf('function'); renderer.loop!(Date.now()); frame++;
      const current = [body(renderer, 4), body(renderer, 5)], scene = renderer.scene!, walls = wallMeshes(), leaves = [ENTRY, ROOM].map(id => scene.getObjectByName(id + '-leaf')!);
      tail.push({ frame, actors: description(current) }); if (tail.length > 30) tail.shift();
      const failure = () => JSON.stringify({ frame, actors: description(current) });
      for (let i = 0; i < current.length; i++) {
        const row = current[i], old = previous[i], distance = row.position.distanceTo(old.position);
        const history = phases.get(row.id)!, phase = row.journey?.phase ?? 'idle'; if (history.at(-1) !== phase) history.push(phase);
        expect(distance, 'physical root jump ' + failure()).toBeLessThan(.2);
        travel.set(row.id, travel.get(row.id)! + Math.hypot(row.position.x - old.position.x, row.position.z - old.position.z));
        const from = old.position.clone().add(new THREE.Vector3(0, .8, 0)), to = row.position.clone().add(new THREE.Vector3(0, .8, 0)), direction = to.clone().sub(from), length = direction.length();
        if (length > 1e-6) for (const [origin, vector] of [[from, direction], [to, direction.clone().negate()]] as const) {
          const ray = new THREE.Raycaster(origin, vector.clone().normalize(), 1e-5, Math.max(1e-5, length - 1e-5));
          expect(ray.intersectObjects([...walls, ...leaves], true).map(hit => hit.object.name), 'body center crossed a real wall/leaf ' + failure()).toEqual([]);
        }
        for (const solid of savedSolids()) expect(row.envelope.intersectsBox(new THREE.Box3().setFromObject(solid, true)), `body intersects saved furniture ${solid.name} ` + failure()).toBe(false);
        for (const id of [ENTRY, ROOM]) {
          const door = scene.getObjectByName(id)!, opening = door.userData.opening as { along: 'x' | 'z'; center: { x: number; z: number }; min: number; max: number };
          const along = opening.along, normal = along === 'x' ? 'z' : 'x', plane = opening.center[normal];
          const was = old.position[normal] - plane, now = row.position[normal] - plane, key = row.id + '/' + id;
          const beforeSide = sides.get(key) ?? (Math.abs(was) > 1e-6 ? Math.sign(was) : 0), side = Math.abs(now) > 1e-6 ? Math.sign(now) : 0;
          const t = was === now ? 0 : was / (was - now), across = THREE.MathUtils.lerp(old.position[along], row.position[along], t);
          if (side && beforeSide && side !== beforeSide && across >= opening.min && across <= opening.max) { crossings.get(row.id)!.push(id); expect(door.userData.homeDoorOpenness, 'crossing a partly open door ' + failure()).toBeCloseTo(1, 7); }
          if (side) sides.set(key, side);
          const box = row.envelope;
          if (box.min[normal] < plane - .015 && box.max[normal] > plane + .015 && box.max[along] > opening.min && box.min[along] < opening.max) {
            expect(door.userData.homeDoorOpenness, 'body entering a partly open portal ' + failure()).toBeCloseTo(1, 7);
            expect(box.min[along], 'body outside portal jamb ' + failure()).toBeGreaterThanOrEqual(opening.min - .002);
            expect(box.max[along], 'body outside portal jamb ' + failure()).toBeLessThanOrEqual(opening.max + .002);
          }
        }
      }
      const a = current[0], b = current[1], overlap = a.envelope.min.x < b.envelope.max.x - 1e-5 && a.envelope.max.x > b.envelope.min.x + 1e-5 && a.envelope.min.z < b.envelope.max.z - 1e-5 && a.envelope.max.z > b.envelope.min.z + 1e-5;
      expect(overlap, 'actual rendered bodies overlap ' + failure()).toBe(false);
      const gap = sweptDistance(previous[0], a, previous[1], b) - Math.max(previous[0].radius, a.radius) - Math.max(previous[1].radius, b.radius); minimumGap = Math.min(minimumGap, gap);
      expect(gap, 'continuous swept body envelopes intersect ' + failure()).toBeGreaterThanOrEqual(-1e-4);
      previous = current; return current;
    },
    until(predicate: (rows: Body[]) => boolean, limit = 900) {
      for (let i = 0; i < limit; i++) { const rows = this.next(); if (predicate(rows)) return rows; }
      throw new Error('OPPOSED_JOURNEY_DEADLOCK ' + JSON.stringify(this.report()));
    },
  };
}
function arrived(rows: Body[], incoming: 'rest' | 'sleep') {
  return rows[0].root.userData.homeRegion === 'outdoor' && !rows[0].journey?.active && !!rows[1].root.userData[incoming === 'sleep' ? 'sleepingBed' : 'roomRestSeat'];
}
function checkArrival(path: ReturnType<typeof trace>, incoming: 'rest' | 'sleep', initial: 'rest' | 'sleep') {
  expect(path.crossings.get(4)).toEqual(initial === 'sleep' ? [ROOM, ENTRY] : [ENTRY]);
  expect(path.crossings.get(5)).toEqual(incoming === 'sleep' ? [ENTRY, ROOM] : [ENTRY]);
  expect(path.travel.get(4)).toBeGreaterThan(5); expect(path.travel.get(5)).toBeGreaterThan(5);
}

describe('real saved home opposed doorway journeys', () => {
  it.each([['sleep', 'sleep'], ['rest', 'rest'], ['rest', 'sleep']] as const)('lets %s leave while the courtyard actor enters to %s without body penetration or a two-door deadlock', (initial, incoming) => {
    const group = snapshot(initial), next = swap(group, incoming), originals = [JSON.stringify(group), JSON.stringify(next)], fixture = setup(group), checkFurniture = unchangedFurniture(fixture.renderer);
    const before = [4, 5].map(id => actor(fixture.renderer, id).position.toArray()); fixture.world.update(next, null, 'overview');
    expect([4, 5].map(id => actor(fixture.renderer, id).position.toArray())).toEqual(before);
    const path = trace(fixture.renderer); fixture.world.setMotion(true); path.until(rows => arrived(rows, incoming)); checkArrival(path, incoming, initial); const completedAt = path.report().frame;
    const afterArrival = path.travel.get(4)!; for (let i = 0; i < 100; i++) path.next(); expect(path.travel.get(4)! - afterArrival).toBeGreaterThan(.3);
    expect(actor(fixture.renderer, 4).userData.sleepingBed).toBeUndefined(); expect(actor(fixture.renderer, 4).userData.roomRestSeat).toBeUndefined();
    checkFurniture(); expect([JSON.stringify(group), JSON.stringify(next)]).toEqual(originals); console.info('OPPOSED_JOURNEY_ACTUAL ' + JSON.stringify({ initial, incoming, completedAt, ...path.report() }));
  }, 20_000);

  it('keeps both sides outside a closed entry, then lets both opposing journeys finish after the leaf opens', () => {
    const group = snapshot('sleep'), next = swap(group, 'sleep'), originals = [JSON.stringify(group), JSON.stringify(next)], fixture = setup(group, false), checkFurniture = unchangedFurniture(fixture.renderer);
    fixture.world.update(next, null); const path = trace(fixture.renderer); fixture.world.setMotion(true);
    const waiting = path.until(rows => rows.every(row => row.journey?.waitingFor === ENTRY)), stopped = waiting.map(row => row.position.clone());
    for (let i = 0; i < 50; i++) for (const [j, row] of path.next().entries()) { expect(row.position.x).toBe(stopped[j].x); expect(row.position.z).toBe(stopped[j].z); }
    expect(fixture.renderer.scene!.getObjectByName(ENTRY)!.userData.homeDoorOpenness).toBe(0); fixture.world.setDoorOpen(ENTRY, true);
    path.until(rows => arrived(rows, 'sleep')); checkArrival(path, 'sleep', 'sleep'); checkFurniture(); expect([JSON.stringify(group), JSON.stringify(next)]).toEqual(originals);
    console.info('OPPOSED_JOURNEY_CLOSED_ACTUAL ' + JSON.stringify(path.report()));
  }, 20_000);

  it('freezes two active opposing journeys through a long pause and resumes without time jumps or an orphan doorway owner', () => {
    const group = snapshot('sleep'), next = swap(group, 'sleep'), originals = [JSON.stringify(group), JSON.stringify(next)], fixture = setup(group), checkFurniture = unchangedFurniture(fixture.renderer);
    fixture.world.update(next, null); const path = trace(fixture.renderer); fixture.world.setMotion(true); path.until(() => path.travel.get(4)! > .5 && path.travel.get(5)! > .5);
    fixture.world.setMotion(false); const before = [4, 5].map(id => actor(fixture.renderer, id).position.toArray()); vi.setSystemTime(Date.now() + 3_600_000);
    for (let i = 0; i < 3; i++) { fixture.world.reset(); fixture.world.update({ ...next, revision: next.revision + i + 1 }, null, 'overview'); }
    expect([4, 5].map(id => actor(fixture.renderer, id).position.toArray())).toEqual(before);
    fixture.world.setMotion(true); path.next(50); path.until(rows => arrived(rows, 'sleep')); checkArrival(path, 'sleep', 'sleep'); checkFurniture();
    expect([JSON.stringify(group), JSON.stringify(next)]).toEqual(originals); console.info('OPPOSED_JOURNEY_PAUSE_ACTUAL ' + JSON.stringify(path.report()));
  }, 20_000);
});
