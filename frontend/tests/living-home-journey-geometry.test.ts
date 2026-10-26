import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAvatar } from '../lib/living-meshes';
import { buildHomeWorldEnvironment, setHomeWorldDoorOpenness } from '../lib/living-home-world-meshes';
import { collectHomeNavigationObstacles, homeNavigationBounds } from '../lib/living-home-navigation';
import { collectHomeJourneyObstacles, homeJourneyPortalClearance, setHomeJourneyDoorOpenness } from '../lib/living-home-journey-geometry';
import { createLivingNavigation } from '../lib/living-navigation';
import type { Avatar3D } from '../lib/shared-living-3d';

const roots: THREE.Object3D[] = [];
beforeEach(() => {
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('journey geometry stays offline'); }));
});
afterEach(() => {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  roots.splice(0).forEach(root => root.traverse(object => { if (object instanceof THREE.Mesh) { geometries.add(object.geometry); (Array.isArray(object.material) ? object.material : [object.material]).forEach(m => materials.add(m)); } }));
  geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
  expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
const bounds = { minX: -11.3, maxX: 11.3, minZ: -8.3, maxZ: 8.22 };
const doors = ['home-main-entry-door', 'home-room-connection-door', 'home-courtyard-gate'] as const;
function environment() { const world = buildHomeWorldEnvironment('summer', { resting: 1, sleeping: 1 }, { realistic: true }); roots.push(world); return world; }
function avatar(kind: Avatar3D['kind']) { const value = buildAvatar({ version: 1, kind, body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features' }); roots.push(value.root); return value; }
function originalPose(root: THREE.Object3D) { root.updateWorldMatrix(true, true); const pose: unknown[] = []; root.traverse(object => pose.push({ id: object.id, position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray(), matrix: object.matrix.toArray(), auto: object.matrixAutoUpdate })); return pose; }

describe('actual slab and portal geometry for opt-in room transitions', () => {
  it('preserves merged visual geometry while splitting the real doorway solids', () => {
    const world = environment(); doors.forEach(id => setHomeJourneyDoorOpenness(world, id, 1));
    const mesh = world.getObjectByName('home-exterior-front-low-wall-body') as THREE.Mesh;
    const positions = Array.from(mesh.geometry.getAttribute('position').array), indices = Array.from(mesh.geometry.index!.array);
    expect(mesh.userData.homeJourneySlabs.length).toBeGreaterThan(1);
    const obstacles = collectHomeJourneyObstacles(world, null);
    expect(obstacles.filter(o => o.source.startsWith(mesh.name + ':slab-')).length).toBe(mesh.userData.homeJourneySlabs.length);
    const graph = createLivingNavigation({ bounds, blocked: obstacles, clearance: .2 });
    expect(graph.isSegmentClear({ x: -2.4, z: -1.4 }, { x: -2.4, z: 1.8 })).toBe(true);
    const old = createLivingNavigation({ bounds, blocked: collectHomeNavigationObstacles(world, null), clearance: .2 });
    expect(old.isSegmentClear({ x: -2.4, z: -1.4 }, { x: -2.4, z: 1.8 })).toBe(false);
    expect(Array.from(mesh.geometry.getAttribute('position').array)).toEqual(positions);
    expect(Array.from(mesh.geometry.index!.array)).toEqual(indices);
  });
  it('uses the actual closed leaf, not a permanent door-sweep box or frame-group AABB', () => {
    const world = environment(), left = { x: -1.6, z: -1.48934 }, right = { x: 1.6, z: -1.48934 };
    setHomeJourneyDoorOpenness(world, 'home-room-connection-door', 1);
    const opened = createLivingNavigation({ bounds, blocked: collectHomeJourneyObstacles(world, null), clearance: { x: .35, z: .633 } });
    expect(opened.isSegmentClear(left, right)).toBe(true);
    setHomeJourneyDoorOpenness(world, 'home-room-connection-door', 0);
    const closed = createLivingNavigation({ bounds, blocked: collectHomeJourneyObstacles(world, null), clearance: { x: .35, z: .633 } });
    expect(closed.isSegmentClear(left, right)).toBe(false);
    const door = world.getObjectByName('home-room-connection-door')!, leaf = world.getObjectByName('home-room-connection-door-leaf')!;
    expect(door.userData.homeDoorOpenness).toBe(0); expect(door.userData.homeDoorOpenAngle).toBeCloseTo(-95 * Math.PI / 180); expect(leaf.rotation.y).toBe(0);
    setHomeWorldDoorOpenness(world, 'home-room-connection-door', 1);
    expect(leaf.rotation.y).toBeCloseTo(-68 * Math.PI / 180);
  });
  it.each(['cup', 'bouquet', 'plant', 'fruit', 'garment', 'creature'] as const)('fits the full neutral-arm %s gait through actual 95-degree doors without shrinking the avatar', kind => {
    const world = environment(), person = avatar(kind), scale = person.root.scale.toArray(), ring = new THREE.Mesh(new THREE.RingGeometry(8, 9), new THREE.MeshBasicMaterial());
    ring.name = 'dynamic-avoidance-disk-not-a-body'; person.root.add(ring);
    const original = originalPose(person.root), clearance = homeJourneyPortalClearance(person);
    expect(originalPose(person.root)).toEqual(original); expect(person.root.scale.toArray()).toEqual(scale);
    expect(clearance.x).toBeLessThan(.64); expect(clearance.height).toBeLessThan(2.35);
    doors.forEach(id => setHomeJourneyDoorOpenness(world, id, 1));
    const blocked = collectHomeJourneyObstacles(world, null);
    const entry = createLivingNavigation({ bounds, blocked, clearance: { x: clearance.x, z: clearance.z } });
    expect(entry.isSegmentClear({ x: -2.4, z: 1.8 }, { x: -2.4, z: -1.4 })).toBe(true);
    const room = createLivingNavigation({ bounds, blocked, clearance: { x: clearance.z, z: clearance.x } });
    expect(room.isSegmentClear({ x: -1.6, z: -1.48934 }, { x: 1.6, z: -1.48934 })).toBe(true);
    // Independent real vertex check over intermediate gait phases; no ring participates.
    for (let n = 0; n <= 240; n++) {
      person.leftLeg.rotation.x = Math.sin(n / 240 * Math.PI * 2) * .42;
      person.rightLeg.rotation.x = -person.leftLeg.rotation.x;
      person.root.updateWorldMatrix(true, true);
      const body = new THREE.Box3(); [person.body, person.leftArm, person.rightArm, person.leftLeg, person.rightLeg].forEach(root => body.union(new THREE.Box3().setFromObject(root, true)));
      expect(Math.max(Math.abs(body.min.x), Math.abs(body.max.x))).toBeLessThanOrEqual(clearance.x - .019);
      expect(Math.max(Math.abs(body.min.z), Math.abs(body.max.z))).toBeLessThanOrEqual(clearance.z - .019);
    }
  });
  it('keeps real saved furniture and solid walls blocked even when visually transparent', () => {
    const world = environment(), items = new THREE.Group(), chair = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    roots.push(items); chair.name = 'saved-chair'; chair.userData.homeNavObstacle = true; chair.position.set(2, .5, 3); items.add(chair);
    const transparent = world.getObjectByName('home-exterior-front-low-wall-body') as THREE.Mesh; transparent.visible = false;
    const blocked = collectHomeJourneyObstacles(world, items), graph = createLivingNavigation({ bounds, blocked, clearance: .2 });
    expect(blocked.some(o => o.source === 'saved-chair')).toBe(true);
    expect(blocked.some(o => o.source === 'home-main-entry-stone-surround:slab-3')).toBe(false);
    expect(graph.isSegmentClear({ x: 1, z: 3 }, { x: 3, z: 3 })).toBe(false);
    expect(graph.isSegmentClear({ x: 2, z: -1 }, { x: 2, z: 1 })).toBe(false);
    expect(chair.position.toArray()).toEqual([2, .5, 3]);
  });
  it('retains unknown low solids and gives full-radius room approaches without moving furniture', () => {
    const world = environment(), items = new THREE.Group(), unknownStep = new THREE.Mesh(new THREE.BoxGeometry(.5, .055, .5), new THREE.MeshBasicMaterial()); roots.push(items);
    unknownStep.name = 'unknown-low-solid'; unknownStep.userData.homeNavObstacle = true; unknownStep.position.set(4, .0275, 5); items.add(unknownStep);
    doors.forEach(id => setHomeJourneyDoorOpenness(world, id, 1));
    const blocked = collectHomeJourneyObstacles(world, items);
    expect(blocked.some(o => o.source === 'unknown-low-solid')).toBe(true);
    for (const radius of [.9, 1]) {
      const living = createLivingNavigation({ bounds: homeNavigationBounds('indoor'), blocked, clearance: radius });
      expect(living.planTo({ from: { x: -2.4, z: -1.6 }, to: { x: -5.65, z: -4 }, id: 1 }).blocked).toBeNull();
      expect(living.planTo({ from: { x: -2.4, z: -1.6 }, to: { x: -2.4, z: -1.48934 }, id: 1 }).blocked).toBeNull();
      expect(living.planTo({ from: { x: -2.4, z: -1.6 }, to: { x: -1.6, z: -1.48934 }, id: 1 }).blocked).not.toBeNull();
      const bedroom = createLivingNavigation({ bounds: homeNavigationBounds('bedroom'), blocked, clearance: radius });
      expect(bedroom.planTo({ from: { x: 1.6, z: -1.48934 }, to: { x: 5.65, z: -2.15 }, id: 1 }).blocked).toBeNull();
    }
  });
  it('restores a non-neutral preexisting posture and does not reduce the general navigation disk', () => {
    const person = avatar('cup'); person.body.position.z = -.2; person.body.rotation.x = -.15; person.body.scale.z = 1.008;
    person.leftArm.rotation.set(.3, .2, .1); person.rightLeg.rotation.x = .33; person.leftKnee.rotation.x = .8;
    person.root.userData.navigationClearance = .9;
    const before = originalPose(person.root), clearance = homeJourneyPortalClearance(person);
    expect(clearance.x).toBeGreaterThan(.5); expect(originalPose(person.root)).toEqual(before); expect(person.root.userData.navigationClearance).toBe(.9);
  });
});
