import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLivingWorld, disposeLivingObject } from '@/lib/living-world-engine';
import { parseGathering, type Gathering } from '@/lib/gatherings';
import { buildHomeWorldEnvironment } from '@/lib/living-home-world-meshes';
import { buildRealisticHomeItem } from '@/lib/living-home-realistic-details';
import type { HomeMaterialLibrary } from '@/lib/living-home-materials';
import type { HomeLeisureSnapshot } from '@/lib/living-home-leisure';
import * as homeAudio from '@/lib/living-home-audio';

const gpu = vi.hoisted(() => ({ instances: [] as Array<{ scene: THREE.Scene | null; camera: THREE.Camera | null; loop: ((time: number) => void) | null }> }));
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class Renderer {
    domElement = document.createElement('canvas'); shadowMap = { enabled: false, type: 0 };
    outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 1;
    scene: THREE.Scene | null = null; camera: THREE.Camera | null = null; loop: ((time: number) => void) | null = null;
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn();
    setAnimationLoop = vi.fn((loop: ((time: number) => void) | null) => { this.loop = loop; });
    render = vi.fn((scene: THREE.Scene, camera: THREE.Camera) => { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); this.scene = scene; this.camera = camera; });
    constructor() { gpu.instances.push(this); }
  }
  return { ...actual, WebGLRenderer: Renderer };
});

const worlds: Array<ReturnType<typeof createLivingWorld>> = [], roots = new Set<THREE.Group>();
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); gpu.instances.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
});
afterEach(() => {
  worlds.splice(0).forEach(world => world.dispose()); roots.forEach(root => disposeLivingObject(root)); roots.clear();
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function snapshot(): Gathering {
  return parseGathering({ id: 'synthetic-physical-navigation', title: '合成实体避障', scene_type: 'home', revision: 1, closed: false, is_manager: true, me: 'owner', invitation: null,
    members: [{ id: 'owner', name: '合成成员', manager: true }], companions: [{ id: 4, name: '合成伙伴', owner_id: 'owner', activity: 'walk', area: 'outdoor', x: .5, y: .5,
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features' } }],
    items: [{ id: 'saved-collision-bench', kind: 'bench', x: .5, y: .5623, mine: true, contributor_name: '合成成员', growth_status: null }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
function setup(realistic = true, group = snapshot(), localLeisurePreview = false) {
  const host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } }); document.body.append(host, labels);
  const selected = vi.fn(), changed = vi.fn(), leisureChanged = vi.fn();
  const world = createLivingWorld(host, labels, group, selected, changed, { realistic, localLeisurePreview, onLeisureChange: leisureChanged }); worlds.push(world);
  return { host, world, group, selected, changed, leisureChanged, renderer: gpu.instances.at(-1)! };
}
function avatar(scene: THREE.Scene, id = 4) {
  const root = scene.children.find(object => object.userData.characterId === id); expect(root).toBeDefined(); return root!;
}
function savedItems(scene: THREE.Scene) {
  const roots = scene.children.filter(object => object instanceof THREE.Group && object.children.some(child => typeof child.userData.homeItemId === 'string'));
  expect(roots).toHaveLength(1); return roots[0];
}
function xzOverlaps(a: THREE.Box3, b: THREE.Box3) {
  return a.min.x < b.max.x - 1e-5 && a.max.x > b.min.x + 1e-5 && a.min.z < b.max.z - 1e-5 && a.max.z > b.min.z + 1e-5;
}
function xzDistance(a: THREE.Vector3, b: THREE.Vector3) { return Math.hypot(a.x - b.x, a.z - b.z); }
function checkSavedBench(scene: THREE.Scene) {
  const body = new THREE.Box3().setFromObject(avatar(scene)), items = savedItems(scene);
  expect(items.children).toHaveLength(1);
  const bench = new THREE.Box3().setFromObject(items.children[0]);
  expect(xzOverlaps(body, bench), JSON.stringify({ body: [body.min.toArray(), body.max.toArray()], bench: [bench.min.toArray(), bench.max.toArray()] })).toBe(false);
}
function step(renderer: typeof gpu.instances[number], milliseconds: number) {
  vi.setSystemTime(Date.now() + milliseconds); expect(renderer.loop).toBeTypeOf('function'); renderer.loop!(Date.now());
}
function resources(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  root.traverse(object => { if (object instanceof THREE.Mesh) { geometries.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
    materials.add(material); for (const value of [...Object.values(material), ...(material.userData.homeOwnedTextures ?? [])]) if (value instanceof THREE.Texture) textures.add(value);
  } } }); return { geometries, materials, textures };
}
function visibleVertexFloor(root: THREE.Object3D, coreOnly = false) {
  let minimum = Infinity, count = 0; const point = new THREE.Vector3();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || coreOnly && object.userData.sleepBodySupport !== true) return;
    for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) return;
    const position = object.geometry.getAttribute('position'), indices = object.geometry.index;
    for (let i = 0; i < (indices?.count ?? position.count); i++) {
      point.fromBufferAttribute(position, indices ? indices.getX(i) : i).applyMatrix4(object.matrixWorld); minimum = Math.min(minimum, point.y); count++;
    }
  }); return { minimum, count };
}
function actualCylinderContactBands(root: THREE.Object3D) {
  const bands: Array<{ lower: THREE.Vector3; upper: THREE.Vector3 }> = [];
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || object.userData.sleepBodySupport !== true) return;
    const positions = object.geometry.getAttribute('position'), index = object.geometry.index;
    let low = Infinity, high = -Infinity;
    for (let i = 0; i < positions.count; i++) { low = Math.min(low, positions.getY(i)); high = Math.max(high, positions.getY(i)); }
    const middle = (low + high) / 2, lower = new THREE.Vector3(0, Infinity, 0), upper = new THREE.Vector3(0, Infinity, 0), point = new THREE.Vector3();
    for (let i = 0; i < (index?.count ?? positions.count); i++) {
      const vertex = index ? index.getX(i) : i, localY = positions.getY(vertex);
      point.fromBufferAttribute(positions, vertex).applyMatrix4(object.matrixWorld);
      if (localY < middle && point.y < lower.y) lower.copy(point);
      if (localY > middle && point.y < upper.y) upper.copy(point);
    }
    bands.push({ lower, upper });
  }); return bands;
}
function dailySnapshot(): Gathering {
  const group = snapshot(), base = group.companions[0];
  group.id = 'synthetic-daily-nine';
  group.companions = Array.from({ length: 9 }, (_, i) => ({ ...base, id: i + 1, name: `合成日常${i + 1}`,
    activity: i === 7 ? 'sleep' : i === 8 ? 'walk' : i === 6 ? 'rest' : 'observe',
    area: i === 7 ? 'bedroom' : i === 6 ? 'indoor' : 'outdoor' }));
  return group;
}
function startDailyStations(world: ReturnType<typeof createLivingWorld>) {
  expect(world.toggleLocalLeisure('mahjong')).toBe(true);
  expect(world.startLocalLeisure('tea', 5)).toBe(true);
  expect(world.startLocalLeisure('bench', 6)).toBe(true);
  expect(world.startLocalLeisure('television', 7)).toBe(true);
}
function cupRest(cup: THREE.Object3D) {
  return { parent: cup.parent, position: cup.position.toArray(), quaternion: cup.quaternion.toArray(), scale: cup.scale.toArray(), matrixAutoUpdate: cup.matrixAutoUpdate };
}
function exactProp(object: THREE.Object3D) { return { ...cupRest(object), matrix: object.matrix.toArray() }; }
function ancestorActor(object: THREE.Object3D) {
  for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (typeof parent.userData.characterId === 'number') return parent.userData.characterId as number;
  return null;
}
function enterPropWindow(world: ReturnType<typeof createLivingWorld>, renderer: typeof gpu.instances[number]) {
  world.setMotion(true);
  for (let i = 0; i < 450; i++) {
    step(renderer, 100);
    if (ancestorActor(renderer.scene!.getObjectByName('home-mahjong-tile-0')!) === 1
      && ancestorActor(renderer.scene!.getObjectByName('home-television-seed-0')!) === 7) return;
  }
  throw new Error('actual tile and seed were not held together during the local rhythm');
}

describe('real engine navigation and shared environment resources', () => {
  it.each([
    { synthetic: false, realistic: true, optIn: true },
    { synthetic: true, realistic: true, optIn: false },
    { synthetic: true, realistic: false, optIn: true },
  ])('daily effects and AudioContext are never allocated outside the complete preview guard: %j', async ({ synthetic, realistic, optIn }) => {
    const AudioContextConstructor = vi.fn(); vi.stubGlobal('AudioContext', AudioContextConstructor);
    const group = dailySnapshot(); if (!synthetic) group.id = 'production-daily-home';
    const { world, renderer } = setup(realistic, group, optIn);
    expect(renderer.scene!.getObjectByName('home-local-activity-effects')).toBeUndefined();
    expect(renderer.scene!.getObjectByName('home-tea-steam-0')).toBeUndefined();
    expect(await world.setLifeAudio(true)).toBe(false); world.setMotion(true); step(renderer, 100); world.setMotion(false);
    expect(AudioContextConstructor).not.toHaveBeenCalled();
  });

  it('daily engine keeps audio off until explicit enable, pauses it on setMotion(false), and closes once on dispose', async () => {
    const gain = { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
    const context = { state: 'running', createGain: vi.fn(() => gain), destination: {}, close: vi.fn(() => Promise.resolve()) };
    const AudioContextConstructor = vi.fn(function () { return context; }); vi.stubGlobal('AudioContext', AudioContextConstructor);
    const factory = vi.spyOn(homeAudio, 'createHomeAudio'), { world, renderer } = setup(true, dailySnapshot(), true);
    const audio = factory.mock.results[0].value as ReturnType<typeof homeAudio.createHomeAudio>, pause = vi.spyOn(audio, 'pause');
    world.setMotion(true); step(renderer, 100); world.setMotion(false); expect(AudioContextConstructor).not.toHaveBeenCalled();
    expect(await world.setLifeAudio(true)).toBe(true); expect(AudioContextConstructor).toHaveBeenCalledTimes(1);
    world.setMotion(false); expect(pause).toHaveBeenCalled(); world.dispose(); world.dispose();
    expect(context.close).toHaveBeenCalledTimes(1); expect(await world.setLifeAudio(true)).toBe(false);
    expect(AudioContextConstructor).toHaveBeenCalledTimes(1);
  });

  it('daily paused renderer holds actual borrowed tile, seed, avatars and steam at the same elapsed time', () => {
    const AudioContextConstructor = vi.fn(); vi.stubGlobal('AudioContext', AudioContextConstructor);
    const { world, renderer } = setup(true, dailySnapshot(), true);
    startDailyStations(world); enterPropWindow(world, renderer); world.setMotion(false);
    const capture = () => {
      const actors = [1, 7].map(id => { const matrices: number[][] = []; avatar(renderer.scene!, id).traverse(o => matrices.push(o.matrixWorld.toArray())); return matrices; });
      const steam = [0, 1, 2].map(i => Array.from((renderer.scene!.getObjectByName(`home-tea-steam-${i}`) as THREE.Line).geometry.getAttribute('position').array));
      const mist = (renderer.scene!.getObjectByName('home-tea-steam-mist') as THREE.Points).geometry;
      return { actors, steam, mist: Array.from(mist.getAttribute('position').array), opacity: Array.from(mist.getAttribute('aOpacity').array) };
    };
    const frozen = capture(); vi.setSystemTime(Date.now() + 3_600_000); world.reset(); world.reset();
    expect(capture()).toEqual(frozen); expect(AudioContextConstructor).not.toHaveBeenCalled();
  });

  it('daily TV power-off releases the borrowed seed while preserving the viewing assignment', () => {
    const { world, renderer } = setup(true, dailySnapshot(), true), seed = renderer.scene!.getObjectByName('home-television-seed-0')!, before = exactProp(seed);
    startDailyStations(world); enterPropWindow(world, renderer); world.setMotion(false);
    expect(ancestorActor(seed)).toBe(7); expect(world.toggleLocalLeisure('television')).toBe(true);
    expect(world.getLocalLeisure().television.powered).toBe(false); expect(exactProp(seed)).toEqual(before);
    expect(world.getLocalLeisure().assignments.find(a => a.actorId === 7)?.activity).toBe('television');
  });

  it('daily TV power-off clears the actual body laugh offset while keeping the actor seated', () => {
    const { world, renderer } = setup(true, dailySnapshot(), true), body = avatar(renderer.scene!, 7).getObjectByName('body')!, baseY = body.position.y;
    expect(world.startLocalLeisure('television', 7)).toBe(true); world.setMotion(true);
    let laughed = false;
    for (let i = 0; i < 350; i++) { step(renderer, 100); if (Math.abs(body.rotation.z) > .002 && Math.abs(body.position.y - baseY) > .001) { laughed = true; break; } }
    expect(laughed).toBe(true); world.setMotion(false);
    expect(body.position.y).not.toBeCloseTo(baseY, 4); expect(world.toggleLocalLeisure('television')).toBe(true);
    expect(body.position.y).toBeCloseTo(baseY, 8); expect(body.rotation.z).toBeCloseTo(0, 8);
    expect(avatar(renderer.scene!, 7).userData.roomRestSeat).toBeDefined();
  });

  it.each(['stop', 'remove-actors', 'replace-world', 'leave-preview', 'dispose'] as const)('daily borrowed tiles and seeds restore exactly before %s releases resources', action => {
    const { world, renderer, group } = setup(true, dailySnapshot(), true), scene = renderer.scene!;
    const tile = scene.getObjectByName('home-mahjong-tile-0')!, seed = scene.getObjectByName('home-television-seed-0')!;
    const tileBefore = exactProp(tile), seedBefore = exactProp(seed), originalResources = resources(scene);
    const resourceDisposals = [...originalResources.geometries, ...originalResources.materials, ...originalResources.textures].map(o => vi.spyOn(o, 'dispose'));
    const steam = scene.getObjectByName('home-local-activity-effects')!, lines = steam.children as THREE.Line[];
    const steamDisposals = lines.flatMap(line => [vi.spyOn(line.geometry, 'dispose'), vi.spyOn(line.material as THREE.Material, 'dispose')]);
    const propsAtDispose: Array<{ parent: THREE.Object3D | null; expected: THREE.Object3D | null }> = [];
    for (const object of [tile, seed]) object.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.addEventListener('dispose', () => propsAtDispose.push({ parent: object.parent, expected: object === tile ? tileBefore.parent : seedBefore.parent })); });
    startDailyStations(world); enterPropWindow(world, renderer); world.setMotion(false);
    expect(ancestorActor(tile)).toBe(1); expect(ancestorActor(seed)).toBe(7);
    if (action === 'stop') world.stopLocalLeisure();
    else if (action === 'remove-actors') world.update({ ...group, revision: 2, companions: group.companions.filter(c => ![1, 7].includes(c.id)) }, null);
    else if (action === 'replace-world') world.update({ ...group, revision: 2, season: 'winter' }, null);
    else if (action === 'leave-preview') world.update({ ...group, revision: 2, id: 'production-home' }, null);
    else world.dispose();
    expect(exactProp(tile)).toEqual(tileBefore); expect(exactProp(seed)).toEqual(seedBefore);
    world.dispose(); world.dispose(); resourceDisposals.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
    steamDisposals.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
    expect(propsAtDispose.length).toBeGreaterThan(0); propsAtDispose.forEach(row => expect(row.parent).toBe(row.expected));
  });

  it('daily life keeps nine actors in four independent stations plus sleep and walk without changing Gathering or making requests', () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const group = dailySnapshot(), original = JSON.stringify(group), { world, renderer, host, selected, changed } = setup(true, group, true);
    const sleeper = avatar(renderer.scene!, 8).position.toArray();
    startDailyStations(world);
    expect(world.getLocalLeisure().assignments.map(a => [a.actorId, a.activity])).toEqual([
      [1, 'mahjong'], [2, 'mahjong'], [3, 'mahjong'], [4, 'mahjong'], [5, 'tea'], [6, 'bench'], [7, 'television'],
    ]);
    const occupied = world.getLocalLeisure().assignments.map(a => avatar(renderer.scene!, a.actorId).userData.roomRestSeat.physicalId);
    expect(new Set(occupied).size).toBe(7);
    world.setMotion(true); for (let i = 0; i < 40; i++) step(renderer, 100);
    expect(avatar(renderer.scene!, 8).userData.sleepingBed).toBeDefined();
    expect(avatar(renderer.scene!, 8).position.x).toBe(sleeper[0]);
    expect(avatar(renderer.scene!, 9).userData.roomRestSeat).toBeUndefined();
    expect(avatar(renderer.scene!, 9).userData.homeNavigation).toBeDefined();
    expect(host.dataset.leisurePreview?.split(',').sort()).toEqual(['bench', 'mahjong', 'tea', 'television']);
    expect(JSON.stringify(group)).toBe(original); expect(request).not.toHaveBeenCalled();
    expect(selected).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  });

  it('daily tea pauses its actual cup pose, resumes from elapsed time, and stopAll restores the physical cup and saved activities', () => {
    const group = dailySnapshot(), original = JSON.stringify(group), { world, renderer } = setup(true, group, true);
    const cup = renderer.scene!.getObjectByName('home-teacup-1')!, rest = cupRest(cup);
    startDailyStations(world); expect(cup.parent).not.toBe(rest.parent);
    world.setMotion(true); for (let i = 0; i < 15; i++) step(renderer, 100);
    world.setMotion(false); const paused = cup.matrix.toArray();
    vi.setSystemTime(Date.now() + 3_600_000); world.reset(); expect(cup.matrix.toArray()).toEqual(paused);
    world.setMotion(true); step(renderer, 50); expect(cup.matrix.toArray()).not.toEqual(paused);
    world.setMotion(false); expect(world.stopLocalLeisure()).toBe(true);
    expect(world.getLocalLeisure().assignments).toEqual([]); expect(cupRest(cup)).toEqual(rest);
    expect(avatar(renderer.scene!, 8).userData.sleepingBed).toBeDefined();
    expect(avatar(renderer.scene!, 9).userData.homeNavigation).toBeDefined();
    expect(JSON.stringify(group)).toBe(original);
  });

  it('daily removal, ownership and scope changes release tea before avatar or scene disposal and cannot leak assignments', () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const group = dailySnapshot(), { world, renderer, leisureChanged } = setup(true, group, true);
    const cup = renderer.scene!.getObjectByName('home-teacup-1')!, rest = cupRest(cup);
    expect(world.startLocalLeisure('tea', 5)).toBe(true);
    const removed = { ...group, revision: 2, companions: group.companions.filter(c => c.id !== 5) }, removedBefore = JSON.stringify(removed);
    world.update(removed, null); expect(world.getLocalLeisure().assignments).toEqual([]); expect(cupRest(cup)).toEqual(rest);
    expect(renderer.scene!.children.some(o => o.userData.characterId === 5)).toBe(false); expect(JSON.stringify(removed)).toBe(removedBefore);
    expect(world.startLocalLeisure('tea', 6)).toBe(true);
    const changedOwner = { ...removed, revision: 3, companions: removed.companions.map(c => c.id === 6 ? { ...c, owner_id: 'another-owner' } : c) };
    world.update(changedOwner, null); expect(world.getLocalLeisure().assignments).toEqual([]); expect(cupRest(cup)).toEqual(rest);
    expect(world.startLocalLeisure('tea', 6)).toBe(true);
    world.update({ ...changedOwner, id: 'synthetic-other-space', revision: 4 }, null);
    expect(world.getLocalLeisure().assignments).toEqual([]); expect(cupRest(cup)).toEqual(rest);
    expect(world.startLocalLeisure('tea', 6)).toBe(true);
    world.update({ ...changedOwner, id: 'production-space', revision: 5 }, null);
    expect(world.getLocalLeisure()).toMatchObject({ permitted: false, assignments: [] }); expect(cupRest(cup)).toEqual(rest);
    const calls = leisureChanged.mock.calls.length; expect(world.startLocalLeisure('tea', 6)).toBe(false);
    expect(leisureChanged).toHaveBeenCalledTimes(calls); expect(request).not.toHaveBeenCalled();
  });

  it('daily dispose restores the borrowed cup before releasing the world and rejects later starts or callbacks', () => {
    const { world, renderer, leisureChanged, host } = setup(true, dailySnapshot(), true);
    const cup = renderer.scene!.getObjectByName('home-teacup-1')!, rest = cupRest(cup), disposedParents: THREE.Object3D[] = [];
    const geometry = (cup as THREE.Mesh).geometry; vi.spyOn(geometry, 'dispose').mockImplementation(() => { if (cup.parent) disposedParents.push(cup.parent); });
    expect(world.startLocalLeisure('tea', 5)).toBe(true); world.setMotion(true);
    const calls = leisureChanged.mock.calls.length; world.dispose(); world.dispose();
    expect(cupRest(cup)).toEqual(rest); expect(disposedParents).toEqual([rest.parent]);
    expect(renderer.loop).toBeNull(); expect(host.querySelector('canvas')).toBeNull();
    expect(world.startLocalLeisure('tea', 5)).toBe(false); expect(world.stopLocalLeisure()).toBe(false);
    expect(leisureChanged).toHaveBeenCalledTimes(calls);
  });

  it('rejects local leisure unless synthetic id, explicit opt-in, realistic mode and home scene all hold', () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const cases = [
      { group: { ...snapshot(), id: '00000000-0000-4000-8000-000000000001' }, realistic: true, optIn: true },
      { group: snapshot(), realistic: true, optIn: false },
      { group: snapshot(), realistic: false, optIn: true },
      { group: { ...snapshot(), scene_type: 'forest' as const }, realistic: true, optIn: true },
    ];
    for (const row of cases) {
      const original = JSON.stringify(row.group), { world, leisureChanged, selected, changed } = setup(row.realistic, row.group, row.optIn);
      expect(world.toggleLocalLeisure('television')).toBe(false); expect(world.toggleLocalLeisure('mahjong')).toBe(false);
      expect(leisureChanged).not.toHaveBeenCalled(); expect(selected).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
      expect(JSON.stringify(row.group)).toBe(original);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('previews television and shared table locally, pauses without time drift and restores the original sleep, rest and walk activities', () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const group = snapshot(), base = group.companions[0];
    group.companions = [base, { ...base, id: 5, name: '合成坐姿', activity: 'rest', area: 'indoor' }, { ...base, id: 6, name: '合成睡姿', activity: 'sleep', area: 'bedroom' }, { ...base, id: 7, name: '合成观察', activity: 'observe' }];
    const tooFewGroup = { ...group, companions: group.companions.slice(0, 3) }, tooFewOriginal = JSON.stringify(tooFewGroup);
    const { world: tooFewWorld } = setup(true, tooFewGroup, true), tooFewBefore = tooFewWorld.getLocalLeisure();
    expect(tooFewWorld.toggleLocalLeisure('mahjong')).toBe(false);
    expect(tooFewWorld.getLocalLeisure()).toEqual(tooFewBefore); expect(JSON.stringify(tooFewGroup)).toBe(tooFewOriginal);
    const original = JSON.stringify(group), { host, world, renderer, leisureChanged, selected, changed } = setup(true, group, true);
    const restBefore = avatar(renderer.scene!, 5).position.clone(), sleepBefore = avatar(renderer.scene!, 6).position.clone();
    const program = renderer.scene!.getObjectByName('home-television-program'); expect(program).toBeDefined();
    const visibleBefore = program!.visible; expect(world.toggleLocalLeisure('television')).toBe(true); expect(program!.visible).toBe(!visibleBefore);
    const beforeRejected = world.getLocalLeisure();
    expect(world.toggleLocalLeisure('mahjong')).toBe(false); expect(world.getLocalLeisure()).toEqual(beforeRejected);
    for (const id of [4, 5, 6, 7]) expect(world.startLocalLeisure('mahjong', id)).toBe(true);
    expect(host.dataset.leisurePreview).toBe('mahjong');
    for (const id of [4, 5, 6]) { const character = avatar(renderer.scene!, id); expect(character.userData.roomRestSeat).toBeDefined(); expect(character.userData.sleepingBed).toBeUndefined(); }
    world.setMotion(true); for (let i = 0; i < 20; i++) step(renderer, 100); world.setMotion(false);
    const transforms = [4, 5, 6].map(id => { const rows: number[][] = []; avatar(renderer.scene!, id).traverse(object => rows.push(object.matrixWorld.toArray())); return rows; });
    vi.setSystemTime(Date.now() + 3_600_000); world.reset();
    for (const [i, id] of [4, 5, 6].entries()) { const rows: number[][] = []; avatar(renderer.scene!, id).traverse(object => rows.push(object.matrixWorld.toArray())); expect(rows).toEqual(transforms[i]); }
    expect(world.toggleLocalLeisure('mahjong')).toBe(true); expect(host.dataset.leisurePreview).toBe('none');
    expect(avatar(renderer.scene!, 5).position.toArray()).toEqual(restBefore.toArray());
    expect(avatar(renderer.scene!, 6).position.toArray()).toEqual(sleepBefore.toArray());
    expect(avatar(renderer.scene!, 6).userData.sleepingBed).toBeDefined(); expect(visibleVertexFloor(avatar(renderer.scene!, 6), true).minimum).toBeCloseTo(.66, 5);
    expect(avatar(renderer.scene!, 4).userData.homeNavigation).toBeDefined(); checkSavedBench(renderer.scene!);
    expect(JSON.stringify(group)).toBe(original); expect(request).not.toHaveBeenCalled(); expect(selected).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
    const published = leisureChanged.mock.calls.map(([state]) => state as HomeLeisureSnapshot);
    expect(published.at(-1)?.assignments).toEqual([]);
    expect(published.some(state => state.assignments.length === 4)).toBe(true);
  });

  it.each(['cup', 'bouquet', 'plant', 'fruit', 'garment', 'creature'] as const)('places the actual %s core surface on the mattress through breathing, with no visible accessory below it', kind => {
    const group = snapshot(); group.companions[0] = { ...group.companions[0], activity: 'sleep', area: 'bedroom', avatar3d: { version: 1, kind, body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features' } };
    const original = JSON.stringify(group), { world, renderer } = setup(true, group), body = avatar(renderer.scene!);
    const mattress = renderer.scene!.getObjectByName('room-bed-0-mattress')!;
    const top = new THREE.Box3().setFromObject(mattress, true).max.y; expect(top).toBeCloseTo(.66, 7);
    world.setMotion(true);
    for (const delta of [50, 900, 1700]) {
      step(renderer, delta);
      const core = visibleVertexFloor(body, true), all = visibleVertexFloor(body);
      expect(core.count).toBeGreaterThan(10); expect(core.minimum).toBeCloseTo(top, 5); expect(all.minimum).toBeGreaterThanOrEqual(top - 1e-5);
      if (['cup', 'bouquet', 'plant'].includes(kind)) {
        const bands = actualCylinderContactBands(body); expect(bands).toHaveLength(1);
        for (const band of bands) {
          expect(band.lower.y, `${kind} lower body ring`).toBeCloseTo(top, 5);
          expect(band.upper.y, `${kind} upper body ring`).toBeCloseTo(top, 5);
          expect(band.lower.clone().lerp(band.upper, .5).y).toBeCloseTo(top, 5);
        }
      }
    }
    expect(JSON.stringify(group)).toBe(original);
  });

  it.each([false, true])('keeps a walking body outside its actual saved bench in classic/realistic=%s, including an unsafe initial anchor', realistic => {
    const { world, renderer, group } = setup(realistic), original = JSON.stringify(group);
    checkSavedBench(renderer.scene!); world.setMotion(true);
    const positions: THREE.Vector3[] = [];
    for (let i = 0; i < 180; i++) { step(renderer, 100); checkSavedBench(renderer.scene!); positions.push(avatar(renderer.scene!).position.clone()); }
    expect(positions.some(position => position.distanceTo(positions[0]) > .4)).toBe(true);
    expect(JSON.stringify(group)).toBe(original);
  });

  it('holds the last safe point through a long pause and resumes without a wall-clock jump or anchor reset', () => {
    const { world, renderer } = setup(); world.setMotion(true);
    for (let i = 0; i < 30; i++) step(renderer, 100);
    const before = avatar(renderer.scene!).position.clone(); world.setMotion(false);
    expect(xzDistance(avatar(renderer.scene!).position, before)).toBeLessThan(1e-7);
    vi.setSystemTime(Date.now() + 3_600_000); world.reset();
    expect(xzDistance(avatar(renderer.scene!).position, before)).toBeLessThan(1e-7); checkSavedBench(renderer.scene!);
    world.setMotion(true); step(renderer, 50);
    expect(avatar(renderer.scene!).position.distanceTo(before)).toBeLessThan(.2); checkSavedBench(renderer.scene!);
  });

  it('invalidates a route when a saved bench is moved onto the current position without modifying the saved layout', () => {
    const { world, renderer, group } = setup(); world.setMotion(true); for (let i = 0; i < 25; i++) step(renderer, 100);
    const point = avatar(renderer.scene!).position;
    const next = { ...group, revision: 2, items: [{ ...group.items[0], x: point.x / 8 + .5, y: (point.z - 4.1) / 5.2 + .5 }] };
    const original = JSON.stringify(next); world.update(next, 4, 'outdoor'); checkSavedBench(renderer.scene!);
    for (let i = 0; i < 50; i++) { step(renderer, 100); checkSavedBench(renderer.scene!); }
    expect(JSON.stringify(next)).toBe(original);
  });

  it('shows a blocked notice and hides the unsafe walker when actual saved benches leave no safe point', () => {
    const { host, world, renderer, group } = setup();
    const items = Array.from({ length: 25 }, (_, i) => ({ ...group.items[0], id: `synthetic-full-yard-${i}`, x: (i % 5) / 4, y: Math.floor(i / 5) / 4 }));
    const next = { ...group, revision: 2, items }, original = JSON.stringify(next);
    world.update(next, 4, 'outdoor'); world.setMotion(true); step(renderer, 100);
    const character = avatar(renderer.scene!);
    expect(character.userData.homeNavigation.blocked).toBe('no-safe-point'); expect(character.visible).toBe(false);
    expect(host.dataset.navigationBlocked).toBe('1');
    expect(host.querySelector('[role=status]')).toHaveTextContent('散步空间不足');
    expect(host.querySelector('[role=status]')).not.toHaveAttribute('hidden');
    expect(JSON.stringify(next)).toBe(original);
  });

  it('retains world-owned material maps during partial item release and disposes the shared textures once at final world release', () => {
    const environment = buildHomeWorldEnvironment('summer', { resting: 1, sleeping: 1 }, { realistic: true }); roots.add(environment);
    const library = environment.userData.homeMaterialLibrary as HomeMaterialLibrary;
    expect(library).toBeDefined();
    const item = buildRealisticHomeItem('bench', 'summer', library); roots.add(item);
    const itemResources = resources(item), environmentResources = resources(environment);
    const sharedMaterials = [...itemResources.materials].filter(material => environmentResources.materials.has(material));
    const sharedTextures = [...itemResources.textures].filter(texture => environmentResources.textures.has(texture));
    expect(sharedMaterials.length).toBeGreaterThan(0); expect(sharedTextures.length).toBeGreaterThan(0);
    const materialSpies = sharedMaterials.map(material => vi.spyOn(material, 'dispose'));
    const textureSpies = [...environmentResources.textures].map(texture => vi.spyOn(texture, 'dispose'));
    const geometrySpies = [...itemResources.geometries].map(geometry => vi.spyOn(geometry, 'dispose'));
    disposeLivingObject(item, [environment]); roots.delete(item);
    materialSpies.forEach(spy => expect(spy).not.toHaveBeenCalled()); textureSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    geometrySpies.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
    disposeLivingObject(environment); roots.delete(environment);
    materialSpies.forEach(spy => expect(spy).toHaveBeenCalledTimes(1)); textureSpies.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
  });

  it('rebuilds world and saved-item ownership together across seasons and releases each live resource once', () => {
    const { world, renderer, group } = setup(), oldEnvironment = renderer.scene!.getObjectByName('home-world-environment')!;
    const old = resources(oldEnvironment), oldTextureSpies = [...old.textures].map(texture => vi.spyOn(texture, 'dispose'));
    const next = { ...group, revision: 2, season: 'winter' as const };
    world.update(next, 4, 'outdoor');
    const environment = renderer.scene!.getObjectByName('home-world-environment')!;
    expect(environment).not.toBe(oldEnvironment); oldTextureSpies.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
    const live = resources(renderer.scene!), disposals = [...live.geometries, ...live.materials, ...live.textures].map(resource => vi.spyOn(resource, 'dispose'));
    const initialGeometry = [...live.geometries], initialMaterials = [...live.materials]; world.setMotion(true);
    for (let i = 0; i < 60; i++) step(renderer, 100);
    expect([...resources(renderer.scene!).geometries]).toEqual(initialGeometry); expect([...resources(renderer.scene!).materials]).toEqual(initialMaterials);
    world.dispose(); world.dispose(); disposals.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
  });
});

describe('real engine room camera safety',()=>{it('contains indoor and bedroom orbit/zoom but restores a full outside view',()=>{const {world,renderer,group}=setup(true);for(const area of ['indoor','bedroom'] as const){world.update(group,null,area);world.setHouseView('interior');for(let i=0;i<48;i++){world.rotate(Math.PI/12);world.zoom(1.5);const p=renderer.camera!.position;const cx=area==='indoor'?-5.65:5.65;expect(p.x).toBeGreaterThanOrEqual(cx-5.3+.2);expect(p.x).toBeLessThanOrEqual(cx+5.3-.2);expect(p.z).toBeGreaterThanOrEqual(-4.2-3.78+.2);expect(p.z).toBeLessThanOrEqual(-4.2+3.78-.2);expect(p.y).toBeLessThanOrEqual(2.75);}}world.setHouseView('exterior');expect(renderer.camera!.position.z).toBeGreaterThan(0);});});

describe('engine architecture label occlusion',()=>{it('hides a bedroom name and its action menu behind the living-room partition without modifying the snapshot',()=>{const group=snapshot();group.companions[0]={...group.companions[0],area:'bedroom',x:.5,y:.1};const original=JSON.stringify(group);const {world}=setup(true,group);world.update(group,null,'indoor');world.setHouseView('interior');const label=document.querySelector<HTMLElement>('[data-occluded]')!;expect(label.dataset.occluded).toBe('true');expect(label.hidden).toBe(true);const menu=document.createElement('div');document.body.append(menu);world.setSelectionMenu(menu,4);expect(menu.hidden).toBe(true);expect(JSON.stringify(group)).toBe(original);});});
