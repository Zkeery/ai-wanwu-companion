import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { applyHomeWorldArchitectureView, buildHomeWorldEnvironment } from '@/lib/living-home-world-meshes';
import { disposeLivingObject } from '@/lib/living-world-engine';

const roots: THREE.Group[] = [];
function world() {
  const root = buildHomeWorldEnvironment('summer', { resting: 10, sleeping: 10 });
  roots.push(root); root.updateMatrixWorld(true); return root;
}
function role(root: THREE.Object3D, name: string) {
  const result: THREE.Object3D[] = [];
  root.traverse(object => { if (object.userData.architectureRole === name) result.push(object); });
  return result;
}
function hits(root: THREE.Object3D | THREE.Object3D[], from: [number, number, number], to: [number, number, number]) {
  const origin = new THREE.Vector3(...from), delta = new THREE.Vector3(...to).sub(origin);
  return new THREE.Raycaster(origin, delta.clone().normalize(), 0, delta.length()).intersectObjects(Array.isArray(root) ? root : [root], true);
}
function signature(root: THREE.Object3D) {
  const values: unknown[] = [];
  root.traverse(object => values.push([object.uuid, object.position.toArray(), object.quaternion.toArray(), object.scale.toArray(),
    object instanceof THREE.Mesh ? object.geometry.uuid : null]));
  return JSON.stringify(values);
}
afterEach(() => { roots.splice(0).forEach(disposeLivingObject); });

describe('one coherent house with physical entrances and a reversible cutaway', () => {
  it('has one enclosing shell and a real living-room/bedroom partition instead of isolated room frames', () => {
    const root = world(), shell = root.getObjectByName('home-world-architecture')!;
    expect(shell).toBeDefined();
    expect(root.getObjectByName('home-bedroom-doorway')).toBeUndefined();
    expect(root.getObjectByName('home-indoor-doorway')).toBeUndefined();
    const partition = role(shell, 'interior-partition');
    expect(partition.length).toBeGreaterThan(0);
    for (const z of [-7.5, -5.5, -3.2, -.35]) {
      const intersections = hits(partition, [-.7, 1.2, z], [.7, 1.2, z]);
      expect(intersections.length, `missing physical room partition at z=${z}`).toBeGreaterThan(0);
      expect(Math.abs(intersections[0].point.x)).toBeLessThan(.25);
    }
    // The bedroom facade is wall below the window, not a second exterior door.
    expect(hits(shell, [5.65, .4, .7], [5.65, .4, -.7]).length).toBeGreaterThan(0);
    for (const x of [-10.7, 0, 10.7]) expect(hits(shell, [x, 1.2, -9], [x, 1.2, -7.5]).length).toBeGreaterThan(0);
    for (const side of [-1, 1]) expect(hits(shell, [side * 12, 1.2, -4], [side * 10.7, 1.2, -4]).length).toBeGreaterThan(0);
  });

  it.each([
    ['home-main-entry-door', ['outdoor', 'indoor'], [-2.4, 1.2, .7], [-2.4, 1.2, -.7]],
    ['home-room-connection-door', ['indoor', 'bedroom'], [-.7, 1.2, -1.525], [.7, 1.2, -1.525]],
  ] as const)('builds a real open %s with a frame, solid hinged leaf, handle and traversable opening', (name, areas, from, to) => {
    const root = world(), shell = root.getObjectByName('home-world-architecture')!, door = root.getObjectByName(name)!;
    expect(door).toBeDefined(); expect(door.userData.connects).toEqual(areas);
    const frame = door.getObjectByName(name + '-frame')!, leaf = door.getObjectByName(name + '-leaf')!, handle = door.getObjectByName(name + '-handle')!;
    const panel = door.getObjectByName(name + '-panel')!;
    expect(frame).toBeDefined(); expect(leaf).toBeDefined(); expect(handle).toBeDefined(); expect(panel).toBeInstanceOf(THREE.Mesh);
    expect(Math.abs(leaf.rotation.y)).toBeGreaterThan(1); expect(Math.abs(leaf.rotation.y)).toBeLessThan(Math.PI / 2);
    const panelSize = new THREE.Box3().setFromObject(panel).getSize(new THREE.Vector3());
    expect(panelSize.y).toBeGreaterThan(1.9); expect(panelSize.x).toBeGreaterThan(.06); expect(panelSize.z).toBeGreaterThan(.06);
    expect(new THREE.Box3().setFromObject(handle).getSize(new THREE.Vector3()).length()).toBeGreaterThan(.05);
    // Check actual triangles rather than accepting an opening metadata flag.
    expect(hits(shell, [...from], [...to]), 'door center is blocked by wall, frame or its open leaf').toHaveLength(0);
    expect(hits(frame, [...from], [...to])).toHaveLength(0);
    const opening = door.userData.opening;
    expect(opening.top - opening.bottom).toBeCloseTo(2.35);
    expect(opening.max - opening.min).toBeCloseTo(name === 'home-main-entry-door' ? 1.8 : 1.35);
    const first = new THREE.Vector3(...from), last = new THREE.Vector3(...to), shift = (opening.max - opening.min) * .7;
    for (const direction of [-1, 1]) {
      const a = first.clone(), b = last.clone();
      if (name === 'home-main-entry-door') { a.x += shift * direction; b.x += shift * direction; }
      else { a.z += shift * direction; b.z += shift * direction; }
      expect(hits(shell, a.toArray() as [number, number, number], b.toArray() as [number, number, number]).length).toBeGreaterThan(0);
    }
  });

  it('covers both rooms with one complete volume roof that can be viewed from any exterior angle', () => {
    const root = world(), shell = root.getObjectByName('home-world-architecture')!, roof = role(shell, 'roof');
    expect(roof.length).toBeGreaterThan(0);
    applyHomeWorldArchitectureView(root, 'exterior', { x: 18, y: 11, z: 20 });
    for (const x of [-10, -5.65, 0, 5.65, 10]) for (const z of [-7.5, -4.2, -1]) {
      const intersections = hits(roof, [x, 12, z], [x, 2.8, z]);
      expect(intersections.length, `roof hole above ${x},${z}`).toBeGreaterThan(0);
      expect(intersections[0].point.y).toBeGreaterThan(3.2);
    }
    for (const object of roof) expect(object.visible).toBe(true);
  });

  it('only cuts the roof and makes camera-facing upper walls visibly translucent while every room boundary remains present', () => {
    const root = world(), shell = root.getObjectByName('home-world-architecture')!, before = signature(root);
    const roof = role(shell, 'roof'), upper = role(shell, 'exterior-wall-upper'), low = role(shell, 'exterior-wall-low'), partition = role(shell, 'interior-partition'), doors = role(shell, 'door');
    for (const values of [roof, upper, low, partition, doors]) expect(values.length).toBeGreaterThan(0);
    applyHomeWorldArchitectureView(root, 'interior', { x: 18, y: 11, z: 20 });
    for (const object of roof) expect(object.visible).toBe(false);
    const ghostFront = upper.filter(object => object.userData.homeWallGhost).map(object => object.uuid);
    expect(ghostFront.length).toBeGreaterThan(0); expect(upper.some(object => !object.userData.homeWallGhost)).toBe(true);
    for (const wall of upper) {
      expect(wall.visible).toBe(true);
      wall.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          if (wall.userData.homeWallGhost) { expect(material.transparent).toBe(true); expect(material.opacity).toBeGreaterThan(0); expect(material.opacity).toBeLessThan(1); }
          else { expect(material.transparent).toBe(false); expect(material.opacity).toBe(1); }
        }
      });
    }
    for (const object of [...low, ...partition, ...doors]) expect(object.visible).toBe(true);
    applyHomeWorldArchitectureView(root, 'interior', { x: -18, y: 11, z: -20 });
    expect(upper.filter(object => object.userData.homeWallGhost).map(object => object.uuid)).not.toEqual(ghostFront);
    applyHomeWorldArchitectureView(root, 'exterior', { x: -18, y: 11, z: -20 });
    for (const object of [...roof, ...upper, ...low, ...partition, ...doors]) expect(object.visible).toBe(true);
    for (const wall of upper) expect(wall.userData.homeWallGhost).toBe(false);
    expect(root.userData.architectureMode).toBe('exterior'); expect(signature(root)).toBe(before);
  });
});
