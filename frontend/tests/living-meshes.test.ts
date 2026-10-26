import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAvatar } from '@/lib/living-meshes';
import { disposeLivingObject } from '@/lib/living-world-engine';
import type { Avatar3D } from '@/lib/shared-living-3d';

const kinds = ['cup', 'bouquet', 'plant', 'fruit', 'garment', 'creature'] as const;
const roots: THREE.Group[] = [];
const spec = (kind: Avatar3D['kind']): Avatar3D => ({
  version: 1, kind, body: '#e2edd8', accent: '#d795bc', detail: '#806149',
  seed: 123, source: 'procedural_existing_features',
});
function avatar(kind: Avatar3D['kind']) {
  const value = buildAvatar(spec(kind));
  roots.push(value.root);
  return value;
}
function meshes(root: THREE.Object3D) {
  const values: THREE.Mesh[] = [];
  root.traverse(object => { if (object instanceof THREE.Mesh) values.push(object); });
  return values;
}
function geometryTypes(root: THREE.Object3D) {
  return meshes(root).reduce<Record<string, number>>((types, mesh) => {
    types[mesh.geometry.type] = (types[mesh.geometry.type] ?? 0) + 1;
    return types;
  }, {});
}

afterEach(() => { roots.splice(0).forEach(disposeLivingObject); });

describe('volumetric shared-life character geometry', () => {
  it.each(kinds)('%s has finite lit volumes above the floor, without image planes', kind => {
    const value = avatar(kind);
    const volumes = meshes(value.root);
    expect(volumes.length).toBeGreaterThan(10);
    const bounds = new THREE.Box3().setFromObject(value.root);
    const size = bounds.getSize(new THREE.Vector3());
    expect(bounds.min.y).toBeCloseTo(0, 5);
    expect(size.y).toBeGreaterThanOrEqual(1.3);
    expect(size.y).toBeLessThanOrEqual(1.6);
    expect(size.x).toBeGreaterThan(0.3);
    expect(size.z).toBeGreaterThan(0.3);
    let triangles = 0;
    for (const mesh of volumes) {
      expect(mesh.geometry.type).not.toBe('PlaneGeometry');
      const positions = mesh.geometry.getAttribute('position');
      expect(positions.count).toBeGreaterThan(3);
      expect(Array.from(positions.array).every(Number.isFinite)).toBe(true);
      mesh.geometry.computeBoundingBox();
      const localSize = mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
      // A face painted onto a plane must not substitute for a physical part.
      expect(localSize.x * localSize.y * localSize.z).toBeGreaterThan(0);
      triangles += (mesh.geometry.index?.count ?? positions.count) / 3;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
        expect(Object.values(material).some(value => value instanceof THREE.Texture)).toBe(false);
      }
    }
    // A full room of ten characters should not require dense generated meshes.
    expect(triangles).toBeLessThan(12_000);
    for (const joint of [value.body, value.leftArm, value.rightArm, value.leftLeg, value.rightLeg]) {
      expect(joint.parent).toBe(value.root);
    }
    expect(value.leftKnee.parent).toBe(value.leftLeg);
    expect(value.rightKnee.parent).toBe(value.rightLeg);
    expect(value.eyes.parent).toBe(value.body);
  });

  it.each(kinds)('%s can bend at the hips and knees to sit, then recover its original standing geometry', kind => {
    const value = avatar(kind);
    value.root.updateMatrixWorld(true);
    const standing = new THREE.Box3().setFromObject(value.root);
    const bodyBounds = new THREE.Box3().setFromObject(value.body);
    expect(value.seatHeight).toBeGreaterThan(0);
    expect(Number.isFinite(value.seatHeight)).toBe(true);
    expect(value.seatHeight).toBeCloseTo(bodyBounds.min.y / value.root.scale.y, 5);
    const beforeKnees = [value.leftKnee, value.rightKnee].map(knee => knee.getWorldPosition(new THREE.Vector3()));
    for (const [hip, knee] of [[value.leftLeg, value.leftKnee], [value.rightLeg, value.rightKnee]]) {
      expect(hip.position.y).toBe(.30);
      expect(knee.parent).toBe(hip);
      expect(meshes(knee).length).toBeGreaterThanOrEqual(2);
      expect(meshes(hip).length).toBeGreaterThan(meshes(knee).length);
      hip.position.y = value.seatHeight + .06;
      hip.rotation.x = -1.15; knee.rotation.x = 1.15;
    }
    value.root.updateMatrixWorld(true);
    for (const [index, knee] of [value.leftKnee, value.rightKnee].entries()) {
      const kneePosition = knee.getWorldPosition(new THREE.Vector3());
      expect(kneePosition.z).toBeGreaterThan(beforeKnees[index].z + .07 * value.root.scale.z);
      const shinDirection = new THREE.Vector3(0, -1, 0).applyQuaternion(knee.getWorldQuaternion(new THREE.Quaternion()));
      expect(shinDirection.y).toBeLessThan(-.99);
      expect(Math.abs(shinDirection.z)).toBeLessThan(.01);
    }
    expect(new THREE.Box3().setFromObject(value.root).min.y).toBeGreaterThan(standing.min.y + .05);
    for (const [hip, knee] of [[value.leftLeg, value.leftKnee], [value.rightLeg, value.rightKnee]]) {
      hip.position.y = .30; hip.rotation.x = 0; knee.rotation.x = 0;
    }
    value.root.updateMatrixWorld(true);
    const recovered = new THREE.Box3().setFromObject(value.root);
    expect(recovered.min.distanceTo(standing.min)).toBeLessThan(1e-6);
    expect(recovered.max.distanceTo(standing.max)).toBeLessThan(1e-6);
    // Existing walk animation still swings the whole leg from its original hip.
    value.leftLeg.rotation.x = .4; value.root.updateMatrixWorld(true);
    expect(value.leftKnee.getWorldQuaternion(new THREE.Quaternion()).angleTo(value.leftLeg.getWorldQuaternion(new THREE.Quaternion()))).toBeLessThan(1e-6);
  });

  it('retains object-specific volume construction instead of recolouring one generic doll', () => {
    const cup = avatar('cup'), bouquet = avatar('bouquet'), plant = avatar('plant');
    const fruit = avatar('fruit'), shirt = avatar('garment'), creature = avatar('creature');
    const byKind = [cup, bouquet, plant, fruit, shirt, creature].map(value => geometryTypes(value.root));
    expect(new Set(byKind.map(types => JSON.stringify(Object.entries(types).sort()))).size).toBe(6);
    expect(byKind[0].CylinderGeometry).toBeGreaterThanOrEqual(3); // cup and lid
    expect(meshes(cup.root).some(mesh => {
      const geometry = mesh.geometry;
      return geometry instanceof THREE.TorusGeometry && geometry.parameters.arc < Math.PI * 2;
    })).toBe(true); // curved cup handle, in addition to complete rim rings
    expect(byKind[1].ConeGeometry).toBeGreaterThan(0); // bouquet wrapping
    expect(byKind[1].SphereGeometry).toBeGreaterThan(byKind[3].SphereGeometry); // flower heads/petals
    expect(byKind[2].CylinderGeometry).toBeGreaterThan(0); // planted pot/stem
    expect(byKind[4].ExtrudeGeometry).toBeGreaterThanOrEqual(3); // thick shirt and collars
    expect(byKind[4].BoxGeometry).toBeGreaterThan(0); // shirt pocket/seam
    expect(byKind[5].CylinderGeometry ?? 0).toBe(0);
    expect(byKind[5].SphereGeometry).toBeGreaterThan(byKind[3].SphereGeometry); // ears/tail
  });

  it('keeps unsupported appearances empty instead of fabricating a substitute companion', () => {
    const value = avatar('unavailable');
    expect(value.root.children).toHaveLength(0);
    expect(meshes(value.root)).toHaveLength(0);
    expect(new THREE.Box3().setFromObject(value.root).isEmpty()).toBe(true);
    expect(Number.isFinite(value.seatHeight)).toBe(true);
    expect(value.seatHeight).toBeGreaterThan(0);
    expect(value.leftLeg.position.y).toBe(.30);
    expect(value.rightLeg.position.y).toBe(.30);
    expect(value.leftKnee.parent).toBe(value.leftLeg);
    expect(value.rightKnee.parent).toBe(value.rightLeg);
  });

  it.each(kinds)('releases each %s geometry and material once, including articulated knees, when a character leaves', kind => {
    const value = avatar(kind);
    const scene = new THREE.Scene();
    scene.add(value.root);
    const volumes = meshes(value.root);
    const geometries = new Set(volumes.map(mesh => mesh.geometry));
    const materials = new Set(volumes.flatMap(mesh => Array.isArray(mesh.material) ? mesh.material : [mesh.material]));
    expect(geometries.size).toBeLessThan(volumes.length);
    expect(materials.size).toBeLessThan(volumes.length);
    const events = new Map<THREE.BufferGeometry | THREE.Material, number>();
    for (const resource of [...geometries, ...materials]) {
      events.set(resource, 0);
      resource.addEventListener('dispose', () => events.set(resource, events.get(resource)! + 1));
    }
    disposeLivingObject(value.root);
    expect(value.root.parent).toBeNull();
    expect(scene.children).toHaveLength(0);
    expect([...events.values()].every(count => count === 1)).toBe(true);
    roots.splice(roots.indexOf(value.root), 1);
  });
});
