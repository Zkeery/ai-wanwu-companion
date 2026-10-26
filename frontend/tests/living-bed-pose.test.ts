import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAvatar } from '../lib/living-meshes';
import { computeLivingBedPose, setLivingSleepSupport } from '../lib/living-sleep-support';
import type { Avatar3D } from '../lib/shared-living-3d';

const kinds = ['cup', 'bouquet', 'plant', 'fruit', 'garment', 'creature'] as const;
const roots: THREE.Group[] = [];
function avatar(kind: Avatar3D['kind']) {
  const value = buildAvatar({ version: 1, kind, seed: 123, body: '#d9dfd1', accent: '#a6be9c', detail: '#6a6259', source: 'procedural_existing_features' });
  roots.push(value.root); value.root.scale.multiplyScalar(.9); return value;
}
function place(value: ReturnType<typeof buildAvatar>, breath: number) {
  const pose = computeLivingBedPose(value.sleepSupport, value.root.scale, breath)!;
  setLivingSleepSupport(value.sleepSupport, true, pose);
  value.body.scale.z = pose.breathing; value.body.position.z = pose.bodyOffsetZ;
  value.leftLeg.position.z = value.rightLeg.position.z = pose.legOffsetZ;
  value.root.rotation.set(pose.rotationX, 0, 0);
  value.root.position.set(2.4, .66 + pose.rootOffsetY, -1 + pose.headOffsetZ);
  value.root.updateMatrixWorld(true); return pose;
}
function actualMinimum(root: THREE.Object3D, predicate: (object: THREE.Mesh) => boolean = () => true) {
  let minY = Infinity, minZ = Infinity;
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !object.visible || !predicate(object)) return;
    const positions = object.geometry.getAttribute('position'), vertex = new THREE.Vector3();
    for (let i = 0; i < positions.count; i++) {
      vertex.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld);
      minY = Math.min(minY, vertex.y); minZ = Math.min(minZ, vertex.z);
    }
  });
  return { y: minY, z: minZ };
}
function backEnds(mesh: THREE.Mesh) {
  const positions = mesh.geometry.getAttribute('position'), local = new THREE.Vector3();
  mesh.geometry.computeBoundingBox(); const middle = (mesh.geometry.boundingBox!.min.y + mesh.geometry.boundingBox!.max.y) / 2;
  const endpoints = [new THREE.Vector3(0, Infinity, 0), new THREE.Vector3(0, Infinity, 0)];
  for (let i = 0; i < positions.count; i++) {
    local.fromBufferAttribute(positions, i); const index = local.y <= middle ? 0 : 1;
    const world = local.clone().applyMatrix4(mesh.matrixWorld);
    if (world.y < endpoints[index].y) endpoints[index].copy(world);
  }
  return endpoints;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
    root.traverse(object => { if (object instanceof THREE.Mesh) { geometries.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material); } });
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
  }
});

describe('taper-aware physical bed pose', () => {
  it('proves the old cup single-point correction still leaves its narrower end floating', () => {
    const cup = avatar('cup');
    setLivingSleepSupport(cup.sleepSupport, true);
    cup.root.rotation.x = -Math.PI / 2; cup.root.position.y = .66 - cup.bedBodySupportZ * cup.root.scale.z;
    cup.root.updateMatrixWorld(true);
    const torso = cup.body.children.find(p => p.userData.sleepBodySupport === true) as THREE.Mesh;
    const [lower, upper] = backEnds(torso);
    expect(upper.y).toBeCloseTo(.66, 6);
    expect(lower.y - .66).toBeGreaterThan(.06);
    place(cup, 1);
    const corrected = backEnds(torso);
    expect(corrected[0].y).toBeCloseTo(.66, 6);
    expect(corrected[1].y).toBeCloseTo(.66, 6);
  });

  it.each(['cup', 'bouquet', 'plant'] as const)('%s has both longitudinal body sections and its rear generator in contact', kind => {
    const value = avatar(kind), torso = value.body.children.find(p => p.userData.sleepBodySupport === true) as THREE.Mesh;
    for (const [yFactor, zFactor] of [[1, 1], [1.15, .83]]) {
      const original = value.root.scale.clone(); value.root.scale.y *= yFactor; value.root.scale.z *= zFactor;
      for (const breath of [.992, 1, 1.008]) {
        const pose = place(value, breath), [lower, upper] = backEnds(torso);
        expect(pose.rotationX).toBeGreaterThan(-Math.PI / 2);
        expect(pose.rotationX).toBeLessThan(-Math.PI / 3);
        expect(Math.abs(lower.z - upper.z)).toBeGreaterThan(.35);
        for (let i = 0; i <= 10; i++) expect(lower.clone().lerp(upper, i / 10).y).toBeCloseTo(.66, 5);
        expect(actualMinimum(value.root).y).toBeGreaterThanOrEqual(.66 - 1e-6);
      }
      value.root.scale.copy(original);
    }
  });

  it.each(kinds)('%s uses scaled actual support and maintains head-end positioning without moving the mattress', kind => {
    const value = avatar(kind);
    for (const breath of [.992, 1, 1.008]) {
      place(value, breath);
      expect(actualMinimum(value.root, mesh => mesh.userData.sleepBodySupport === true).y).toBeCloseTo(.66, 5);
      expect(actualMinimum(value.root).y).toBeGreaterThanOrEqual(.66 - 1e-6);
      expect(actualMinimum(value.body).z).toBeCloseTo(-1, 5);
    }
    const before = value.sleepSupport!.decorations.map(a => ({ part: a.part, z: a.awakeZ }));
    setLivingSleepSupport(value.sleepSupport, false);
    value.leftLeg.position.z = value.rightLeg.position.z = 0;
    before.forEach(original => expect(original.part.position.z).toBe(original.z));
  });

  it('keeps non-tapered forms at the original supine angle and rejects invalid geometry scale', () => {
    for (const kind of ['fruit', 'garment', 'creature'] as const) expect(place(avatar(kind), 1).rotationX).toBe(-Math.PI / 2);
    const cup = avatar('cup');
    expect(computeLivingBedPose(cup.sleepSupport, { y: 0, z: 1 })).toBeNull();
    expect(computeLivingBedPose(cup.sleepSupport, { y: 1, z: NaN })).toBeNull();
    expect(computeLivingBedPose(null, { y: 1, z: 1 })).toBeNull();
  });
});
