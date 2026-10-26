import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAvatar } from '@/lib/living-meshes';
import { buildHomeWorldEnvironment } from '@/lib/living-home-world-meshes';
import { collectHomeLeisureSeats } from '@/lib/living-home-leisure-scene';
import { createHomeTelevisionRemote } from '@/lib/living-home-television-remote';
import { disposeLivingObject } from '@/lib/living-world-engine';
import { parseGathering } from '@/lib/gatherings';
import type { HomeLeisureSnapshot } from '@/lib/living-home-leisure';

const NAME = 'home-television-remote';
const scenes: THREE.Scene[] = [], effects: Array<ReturnType<typeof createHomeTelevisionRemote>> = [];
const canvas = { fillRect: vi.fn(), strokeRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(), lineTo: vi.fn(), moveTo: vi.fn() };
beforeEach(() => {
  Object.values(canvas).forEach(mock => { if (vi.isMockFunction(mock)) mock.mockClear(); });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => canvas as unknown as CanvasRenderingContext2D);
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('television remote must stay local'); }));
});
afterEach(() => {
  effects.splice(0).forEach(effect => effect.dispose()); scenes.splice(0).forEach(scene => disposeLivingObject(scene));
  expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function fixture() {
  const scene = new THREE.Scene(), world = buildHomeWorldEnvironment('summer', { resting: 3, sleeping: 1 }, { realistic: true }); scene.add(world); scenes.push(scene);
  const gathering = parseGathering({ id: 'synthetic-television-remote', title: '本地遥控器', scene_type: 'home', revision: 1, closed: false, is_manager: true, me: 'owner', members: [{ id: 'owner', name: '合成主人', manager: true }],
    companions: [7, 2, 9].map(id => ({ id, owner_id: 'owner', name: '合成观看者' + id, activity: 'observe', area: 'indoor', x: .5, y: .5 })), items: [], events: [], votes: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
  const seats = collectHomeLeisureSeats(world, null, gathering).filter(seat => seat.station === 'television').sort((a, b) => a.id.localeCompare(b.id)); expect(seats).toHaveLength(3);
  const avatars = new Map([7, 2, 9].map((id, index) => {
    const rig = buildAvatar({ version: 1, kind: 'cup', seed: id, body: '#d9dfd1', accent: '#a6be9c', detail: '#6a6259', source: 'procedural_existing_features' }), seat = seats[index];
    rig.root.userData.characterId = id; rig.root.userData.roomRestSeat = { ...seat }; rig.root.scale.setScalar(.9); rig.root.position.set(seat.x, seat.y - rig.seatHeight * .9, seat.z); rig.root.rotation.y = seat.yaw; scene.add(rig.root); return [id, rig] as const;
  }));
  const snapshot: HomeLeisureSnapshot = { revision: 1, scope: { groupId: gathering.id, ownerId: gathering.me, synthetic: true, optIn: true }, permitted: true,
    assignments: [7, 2, 9].map((actorId, index) => ({ actorId, activity: 'television', seatId: seats[index].id, originalActivity: 'observe', startedAtElapsed: 0 })), television: { powered: true, watchingActorIds: [7, 2, 9] } };
  const effect = createHomeTelevisionRemote(); effects.push(effect); scene.updateMatrixWorld(true);
  return { scene, world, gathering, seats, avatars, snapshot, effect };
}
type Fixture = ReturnType<typeof fixture>;
function update(f: Fixture, elapsed: number, snapshot = f.snapshot, world: THREE.Object3D | null = f.world, avatars = f.avatars) { f.effect.update(world, avatars, snapshot, f.seats, elapsed); f.scene.updateMatrixWorld(true); }
function remote(f: Fixture) { const value = f.scene.getObjectByName(NAME); expect(value).toBeDefined(); return value!; }
function exact(object: THREE.Object3D) { return { parent: object.parent, position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray(), matrix: object.matrix.toArray(), auto: object.matrixAutoUpdate }; }
function countRemotes(scene: THREE.Scene) { let count = 0; scene.traverse(object => { if (object.name === NAME) count++; }); return count; }
function owned(object: THREE.Object3D) {
  const meshes: THREE.Mesh[] = [], geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  object.traverse(child => { if (!(child instanceof THREE.Mesh)) return; meshes.push(child); geometries.add(child.geometry); for (const material of Array.isArray(child.material) ? child.material : [child.material]) { materials.add(material); const map = (material as THREE.MeshStandardMaterial).map; if (map) textures.add(map); } });
  return { meshes, geometries, materials, textures };
}

describe('actual local television remote prop and hand binding', () => {
  it('allocates nothing until an actual visible seated television assignment is powered and available', () => {
    const f = fixture(), holder = f.avatars.get(7)!, seat = holder.root.userData.roomRestSeat;
    expect(countRemotes(f.scene)).toBe(0); update(f, 1, { ...f.snapshot, television: { ...f.snapshot.television, powered: false } }); update(f, 1, { ...f.snapshot, assignments: [] }); update(f, 1, f.snapshot, f.world, new Map());
    delete holder.root.userData.roomRestSeat; for (const rig of f.avatars.values()) delete rig.root.userData.roomRestSeat; update(f, 1); expect(countRemotes(f.scene)).toBe(0);
    holder.root.userData.roomRestSeat = seat; holder.root.userData.homeJourney = { active: true }; update(f, 1); delete holder.root.userData.homeJourney; holder.root.visible = false; update(f, 1); holder.root.visible = true; update(f, NaN); update(f, 1, f.snapshot, null);
    expect(countRemotes(f.scene)).toBe(0); expect(canvas.fillRect).not.toHaveBeenCalled();
  });

  it('binds the real visible body and button surface to the left hand and cancels actual avatar world scale', () => {
    const f = fixture(), holder = f.avatars.get(7)!; holder.root.scale.setScalar(1.7); holder.root.rotation.y += .63; const original = JSON.stringify(f.snapshot); update(f, 1.725); const value = remote(f), resources = owned(value);
    expect(value.parent).toBe(holder.leftArm); expect(value.position.toArray()).toEqual([-.075, -.235, .075]); expect(value.visible).toBe(true); expect(holder.root.visible).toBe(true); expect(resources.meshes.every(mesh => mesh.visible && mesh.geometry.getAttribute('position').count > 0)).toBe(true);
    const scale = holder.leftArm.getWorldScale(new THREE.Vector3()); expect(value.scale.distanceTo(new THREE.Vector3(1 / scale.x, 1 / scale.y, 1 / scale.z))).toBeLessThan(1e-10); expect(value.getWorldScale(new THREE.Vector3()).distanceTo(new THREE.Vector3(1, 1, 1))).toBeLessThan(1e-8);
    expect(value.getWorldPosition(new THREE.Vector3()).distanceTo(holder.leftArm.localToWorld(new THREE.Vector3(-.075, -.235, .075)))).toBeLessThan(1e-9);
    const hand = holder.leftArm.children.find(object => object instanceof THREE.Mesh && object.position.distanceTo(new THREE.Vector3(-.075, -.265, .045)) < 1e-8) as THREE.Mesh; expect(hand).toBeDefined();
    const body = value.getObjectByName('home-television-remote-body')!, handBox = new THREE.Box3().setFromObject(hand, true), bodyBox = new THREE.Box3().setFromObject(body, true), overlap = handBox.clone().intersect(bodyBox).getSize(new THREE.Vector3());
    expect(handBox.clone().expandByScalar(.002).intersectsBox(bodyBox), 'actual remote shell must contact the scaled and rotated palm instead of floating').toBe(true); expect(Math.min(...overlap.toArray()), 'actual hand and shell need positive overlap on every world axis').toBeGreaterThan(.001);
    hand.geometry.computeBoundingBox(); const shellCenterInArm = holder.leftArm.worldToLocal(bodyBox.getCenter(new THREE.Vector3())), palmTop = hand.position.y + hand.geometry.boundingBox!.max.y * hand.scale.y;
    expect(shellCenterInArm.y).toBeGreaterThanOrEqual(hand.position.y - .002); expect(shellCenterInArm.y).toBeLessThanOrEqual(palmTop + .002);
    const controls = value.getObjectByName('home-television-remote-controls')!, controlsInArm = holder.leftArm.worldToLocal(controls.getWorldPosition(new THREE.Vector3())); expect(controlsInArm.y, 'actual buttons must remain above the real palm center').toBeGreaterThan(hand.position.y);
    expect(value.userData.buttonPressed).toBe(true); expect(canvas.arc).toHaveBeenCalled(); expect(canvas.fillRect.mock.calls.length).toBeGreaterThanOrEqual(13); expect(JSON.stringify(f.snapshot)).toBe(original);
  });

  it('aims and presses with changing actual world matrices, leaves the right snack arm untouched and freezes at repeated elapsed', () => {
    const f = fixture(), holder = f.avatars.get(7)!; holder.rightArm.rotation.set(-.9, .25, .33); holder.rightArm.position.z += .02; f.scene.updateMatrixWorld(true); const right = exact(holder.rightArm);
    update(f, .1); const value = remote(f), early = value.matrixWorld.toArray(), earlyArm = holder.leftArm.quaternion.toArray(); update(f, 1.725);
    expect(value.matrixWorld.toArray()).not.toEqual(early); expect(holder.leftArm.quaternion.toArray()).not.toEqual(earlyArm); expect(exact(holder.rightArm)).toEqual(right);
    const frozen = { prop: exact(value), world: value.matrixWorld.toArray(), left: exact(holder.leftArm), right: exact(holder.rightArm), pressed: value.userData.buttonPressed };
    for (let i = 0; i < 20; i++) update(f, 1.725); expect({ prop: exact(value), world: value.matrixWorld.toArray(), left: exact(holder.leftArm), right: exact(holder.rightArm), pressed: value.userData.buttonPressed }).toEqual(frozen); expect(countRemotes(f.scene)).toBe(1);
  });

  it('returns to the actual side table after 13.5 seconds and restores the exact original parked transform every cycle', () => {
    const f = fixture(); update(f, 14); const value = remote(f), parked = exact(value); expect(value.parent).toBe(f.world.getObjectByName('room-side-table')); expect(value.position.toArray()).toEqual([-2.92, .713, -1.94]); expect(value.visible).toBe(true);
    update(f, 18.5); expect(value.parent).toBe(f.avatars.get(7)!.leftArm); f.effect.restore(); f.scene.updateMatrixWorld(true); expect(exact(value)).toEqual(parked);
    update(f, 20); update(f, 31.6); expect(exact(value)).toEqual(parked); expect(countRemotes(f.scene)).toBe(1);
  });

  it.each(['power-off', 'no-assignment', 'missing-avatar', 'world-null', 'restore'] as const)('returns and keeps the existing prop visible on %s', action => {
    const f = fixture(); update(f, 14); const value = remote(f), parked = exact(value); update(f, 18.5); expect(value.parent).toBe(f.avatars.get(7)!.leftArm);
    if (action === 'power-off') update(f, 19, { ...f.snapshot, television: { ...f.snapshot.television, powered: false } });
    else if (action === 'no-assignment') update(f, 19, { ...f.snapshot, assignments: [] });
    else if (action === 'missing-avatar') update(f, 19, f.snapshot, f.world, new Map());
    else if (action === 'world-null') update(f, 19, f.snapshot, null);
    else { f.effect.restore(); f.scene.updateMatrixWorld(true); }
    expect(exact(value)).toEqual(parked); expect(value.visible).toBe(true); expect(countRemotes(f.scene)).toBe(1); expect([...f.avatars.values()].every(rig => rig.root.visible)).toBe(true);
  });

  it('chooses a stable seat owner and transfers the single same physical remote when that owner leaves', () => {
    const f = fixture(), reversed = { ...f.snapshot, assignments: [...f.snapshot.assignments].reverse() }; update(f, 1, reversed); const value = remote(f); expect(value.parent).toBe(f.avatars.get(7)!.leftArm);
    const next = { ...f.snapshot, assignments: f.snapshot.assignments.filter(row => row.actorId !== 7) }; update(f, 1.1, next); expect(remote(f)).toBe(value); expect(value.parent).toBe(f.avatars.get(2)!.leftArm); expect(value.userData.heldByActorId).toBe(2); expect(countRemotes(f.scene)).toBe(1);
    const sameSeat = { ...f.snapshot, assignments: [{ ...f.snapshot.assignments[0], actorId: 9 }, { ...f.snapshot.assignments[0], actorId: 2 }] }; update(f, 1.2, sameSeat); expect(value.parent).toBe(f.avatars.get(2)!.leftArm); expect(countRemotes(f.scene)).toBe(1);
  });

  it('releases the old world owned resources once before rebuilding one remote for a replacement world', () => {
    const f = fixture(); update(f, 1); const old = remote(f), resources = owned(old), disposals = [...resources.geometries, ...resources.materials, ...resources.textures].map(resource => vi.spyOn(resource, 'dispose'));
    const replacement = buildHomeWorldEnvironment('winter', { resting: 3, sleeping: 1 }, { realistic: true }); f.scene.add(replacement); update(f, 1.1, f.snapshot, replacement); expect(old.parent).toBeNull(); expect(remote(f)).not.toBe(old); expect(countRemotes(f.scene)).toBe(1); disposals.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
  });

  it('keeps the actual body within 75 by 24 by 205mm and 14 triangles, and disposes its two geometries, two materials and local texture once', () => {
    const f = fixture(); update(f, 14); const value = remote(f), parked = exact(value), resources = owned(value), body = value.getObjectByName('home-television-remote-body') as THREE.Mesh;
    expect(resources.meshes).toHaveLength(2); expect(resources.geometries.size).toBe(2); expect(resources.materials.size).toBe(2); expect(resources.textures.size).toBe(1); expect([...resources.textures][0]).toBeInstanceOf(THREE.CanvasTexture);
    body.geometry.computeBoundingBox(); expect(body.geometry.boundingBox!.getSize(new THREE.Vector3()).distanceTo(new THREE.Vector3(.075, .024, .205))).toBeLessThan(1e-7);
    expect(resources.meshes.reduce((total, mesh) => total + (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3, 0)).toBe(14);
    const disposals = [...resources.geometries, ...resources.materials, ...resources.textures].map(resource => vi.spyOn(resource, 'dispose')), parents: Array<THREE.Object3D | null> = []; value.addEventListener('added', () => parents.push(value.parent)); update(f, 18.5); f.effect.dispose(); f.effect.dispose();
    expect(parents).toContain(parked.parent); expect(value.parent).toBeNull(); expect({ ...exact(value), parent: parked.parent }).toEqual(parked); expect(countRemotes(f.scene)).toBe(0); disposals.forEach(spy => expect(spy).toHaveBeenCalledTimes(1)); update(f, 20); expect(countRemotes(f.scene)).toBe(0);
  });

  it('keeps a visible two-mesh fallback with no Canvas2D and parks beside the real seat if the side table is absent', () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null); const f = fixture(), table = f.world.getObjectByName('room-side-table')!; table.removeFromParent(); f.world.add(table); table.name = 'test-side-table-unavailable'; update(f, 1); const value = remote(f), resources = owned(value);
    expect(value.parent).toBe(f.avatars.get(7)!.leftArm); expect(resources.meshes).toHaveLength(2); expect(resources.textures.size).toBe(0); expect(resources.meshes.every(mesh => mesh.visible)).toBe(true);
    f.effect.restore(); f.scene.updateMatrixWorld(true); expect(value.parent).toBe(f.world); const seat = f.seats[0]; expect(value.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(seat.x + .4, seat.y, seat.z))).toBeLessThan(1e-9); expect(value.visible).toBe(true);
  });

  it('resets owned resources once before the old environment is disposed and remains usable for a new world', () => {
    const f = fixture(); update(f, 1); const old = remote(f), resources = owned(old), disposals = [...resources.geometries, ...resources.materials, ...resources.textures].map(resource => vi.spyOn(resource, 'dispose'));
    f.effect.reset(); f.effect.reset(); expect(old.parent).toBeNull(); expect(countRemotes(f.scene)).toBe(0); disposals.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
    f.world.removeFromParent(); disposeLivingObject(f.world); disposals.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
    const replacement = buildHomeWorldEnvironment('winter', { resting: 3, sleeping: 1 }, { realistic: true }); f.scene.add(replacement); update(f, 1.5, f.snapshot, replacement); expect(remote(f)).not.toBe(old); expect(countRemotes(f.scene)).toBe(1); disposals.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
  });
});
