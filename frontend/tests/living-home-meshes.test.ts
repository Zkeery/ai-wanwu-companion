import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { buildHomeEnvironment } from '@/lib/living-home-meshes';
import { homeBedSlots } from '@/lib/living-home-layout';
import { disposeLivingObject } from '@/lib/living-world-engine';

const roots: THREE.Group[] = [];
function home(area: 'outdoor' | 'indoor' | 'bedroom', resting = 0, sleeping = 0, season: string | null = 'summer') {
  const result = buildHomeEnvironment(area, season, { resting, sleeping });
  roots.push(result); return result;
}
afterEach(() => { roots.splice(0).forEach(disposeLivingObject); });

describe('volumetric cottage furniture contracts', () => {
  it('provides the exact seat surface to all ten resting contacts', () => {
    expect(home('indoor', 3).getObjectByName('sofa-extra')).toBeUndefined();
    const room = home('indoor', 10);
    for (const [name, width, centerZ, contactZ, xs] of [
      ['sofa-main', 4.4, -1.95, -1.8, [0, -1.35, 1.35]],
      ['sofa-extra', 10, 1.25, 1.4, [-4.2, -2.8, -1.4, 0, 1.4, 2.8, 4.2]],
    ] as const) {
      const seat = room.getObjectByName(`${name}-seat`)!;
      const bounds = new THREE.Box3().setFromObject(seat), size = bounds.getSize(new THREE.Vector3());
      expect(size.x).toBeCloseTo(width, 5);
      expect(size.z).toBeCloseTo(1.1, 5);
      expect(bounds.max.y).toBeCloseTo(.72, 5);
      expect(bounds.getCenter(new THREE.Vector3()).z).toBeCloseTo(centerZ, 5);
      for (const x of xs) expect(bounds.containsPoint(new THREE.Vector3(x, .7199, contactZ))).toBe(true);
    }
  });

  it.each([0, 1, 2, 4, 6, 10])('keeps %s sleepers on the shared bed layout, including an empty-room bed', count => {
    const room = home('bedroom', 0, count), slots = homeBedSlots(count);
    const beds = room.children.filter(child => /^room-bed-\d+$/.test(child.name));
    expect(beds).toHaveLength(Math.max(1, count));
    for (const slot of slots) {
      const bed = room.getObjectByName(`room-bed-${slot.id}`)!;
      const mattress = bed.getObjectByName(`room-bed-${slot.id}-mattress`)!;
      const bounds = new THREE.Box3().setFromObject(mattress), center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
      expect(center.x).toBeCloseTo(slot.x, 5);
      expect(center.z).toBeCloseTo(slot.z, 5);
      expect(bounds.max.y).toBeCloseTo(slot.y, 5);
      expect(size.x).toBeCloseTo(slot.width, 5);
      expect(size.z).toBeCloseTo(slot.length, 5);
      expect(new THREE.Box3().setFromObject(bed).min.z).toBeLessThan(slot.z - slot.length / 2);
    }
  });

  it.each(['indoor', 'bedroom'] as const)('%s keeps windows and decorations in the cutaway wall hierarchy', area => {
    const room = home(area);
    const back = room.getObjectByName('room-back-wall')!, left = room.getObjectByName('room-left-wall')!;
    expect(back.userData.wallNormal).toEqual([0, -1]);
    expect(left.userData.wallNormal).toEqual([-1, 0]);
    expect(back.children.filter(child => child instanceof THREE.Group).length).toBeGreaterThanOrEqual(1);
    expect(new THREE.Box3().setFromObject(back).getSize(new THREE.Vector3()).z).toBeGreaterThan(.18);
  });

  it.each(['outdoor', 'indoor', 'bedroom'] as const)('%s uses finite real volumes with a bounded geometry budget', area => {
    const room = home(area, 10, 10);
    let triangles = 0, meshes = 0;
    room.traverse(child => {
      if (!(child instanceof THREE.Mesh)) return;
      meshes++;
      expect(child.geometry.type).not.toBe('PlaneGeometry');
      const bounds = new THREE.Box3().setFromObject(child), size = bounds.getSize(new THREE.Vector3());
      expect(size.toArray().every(value => Number.isFinite(value) && value > 0)).toBe(true);
      triangles += (child.geometry.index?.count ?? child.geometry.attributes.position.count) / 3;
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
        expect((material as THREE.MeshStandardMaterial).map).toBeNull();
      }
    });
    expect(meshes).toBeLessThan(300);
    expect(triangles).toBeLessThan(30000);
    expect(room.userData.floorBounds).toEqual({ minX: -5.5, maxX: 5.5, minZ: -4, maxZ: 4 });
  });

  it('exposes opt-in motion transforms without starting an animation loop', () => {
    const room = home('outdoor', 0, 0, 'spring');
    const moving: THREE.Object3D[] = [];
    room.traverse(child => { if (child.userData.localMotion) moving.push(child); });
    expect(moving.length).toBeGreaterThan(0);
    moving.forEach(child => {
      expect(child.userData.localMotion).toBe('leaf');
      expect(child.userData.baseRotation).toEqual({ x: child.rotation.x, y: child.rotation.y, z: child.rotation.z });
      expect(child.userData.baseScale).toEqual({ x: child.scale.x, y: child.scale.y, z: child.scale.z });
    });
  });
});
