import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAvatar } from '../lib/living-meshes';
import { computeLivingBedPose, setLivingSleepSupport } from '../lib/living-sleep-support';

const kinds = ['cup', 'bouquet', 'plant', 'fruit', 'garment', 'creature'] as const;
const roots: THREE.Group[] = [];
const mattressY = .66;

function avatar(kind: typeof kinds[number], seed = 123) {
  const value = buildAvatar({ version: 1, kind, seed, body: '#d9dfd1', accent: '#a6be9c', detail: '#6a6259', source: 'procedural_existing_features' });
  roots.push(value.root); return value;
}
function foot(knee: THREE.Group) {
  const result = knee.children.find(part => part instanceof THREE.Mesh && part.geometry instanceof THREE.SphereGeometry);
  expect(result).toBeInstanceOf(THREE.Mesh); return result!;
}
function minimum(part: THREE.Object3D) {
  return new THREE.Box3().setFromObject(part, true).min.y;
}
function place(value: ReturnType<typeof buildAvatar>, breathing: number, clampLegacyLegOffset = false) {
  const pose = computeLivingBedPose(value.sleepSupport, value.root.scale, breathing)!;
  setLivingSleepSupport(value.sleepSupport, true, pose);
  value.body.scale.z = pose.breathing; value.body.position.z = pose.bodyOffsetZ;
  for (const leg of [value.leftLeg, value.rightLeg]) {
    leg.position.set(leg.position.x, .30, clampLegacyLegOffset ? Math.max(0, pose.legOffsetZ) : pose.legOffsetZ);
    leg.rotation.set(0, 0, 0);
  }
  value.leftKnee.rotation.set(0, 0, 0); value.rightKnee.rotation.set(0, 0, 0);
  value.root.rotation.set(pose.rotationX, 0, 0);
  value.root.position.set(2.4, mattressY + pose.rootOffsetY, -1 + pose.headOffsetZ);
  value.root.updateMatrixWorld(true); return pose;
}
afterEach(() => {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  for (const root of roots.splice(0)) root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  geometries.forEach(value => value.dispose()); materials.forEach(value => value.dispose());
});

describe('sleeping feet bear on the actual mattress plane', () => {
  it('reproduces the old floating feet while the body already touches, then removes the gap', () => {
    const value = avatar('fruit'); value.root.scale.multiplyScalar(.9);
    place(value, 1, true);
    expect(minimum(foot(value.leftKnee)) - mattressY).toBeGreaterThan(.2);
    const torso = value.body.children.find(part => part.userData.sleepBodySupport === true)!;
    expect(minimum(torso)).toBeCloseTo(mattressY, 6);
    const corrected = place(value, 1);
    expect(corrected.legOffsetZ).toBeLessThan(0);
    expect(minimum(foot(value.leftKnee))).toBeCloseTo(mattressY, 6);
  });

  it.each(kinds)('%s keeps both feet and torso supported without thigh/shin penetration across breathing and scale', kind => {
    for (const seed of [0, 50, 100]) {
      const value = avatar(kind, seed), base = value.root.scale.clone();
      const originalDecorations = value.sleepSupport!.decorations.map(({ part, awakeZ }) => ({ part, awakeZ }));
      for (const factor of [.5, .9, 1.25]) for (const [y, z] of [[1, 1], [.8, 1.2], [1.2, .8]]) for (const breathing of [.992, 1, 1.008]) {
        value.root.scale.copy(base).multiplyScalar(factor); value.root.scale.y *= y; value.root.scale.z *= z;
        const pose = place(value, breathing);
        for (const knee of [value.leftKnee, value.rightKnee]) expect(minimum(foot(knee))).toBeCloseTo(mattressY, 6);
        expect(minimum(value.leftLeg)).toBeGreaterThanOrEqual(mattressY - 1e-6);
        expect(minimum(value.rightLeg)).toBeGreaterThanOrEqual(mattressY - 1e-6);
        expect(minimum(value.root)).toBeGreaterThanOrEqual(mattressY - 1e-6);
        const torso = value.body.children.find(part => part.userData.sleepBodySupport === true)!;
        expect(minimum(torso)).toBeCloseTo(mattressY, 6);
        expect(pose.rotationX).toBe(-Math.PI / 2 + Math.atan(value.sleepSupport!.taperSlope * value.root.scale.z * breathing / value.root.scale.y));
        const before = value.root.matrixWorld.elements.slice(), footBefore = minimum(foot(value.leftKnee));
        for (let repeat = 0; repeat < 3; repeat++) place(value, breathing);
        expect(value.root.matrixWorld.elements).toEqual(before);
        expect(minimum(foot(value.leftKnee))).toBe(footBefore);
      }
      setLivingSleepSupport(value.sleepSupport, false);
      value.leftLeg.position.z = value.rightLeg.position.z = 0;
      for (const { part, awakeZ } of originalDecorations) expect(part.position.z).toBe(awakeZ);
      expect(value.leftLeg.position.z).toBe(0); expect(value.rightLeg.position.z).toBe(0);
    }
  });
});
