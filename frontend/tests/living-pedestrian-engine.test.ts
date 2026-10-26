import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering, type Gathering } from '@/lib/gatherings';

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
const worlds: Array<ReturnType<typeof createLivingWorld>> = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); gpu.instances.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('pedestrian integration must remain offline'); }));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
});
afterEach(() => {
  worlds.splice(0).forEach(world => world.dispose()); expect(fetch).not.toHaveBeenCalled();
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function snapshot(count = 2): Gathering {
  return parseGathering({ id: 'synthetic-pedestrian-traffic', title: '本地伙伴步行互避', scene_type: 'home', revision: 1,
    closed: false, is_manager: true, me: 'owner', members: [{ id: 'owner', name: '合成成员', manager: true }],
    companions: Array.from({ length: count }, (_, i) => ({ id: i + 4, owner_id: 'owner', name: `步行伙伴${i + 1}`, activity: 'walk', area: 'outdoor', x: .62, y: .68,
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features' } })),
    items: [{ id: 'pedestrian-saved-bench', kind: 'bench', x: .2, y: .7, mine: true, contributor_name: '合成成员', growth_status: null }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
function setup(group = snapshot()) {
  const host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } }); document.body.append(host, labels);
  const world = createLivingWorld(host, labels, group, vi.fn(), vi.fn(), { realistic: true }); worlds.push(world);
  return { world, host, group, renderer: gpu.instances.at(-1)! };
}
function avatar(scene: THREE.Scene, id: number) {
  const root = scene.children.find(object => object.userData.characterId === id); expect(root).toBeDefined(); return root!;
}
function step(renderer: typeof gpu.instances[number], delta = 100) {
  vi.setSystemTime(Date.now() + delta); expect(renderer.loop).toBeTypeOf('function'); renderer.loop!(Date.now());
}
function visibleEnvelope(root: THREE.Object3D) {
  const box = new THREE.Box3(), point = new THREE.Vector3();
  root.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    for (let parent: THREE.Object3D | null = o; parent; parent = parent.parent) if (!parent.visible) return;
    const vertices = o.geometry.getAttribute('position');
    for (let i = 0; i < vertices.count; i++) box.expandByPoint(point.fromBufferAttribute(vertices, i).applyMatrix4(o.matrixWorld));
  });
  return box;
}
function overlapsXZ(a: THREE.Box3, b: THREE.Box3) { return a.min.x < b.max.x - 1e-5 && a.max.x > b.min.x + 1e-5 && a.min.z < b.max.z - 1e-5 && a.max.z > b.min.z + 1e-5; }
type BodyFrame = { id: number; x: number; z: number; radius: number; envelope: THREE.Box3 };
function bodyFrame(scene: THREE.Scene, id: number): BodyFrame {
  const root = avatar(scene, id), envelope = visibleEnvelope(root); let radius = 0;
  const point = new THREE.Vector3();
  root.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    for (let parent: THREE.Object3D | null = o; parent; parent = parent.parent) if (!parent.visible) return;
    const vertices = o.geometry.getAttribute('position');
    for (let i = 0; i < vertices.count; i++) { point.fromBufferAttribute(vertices, i).applyMatrix4(o.matrixWorld); radius = Math.max(radius, Math.hypot(point.x - root.position.x, point.z - root.position.z)); }
  });
  expect(root.visible, `actor ${id} must remain rendered`).toBe(true); expect(envelope.isEmpty()).toBe(false);
  return { id, x: root.position.x, z: root.position.z, radius, envelope };
}
function sweptDistance(a0: BodyFrame, a1: BodyFrame, b0: BodyFrame, b1: BodyFrame) {
  const x = a0.x - b0.x, z = a0.z - b0.z, dx = a1.x - a0.x - b1.x + b0.x, dz = a1.z - a0.z - b1.z + b0.z;
  const length = dx * dx + dz * dz, time = length < 1e-14 ? 0 : Math.max(0, Math.min(1, -(x * dx + z * dz) / length));
  return Math.hypot(x + time * dx, z + time * dz);
}
function stationaryFurniture(scene: THREE.Scene) {
  const rows: Array<{ object: THREE.Object3D; matrix: number[] }> = [];
  for (const name of ['home-farmhouse-tea-table', 'home-mahjong-table', 'home-common-gabled-roof']) { const object = scene.getObjectByName(name)!; expect(object).toBeDefined(); rows.push({ object, matrix: object.matrixWorld.toArray() }); }
  scene.traverse(object => { if (typeof object.userData.homeItemId === 'string') rows.push({ object, matrix: object.matrixWorld.toArray() }); });
  return () => rows.forEach(row => expect(row.object.matrixWorld.toArray()).toEqual(row.matrix));
}

describe('real home engine pedestrian traffic', () => {
  it('keeps two walkers from the same saved anchor outside each other actual visible body envelopes on every rendered frame', () => {
    const group = snapshot(), original = JSON.stringify(group), { world, renderer } = setup(group), rows: Array<{ frame: number; distance: number; overlap: boolean; positions: number[][] }> = [];
    world.setMotion(true);
    for (let frame = 0; frame < 600; frame++) {
      if (frame) step(renderer);
      const a = avatar(renderer.scene!, 4), b = avatar(renderer.scene!, 5);
      rows.push({ frame, distance: Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z), overlap: overlapsXZ(visibleEnvelope(a), visibleEnvelope(b)), positions: [a.position.toArray(), b.position.toArray()] });
    }
    console.info('PEDESTRIAN_ACTUAL_FRAMES ' + JSON.stringify(rows));
    expect(JSON.stringify(group)).toBe(original);
    expect(rows.filter(row => row.overlap), 'actual rendered body envelopes overlap').toEqual([]);
  });

  it.each([2, 10])('keeps %i actual walking bodies separated throughout every swept frame and lets each continue after encounters', count => {
    const group = snapshot(count), original = JSON.stringify(group), { world, renderer } = setup(group), scene = renderer.scene!;
    const checkFurniture = stationaryFurniture(scene), ids = group.companions.map(c => c.id), travelled = new Map(ids.map(id => [id, 0])), lateTravel = new Map(ids.map(id => [id, 0]));
    let previous = ids.map(id => bodyFrame(scene, id)), minimumGap = Infinity, overlaps = 0, minimumDistance = Infinity;
    const violations: Array<{ frame: number; actors: number[]; distance: number; required: number }> = [];
    world.setMotion(true);
    for (let frame = 0; frame < 900; frame++) {
      step(renderer); const current = ids.map(id => bodyFrame(scene, id));
      for (let i = 0; i < current.length; i++) {
        const distance = Math.hypot(current[i].x - previous[i].x, current[i].z - previous[i].z);
        travelled.set(ids[i], travelled.get(ids[i])! + distance); if (frame >= 600) lateTravel.set(ids[i], lateTravel.get(ids[i])! + distance);
        expect(distance, `actor ${ids[i]} frame ${frame} cannot jump between frames`).toBeLessThan(.2);
        for (let j = i + 1; j < current.length; j++) {
          const distance = sweptDistance(previous[i], current[i], previous[j], current[j]);
          const required = Math.max(previous[i].radius, current[i].radius) + Math.max(previous[j].radius, current[j].radius);
          minimumGap = Math.min(minimumGap, distance - required); minimumDistance = Math.min(minimumDistance, distance);
          if (overlapsXZ(current[i].envelope, current[j].envelope)) overlaps++;
          if (distance < required - 1e-4 && violations.length < 15) violations.push({ frame, actors: [ids[i], ids[j]], distance, required });
        }
      }
      previous = current;
    }
    console.info('PEDESTRIAN_SWEPT_SUMMARY ' + JSON.stringify({ count, frames: 900, minimumGap, minimumDistance, overlaps, travelled: Object.fromEntries(travelled), lateTravel: Object.fromEntries(lateTravel), violations }));
    expect(violations).toEqual([]); expect(overlaps).toBe(0);
    for (const id of ids) { expect(travelled.get(id), `actor ${id} should make real progress`).toBeGreaterThan(1); expect(lateTravel.get(id), `actor ${id} should still move after encounters`).toBeGreaterThan(.3); }
    checkFurniture(); expect(JSON.stringify(group)).toBe(original);
  });

  it('keeps a stationary observer in place while real walking bodies avoid its visible envelope', () => {
    const group = snapshot(3); group.companions[1] = { ...group.companions[1], activity: 'observe' };
    const original = JSON.stringify(group), { world, renderer } = setup(group), observer = avatar(renderer.scene!, 5), anchor = observer.position.clone();
    let overlaps = 0, minimumGap = Infinity; const travelled = new Map([[4, 0], [6, 0]]), previous = new Map([4, 6].map(id => [id, avatar(renderer.scene!, id).position.clone()]));
    world.setMotion(true);
    for (let frame = 0; frame < 900; frame++) {
      step(renderer); expect(observer.position.x).toBe(anchor.x); expect(observer.position.z).toBe(anchor.z);
      const stationary = bodyFrame(renderer.scene!, 5);
      for (const id of [4, 6]) {
        const moving = bodyFrame(renderer.scene!, id), root = avatar(renderer.scene!, id);
        const distance = Math.hypot(moving.x - stationary.x, moving.z - stationary.z);
        minimumGap = Math.min(minimumGap, distance - moving.radius - stationary.radius);
        if (overlapsXZ(moving.envelope, stationary.envelope)) overlaps++;
        const prior = previous.get(id)!; travelled.set(id, travelled.get(id)! + Math.hypot(root.position.x - prior.x, root.position.z - prior.z)); previous.set(id, root.position.clone());
      }
    }
    console.info('PEDESTRIAN_OBSERVER_SUMMARY ' + JSON.stringify({ overlaps, minimumGap, travelled: Object.fromEntries(travelled) }));
    expect(overlaps).toBe(0); expect(minimumGap).toBeGreaterThanOrEqual(-1e-4);
    expect([...travelled.values()].every(distance => distance > 1)).toBe(true); expect(JSON.stringify(group)).toBe(original);
  });

  it('does not let a walking actor in another home region change the outdoor actor actual trajectory', () => {
    const group = snapshot(); group.companions[1] = { ...group.companions[1], area: 'indoor' };
    const control = { ...group, companions: group.companions.map(c => c.id === 5 ? { ...c, avatar3d: { ...c.avatar3d!, kind: 'unavailable' as const } } : c) };
    const before = [JSON.stringify(group), JSON.stringify(control)], a = setup(group), b = setup(control);
    a.world.setMotion(true); b.world.setMotion(true);
    const start = avatar(a.renderer.scene!, 4).position.clone();
    for (let frame = 0; frame < 400; frame++) {
      vi.setSystemTime(Date.now() + 100); a.renderer.loop!(Date.now()); b.renderer.loop!(Date.now());
      const actual = avatar(a.renderer.scene!, 4).position, expected = avatar(b.renderer.scene!, 4).position;
      expect(actual.x).toBeCloseTo(expected.x, 7); expect(actual.z).toBeCloseTo(expected.z, 7);
    }
    expect(avatar(a.renderer.scene!, 4).position.distanceTo(start)).toBeGreaterThan(.3);
    expect([JSON.stringify(group), JSON.stringify(control)]).toEqual(before);
  });

  it('freezes actual positions through a long pause and resumes without a wall-clock jump or collision', () => {
    const group = snapshot(), original = JSON.stringify(group), { world, renderer } = setup(group);
    world.setMotion(true); for (let i = 0; i < 150; i++) step(renderer);
    world.setMotion(false); const before = [4, 5].map(id => avatar(renderer.scene!, id).position.clone());
    vi.setSystemTime(Date.now() + 3_600_000); for (let i = 0; i < 5; i++) world.reset();
    for (const [i, id] of [4, 5].entries()) expect(avatar(renderer.scene!, id).position.toArray()).toEqual(before[i].toArray());
    world.setMotion(true); step(renderer, 50);
    for (const [i, id] of [4, 5].entries()) expect(avatar(renderer.scene!, id).position.distanceTo(before[i])).toBeLessThan(.15);
    expect(overlapsXZ(visibleEnvelope(avatar(renderer.scene!, 4)), visibleEnvelope(avatar(renderer.scene!, 5)))).toBe(false);
    expect(JSON.stringify(group)).toBe(original);
  });

  it('removes departed actors, clears traffic across scene changes, and allows the remaining walker to continue', () => {
    const group = snapshot(), original = JSON.stringify(group), { world, renderer } = setup(group);
    world.setMotion(true); for (let i = 0; i < 80; i++) step(renderer);
    const removed = { ...group, revision: 2, companions: group.companions.filter(c => c.id !== 5) }, removedBefore = JSON.stringify(removed);
    world.update(removed, null); expect(renderer.scene!.children.some(o => o.userData.characterId === 5)).toBe(false);
    const start = avatar(renderer.scene!, 4).position.clone(); let travel = 0, previous = start;
    for (let i = 0; i < 100; i++) { step(renderer); const current = avatar(renderer.scene!, 4).position.clone(); travel += Math.hypot(current.x - previous.x, current.z - previous.z); previous = current; }
    expect(travel).toBeGreaterThan(1);
    world.update({ ...removed, revision: 3, scene_type: 'forest' }, null); for (let i = 0; i < 10; i++) step(renderer);
    const returned = { ...group, id: 'synthetic-pedestrian-returned', revision: 4 }, returnedBefore = JSON.stringify(returned);
    world.update(returned, null);
    for (let i = 0; i < 100; i++) { step(renderer); expect(overlapsXZ(visibleEnvelope(avatar(renderer.scene!, 4)), visibleEnvelope(avatar(renderer.scene!, 5)))).toBe(false); }
    expect(JSON.stringify(group)).toBe(original); expect(JSON.stringify(removed)).toBe(removedBefore); expect(JSON.stringify(returned)).toBe(returnedBefore);
  });

  it('disposal clears the animation and leaves a fresh world with the same deterministic initial physical positions', () => {
    const group = snapshot(), original = JSON.stringify(group), a = setup(group), initial = [4, 5].map(id => avatar(a.renderer.scene!, id).position.toArray());
    a.world.setMotion(true); for (let i = 0; i < 120; i++) step(a.renderer);
    const staleLoop = a.renderer.loop!, last = [4, 5].map(id => avatar(a.renderer.scene!, id).position.clone());
    a.world.dispose(); a.world.dispose(); expect(a.renderer.loop).toBeNull(); expect(a.host.querySelector('canvas')).toBeNull();
    vi.setSystemTime(Date.now() + 1000); staleLoop(Date.now());
    for (const [i, id] of [4, 5].entries()) expect(avatar(a.renderer.scene!, id).position.toArray()).toEqual(last[i].toArray());
    const b = setup(group); expect([4, 5].map(id => avatar(b.renderer.scene!, id).position.toArray())).toEqual(initial);
    expect(JSON.stringify(group)).toBe(original);
  });
});
