import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering, type Gathering } from '@/lib/gatherings';
import { HOME_TELEVISION_CHANNEL_NAMES } from '@/lib/living-home-television-channels';

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

type Paint = { commands: unknown[][]; context: CanvasRenderingContext2D };
let paints = new WeakMap<HTMLCanvasElement, Paint>();
function paint(canvas: HTMLCanvasElement) {
  let value = paints.get(canvas); if (value) return value;
  const commands: unknown[][] = [], styles: Record<string, unknown> = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, font: '10px sans-serif' }, saved: Array<Record<string, unknown>> = [];
  const record = (name: string, args: unknown[]) => {
    if ((name === 'clearRect' || name === 'fillRect') && args[0] === 0 && args[1] === 0 && args[2] === canvas.width && args[3] === canvas.height) commands.length = 0;
    commands.push([name, ...args, { ...styles }]);
  };
  const functions: Record<string, (...args: unknown[]) => unknown> = {
    save: () => { saved.push({ ...styles }); record('save', []); },
    restore: () => { Object.assign(styles, saved.pop()); record('restore', []); },
    measureText: text => ({ width: String(text).length * 12 }),
    createLinearGradient: (...args) => ({ kind: 'linear', args, stops: [] as unknown[][], addColorStop(this: { stops: unknown[][] }, ...stop: unknown[]) { this.stops.push(stop); } }),
    createRadialGradient: (...args) => ({ kind: 'radial', args, stops: [] as unknown[][], addColorStop(this: { stops: unknown[][] }, ...stop: unknown[]) { this.stops.push(stop); } }),
  };
  const context = new Proxy({ canvas }, {
    get(target, key) {
      if (key === 'canvas') return target.canvas; if (typeof key !== 'string') return undefined;
      if (key in styles) return styles[key]; if (!functions[key]) functions[key] = (...args) => record(key, args); return functions[key];
    },
    set(_target, key, next) { styles[String(key)] = next; return true; },
  }) as unknown as CanvasRenderingContext2D;
  value = { commands, context }; paints.set(canvas, value); return value;
}

const worlds: Array<ReturnType<typeof createLivingWorld>> = [];
let hidden = false, hiddenDescriptor: PropertyDescriptor | undefined, visibilityDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); gpu.instances.length = 0; paints = new WeakMap(); hidden = false;
  hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden'); visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperties(document, { hidden: { configurable: true, get: () => hidden }, visibilityState: { configurable: true, get: () => hidden ? 'hidden' : 'visible' } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('television channels must stay offline'); }));
  vi.stubGlobal('Audio', vi.fn(() => { throw new Error('television programmes add no media playback or noise'); }));
  vi.stubGlobal('AudioContext', vi.fn(() => { throw new Error('television programmes must not enable audio'); }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) { return paint(this).context; });
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
});
afterEach(() => {
  worlds.splice(0).forEach(world => world.dispose()); expect(fetch).not.toHaveBeenCalled(); expect(Audio).not.toHaveBeenCalled(); expect(AudioContext).not.toHaveBeenCalled();
  if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor); else delete (document as unknown as Record<string, unknown>).hidden;
  if (visibilityDescriptor) Object.defineProperty(document, 'visibilityState', visibilityDescriptor); else delete (document as unknown as Record<string, unknown>).visibilityState;
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function snapshot(): Gathering {
  return parseGathering({ id: 'synthetic-television-channel-engine', title: '本地电视真实换台', scene_type: 'home', revision: 1, closed: false, is_manager: true, me: 'owner', members: [{ id: 'owner', name: '合成主人', manager: true }],
    companions: [4, 5].map((id, index) => ({ id, owner_id: 'owner', name: '合成观看者' + id, activity: 'observe', area: 'indoor', x: .35 + index * .2, y: .6,
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: id, source: 'procedural_existing_features' } })),
    items: [{ id: 'saved-tree', kind: 'tree', x: .15, y: .22, mine: true, contributor_name: '合成', growth_status: null }, { id: 'saved-bench', kind: 'bench', x: .75, y: .65, mine: true, contributor_name: '合成', growth_status: null }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
type Flags = NonNullable<Parameters<typeof createLivingWorld>[5]>;
function setup(group = snapshot(), flags: Flags = {}) {
  const host = document.createElement('div'), labels = document.createElement('div'); Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } }); document.body.append(host, labels);
  const world = createLivingWorld(host, labels, group, vi.fn(), vi.fn(), { realistic: true, localLeisurePreview: true, localRoomTransitions: true, localReferenceVilla: true, localQuietAudio: true,
    initialLeisure: [{ activity: 'television', actorIds: [4, 5] }], ...flags }); worlds.push(world);
  world.setHouseView('interior'); world.update(group, null, 'indoor'); return { world, host, labels, group, renderer: gpu.instances.at(-1)! };
}
type Fixture = ReturnType<typeof setup>;
const KEYS = ['televisionChannel', 'televisionProgram', 'televisionProgramFrame', 'televisionRemoteOwner', 'televisionRemotePressed'] as const;
function step(f: Fixture, delta = 100) { vi.setSystemTime(Date.now() + delta); expect(f.renderer.loop).toBeTypeOf('function'); f.renderer.loop!(Date.now()); }
function until(f: Fixture, predicate: () => boolean, limit = 500) { for (let frame = 0; frame < limit; frame++) { step(f); if (predicate()) return; } throw new Error('TELEVISION_ENGINE_STALL ' + JSON.stringify({ data: { ...f.host.dataset }, leisure: f.world.getLocalLeisure() })); }
function actor(f: Fixture, id: number) { const root = f.renderer.scene!.children.find(object => object.userData.characterId === id); expect(root).toBeDefined(); return root!; }
function ancestorActor(object: THREE.Object3D) { for (let node: THREE.Object3D | null = object; node; node = node.parent) if (typeof node.userData.characterId === 'number') return node.userData.characterId as number; return null; }
function remote(f: Fixture) { return f.renderer.scene!.getObjectByName('home-television-remote'); }
function plane(f: Fixture) { return f.renderer.scene!.getObjectByName('home-television-active-program') as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> | undefined; }
function data(f: Fixture) { return Object.fromEntries(KEYS.map(key => [key, f.host.dataset[key]])); }
function displayData(f: Fixture) { return Object.fromEntries(KEYS.slice(0, 3).map(key => [key, f.host.dataset[key]])); }
function channel(f: Fixture) { const value = Number(f.host.dataset.televisionChannel); expect([0, 1, 2]).toContain(value); return value; }
function exact(object: THREE.Object3D) { return { parent: object.parent, position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray(), matrix: object.matrix.toArray(), auto: object.matrixAutoUpdate }; }
function setHidden(value: boolean) { hidden = value; document.dispatchEvent(new Event('visibilitychange')); }
function frameImage(f: Fixture) {
  const programme = plane(f); expect(programme).toBeDefined(); const texture = programme!.material.map; expect(texture).toBeInstanceOf(THREE.CanvasTexture);
  const canvas = texture!.image as HTMLCanvasElement; expect([canvas.width, canvas.height]).toEqual([408, 222]); const drawing = paints.get(canvas); expect(drawing).toBeDefined(); expect(drawing!.commands.length).toBeGreaterThan(0);
  return { plane: programme!, texture: texture!, drawing: JSON.stringify(drawing!.commands), frame: programme!.userData.frame };
}
function assertProgramme(f: Fixture) {
  const image = frameImage(f), id = channel(f), current = remote(f), holder = current?.userData.heldByActorId ?? null;
  expect(f.host.dataset.televisionProgram).toBe(HOME_TELEVISION_CHANNEL_NAMES[id]); expect(image.plane.userData.channel).toBe(id); expect(image.plane.userData.program).toBe(HOME_TELEVISION_CHANNEL_NAMES[id]); expect(image.plane.userData.frame).toBe(Number(f.host.dataset.televisionProgramFrame));
  expect(Number.isInteger(image.frame)).toBe(true); expect(image.frame).toBeGreaterThanOrEqual(0); expect(image.frame).toBeLessThan(192); expect(image.plane.userData.homeLocalTelevisionProgram).toBe(true);
  expect(image.plane.geometry.index!.count).toBe(6); expect(image.plane.geometry.getAttribute('position').count).toBe(4); expect(f.host.dataset.televisionRemoteOwner).toBe(String(holder ?? 'none')); expect(f.host.dataset.televisionRemotePressed).toBe(String(current?.userData.buttonPressed === true));
  if (holder !== null) { const root = actor(f, holder), seat = f.world.getLocalLeisure().assignments.find(row => row.actorId === holder)!; expect(root.visible).toBe(true); expect(root.userData.roomRestSeat?.seatId).toBe(seat.seatId); expect(root.userData.homeJourney?.active).not.toBe(true); expect(current!.parent).toBe(root.getObjectByName('left-arm')); }
  return image;
}
function resources(objects: THREE.Object3D[], textures: Iterable<THREE.Texture> = []) {
  const values = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>(textures);
  for (const object of objects) object.traverse(child => { if (!(child instanceof THREE.Mesh)) return; values.add(child.geometry); for (const material of Array.isArray(child.material) ? child.material : [child.material]) { values.add(material); const map = (material as THREE.MeshStandardMaterial).map; if (map) values.add(map); } }); return values;
}

describe('actual seated remote button and local television programme engine', () => {
  it.each([
    { gate: 'local preview disabled', flags: { localLeisurePreview: false }, patch: {} },
    { gate: 'realistic disabled', flags: { realistic: false }, patch: {} },
    { gate: 'production id', flags: {}, patch: { id: 'production-television' } },
    { gate: 'forest scene', flags: {}, patch: { scene_type: 'forest' } },
  ] as Array<{ gate: string; flags: Flags; patch: Partial<Gathering> }>)('keeps $gate closed and preserves the legacy television without remote channels or programme allocations', ({ flags, patch }) => {
    const group = { ...snapshot(), ...patch }, f = setup(group, flags); f.world.setMotion(true); for (let frame = 0; frame < 40; frame++) step(f);
    expect(f.world.startLocalLeisure('television', 4)).toBe(false); expect(plane(f)).toBeUndefined(); expect(remote(f)).toBeUndefined(); for (const key of KEYS) expect(f.host.dataset[key]).toBeUndefined(); f.world.dispose();
  });

  it('reads the same real remote while held by a left hand, switches once per press through all three real textures and retains the right-hand snack', () => {
    const group = snapshot(), original = JSON.stringify(group), f = setup(group); f.world.setMotion(true); const first = assertProgramme(f), maps = new Set<THREE.Texture>([first.texture]), names = new Set<string>(), matrices: number[][] = [];
    const screen = f.renderer.scene!.getObjectByName('home-television-screen') as THREE.Mesh, screenState = exact(screen), screenMaterial = screen.material; let previous = channel(f), pressed = false, pressChanges = 0, highFrames = 0, sawSnack = false;
    for (let frame = 0; frame < 420 && pressChanges < 3; frame++) {
      step(f); const image = assertProgramme(f), value = remote(f)!; maps.add(image.texture); names.add(String(image.plane.userData.program)); const next = channel(f), down = value.userData.buttonPressed === true;
      if (down && !pressed) { expect(next).toBe((previous + 1) % 3); pressChanges++; matrices.push(value.matrixWorld.toArray()); } else expect(next).toBe(previous);
      if (down) highFrames++; const owner = value.userData.heldByActorId as number | undefined;
      if (owner !== undefined) { const row = f.world.getLocalLeisure().assignments.find(entry => entry.actorId === owner)!, index = row.seatId.split('-').at(-1), seed = f.renderer.scene!.getObjectByName('home-television-seed-' + index); if (seed && ancestorActor(seed) === owner) { sawSnack = true; expect(seed.parent).toBe(actor(f, owner).getObjectByName('right-arm')); expect(value.parent).not.toBe(seed.parent); } }
      previous = next; pressed = down;
    }
    expect(pressChanges).toBe(3); expect(highFrames).toBeGreaterThanOrEqual(7); expect(channel(f)).toBe(0); expect(maps.size).toBe(3); expect(names.size).toBe(3); expect(plane(f)).toBe(first.plane); expect(frameImage(f).texture).toBe(first.texture); expect(matrices).toHaveLength(3); expect(sawSnack).toBe(true); expect(exact(screen)).toEqual(screenState); expect(screen.material).toBe(screenMaterial); expect(JSON.stringify(group)).toBe(original);
  }, 30_000);

  it('freezes actual programme drawing and remote matrices on pause and hiding, consumes no old held press on resume and ignores clock jumps', () => {
    const f = setup(); f.world.setMotion(true); until(f, () => remote(f)?.userData.buttonPressed === true); step(f); const current = remote(f)!, before = assertProgramme(f), frozen = data(f), frozenDisplay = displayData(f), prop = exact(current), matrix = current.matrixWorld.toArray();
    f.world.setMotion(false); vi.setSystemTime(Date.now() + 60_000); f.world.update(f.group, null, 'indoor'); expect(data(f)).toEqual(frozen); expect(frameImage(f).drawing).toBe(before.drawing); expect(exact(current)).toEqual(prop); expect(current.matrixWorld.toArray()).toEqual(matrix);
    f.world.setMotion(true); expect(data(f)).toEqual(frozen); setHidden(true); for (let frame = 0; frame < 5; frame++) { step(f, 1000); expect(displayData(f)).toEqual(frozenDisplay); assertProgramme(f); } expect(frameImage(f).drawing).toBe(before.drawing); setHidden(false); step(f); expect(displayData(f)).toEqual(frozenDisplay); assertProgramme(f);
    const same = channel(f); step(f, 3_600_000); expect(channel(f)).toBe(same); expect(frameImage(f).drawing).toBe(before.drawing); for (let frame = 0; frame < 5; frame++) { step(f); expect(channel(f)).toBe(same); }
    until(f, () => remote(f)?.userData.buttonPressed !== true); until(f, () => remote(f)?.userData.buttonPressed === true); expect(channel(f)).toBe((same + 1) % 3);
  }, 25_000);

  it('parks on power off and leaving, baselines a new actual seated holder without a false edge and only reacts to a future press', () => {
    const f = setup(); f.world.setMotion(true); until(f, () => remote(f)?.userData.buttonPressed === true); const before = channel(f), physical = remote(f)!, oldOwner = physical.userData.heldByActorId as number; expect(f.world.stopLocalLeisure(oldOwner)).toBe(true);
    expect(remote(f)).toBe(physical); expect(physical.userData.heldByActorId).not.toBe(oldOwner); expect(physical.userData.buttonPressed).toBe(true); expect(channel(f)).toBe(before); step(f); expect(channel(f)).toBe(before);
    expect(f.world.toggleLocalLeisure('television')).toBe(true); expect(f.world.getLocalLeisure().television.powered).toBe(false); expect(physical.userData.heldByActorId).toBeUndefined(); expect(physical.userData.buttonPressed).toBe(false); expect(ancestorActor(physical)).toBeNull(); expect(physical.parent?.name).toBe('room-side-table'); expect(plane(f)?.visible ?? false).toBe(false); step(f); expect(channel(f)).toBe(before);
    expect(f.world.toggleLocalLeisure('television')).toBe(true); expect(physical.userData.buttonPressed).toBe(true); expect(channel(f)).toBe(before); step(f); expect(channel(f)).toBe(before);
    until(f, () => physical.userData.buttonPressed !== true); until(f, () => physical.userData.buttonPressed === true); expect(channel(f)).toBe((before + 1) % 3);
    const last = channel(f); expect(f.world.stopLocalLeisure()).toBe(true); expect(physical.userData.heldByActorId).toBeUndefined(); expect(physical.userData.buttonPressed).toBe(false); expect(ancestorActor(physical)).toBeNull(); for (let frame = 0; frame < 40; frame++) { step(f); expect(channel(f)).toBe(last); expect(f.host.dataset.televisionRemoteOwner).toBe('none'); } expect(frameImage(f).plane.visible).toBe(true);
  }, 25_000);

  it('releases owned plane, three programme textures and the held prop once before environment replacement, restores the old programme and clears datasets on scope exit and disposal', () => {
    const group = snapshot(), original = JSON.stringify(group), f = setup(group); f.world.setMotion(true); const maps = new Set<THREE.Texture>([assertProgramme(f).texture]); until(f, () => { maps.add(assertProgramme(f).texture); return maps.size === 3; }, 250);
    const ownedPlane = plane(f)!, ownedRemote = remote(f)!, oldScreen = f.renderer.scene!.getObjectByName('home-television-screen')!, oldProgramme = f.renderer.scene!.getObjectByName('home-television-program')!, screenState = exact(oldScreen), allResources = resources([ownedPlane, ownedRemote], maps), disposals = [...allResources].map(value => vi.spyOn(value, 'dispose'));
    expect(oldProgramme.visible).toBe(false); expect(maps.size).toBe(3); const winter = { ...group, revision: 2, season: 'winter' as const }; f.world.update(winter, null, 'indoor');
    expect(ownedPlane.parent).toBeNull(); expect(ownedRemote.parent).toBeNull(); expect(oldProgramme.visible).toBe(true); expect(exact(oldScreen)).toEqual(screenState); disposals.forEach(spy => expect(spy).toHaveBeenCalledTimes(1)); expect(channel(f)).toBe(0); expect(plane(f)).not.toBe(ownedPlane); expect(remote(f)).not.toBe(ownedRemote); step(f); expect(channel(f)).toBe(0);
    const replacement = plane(f)!, replacementGeometry = vi.spyOn(replacement.geometry, 'dispose'), replacementMaterial = vi.spyOn(replacement.material, 'dispose'), replacementMap = vi.spyOn(replacement.material.map!, 'dispose'), removedRemote = remote(f)!, removedOwner = removedRemote.userData.heldByActorId as number, removalDisposals = [...resources([removedRemote])].map(value => vi.spyOn(value, 'dispose')), removed = { ...winter, revision: 3, companions: winter.companions.filter(row => row.id !== removedOwner) };
    f.world.update(removed, null, 'indoor'); expect(removedRemote.parent).toBeNull(); expect(remote(f)).not.toBe(removedRemote); expect(channel(f)).toBe(0); removalDisposals.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
    const forest = { ...removed, id: group.id + '-forest', scene_type: 'forest', revision: 4 };
    f.world.update(forest, null, 'overview'); expect(plane(f)).toBeUndefined(); expect(remote(f)).toBeUndefined(); for (const key of KEYS) expect(f.host.dataset[key]).toBeUndefined(); expect(replacement.parent).toBeNull(); expect(replacementGeometry).toHaveBeenCalledTimes(1); expect(replacementMaterial).toHaveBeenCalledTimes(1); expect(replacementMap).toHaveBeenCalledTimes(1);
    const stale = f.renderer.loop; f.world.dispose(); f.world.dispose(); stale?.(Date.now() + 100); for (const key of KEYS) expect(f.host.dataset[key]).toBeUndefined(); disposals.forEach(spy => expect(spy).toHaveBeenCalledTimes(1)); removalDisposals.forEach(spy => expect(spy).toHaveBeenCalledTimes(1)); expect(replacementGeometry).toHaveBeenCalledTimes(1); expect(replacementMaterial).toHaveBeenCalledTimes(1); expect(replacementMap).toHaveBeenCalledTimes(1); expect(JSON.stringify(group)).toBe(original);
  }, 30_000);
});
