import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { homeBedSlots } from '@/lib/living-home-layout';
import { buildHomeEnvironment } from '@/lib/living-home-meshes';
import { buildHomeWorldEnvironment } from '@/lib/living-home-world-meshes';
import { HOME_WORLD_REGIONS, homeWorldCamera, homeWorldPoint } from '@/lib/living-home-world';
import { disposeLivingObject } from '@/lib/living-world-engine';

const roots: THREE.Group[] = [];
function world() {
  const result = buildHomeWorldEnvironment('summer', { resting: 10, sleeping: 10 });
  roots.push(result); return result;
}
afterEach(() => { roots.splice(0).forEach(disposeLivingObject); });

describe('one continuous cottage world', () => {
  it.each(['outdoor', 'indoor', 'bedroom'] as const)('translates %s coordinates without rotating, scaling or modifying the local input', area => {
    const local = { x: .37, y: .72, z: -1.45 }, before = { ...local }, center = HOME_WORLD_REGIONS[area].center;
    expect(homeWorldPoint(area, local)).toEqual({ x: center.x + .37, y: center.y + .72, z: center.z - 1.45 });
    const a = homeWorldPoint(area, { x: -2, y: .66, z: 1.75 }), b = homeWorldPoint(area, { x: 3, y: 1.2, z: -3 });
    expect(new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z).length()).toBeCloseTo(Math.hypot(5, .54, -4.75), 8);
    expect(local).toEqual(before);
    const stage = world(), group = stage.getObjectByName(`home-environment-${area}`)!;
    expect(group.position.toArray()).toEqual([center.x, center.y, center.z]);
    expect(group.scale.toArray()).toEqual([1, 1, 1]); expect(group.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
  });

  it('preserves the real sofa and all bed contacts after region translation', () => {
    const stage = world();
    for (const [name, z, xs] of [
      ['sofa-main-seat', -1.45, [0, -1.35, 1.35]],
      ['sofa-extra-seat', 1.75, [-4.2, -2.8, -1.4, 0, 1.4, 2.8, 4.2]],
    ] as const) {
      const bounds = new THREE.Box3().setFromObject(stage.getObjectByName(name)!);
      expect(bounds.max.y).toBeCloseTo(.72, 5);
      for (const x of xs) {
        const point = homeWorldPoint('indoor', { x, y: .7199, z });
        expect(bounds.containsPoint(new THREE.Vector3(point.x, point.y, point.z))).toBe(true);
      }
    }
    for (const slot of homeBedSlots(10)) {
      const bounds = new THREE.Box3().setFromObject(stage.getObjectByName(`room-bed-${slot.id}-mattress`)!);
      const expected = homeWorldPoint('bedroom', { x: slot.x, y: slot.y, z: slot.z });
      const center = bounds.getCenter(new THREE.Vector3());
      expect(center.x).toBeCloseTo(expected.x, 5); expect(center.z).toBeCloseTo(expected.z, 5);
      expect(bounds.max.y).toBeCloseTo(expected.y, 5);
      expect(bounds.getSize(new THREE.Vector3()).x).toBeCloseTo(slot.width, 5);
    }
  });

  it('connects the yard through the single front entrance and then the room doorway over continuous low floors', () => {
    const stage = world(), connection = stage.getObjectByName('home-continuous-veranda')!;
    expect(connection.userData.connects).toEqual(['indoor', 'bedroom', 'outdoor']);
    expect(stage.getObjectByName('courtyard-stone-cottage')).toBeUndefined();
    expect(stage.getObjectByName('cottage-stone-gable')).toBeUndefined();
    const approach = connection.userData.approachPath as Array<{ x: number; z: number }>;
    expect(approach.length).toBeGreaterThan(3);
    const points = [...approach.slice().reverse().map(p => [p.x, p.z]), [-2.4, -.7], [-.4, -.7], [-.4, -1.525], [.4, -1.525], [.4, -.65], [5.65, -.65]];
    for (let segment = 0; segment < points.length - 1; segment++) for (let step = 0; step <= 10; step++) {
        const t = step / 10, x = points[segment][0] * (1 - t) + points[segment + 1][0] * t;
        const z = points[segment][1] * (1 - t) + points[segment + 1][1] * t;
        const ray = new THREE.Raycaster(new THREE.Vector3(x, 1.8, z), new THREE.Vector3(0, -1, 0), 0, 2);
        const hit = ray.intersectObject(stage, true)[0];
        expect(hit, `missing floor at ${x},${z}`).toBeDefined();
        expect(hit.point.y, `entry blocked by scenery at ${x},${z}`).toBeLessThanOrEqual(.065);
        expect(hit.point.y).toBeGreaterThanOrEqual(-.025);
    }
  });

  it.each([[1088, 550], [320, 360]])('fits every real mesh vertex in the overview camera at %s×%s', (width, height) => {
    const stage = world(), preset = homeWorldCamera('overview'), aspect = width / height;
    const camera = new THREE.PerspectiveCamera(36, aspect, .1, 160), target = new THREE.Vector3(...preset.target);
    const fitFactor = Math.min(1.55, Math.max(1, 1.45 / aspect));
    camera.position.set(...preset.position).sub(target).multiplyScalar(fitFactor).add(target);
    camera.lookAt(target); camera.updateMatrixWorld(true);
    const projected = new THREE.Box3(), point = new THREE.Vector3(); let vertices = 0;
    stage.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const positions = object.geometry.attributes.position;
      for (let index = 0; index < positions.count; index++) {
        point.fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld).project(camera);
        projected.expandByPoint(point); vertices++;
      }
    });
    expect(vertices).toBeGreaterThan(1000);
    expect(projected.min.x).toBeGreaterThan(-1); expect(projected.max.x).toBeLessThan(1);
    expect(projected.min.y).toBeGreaterThan(-1); expect(projected.max.y).toBeLessThan(1);
    expect(projected.min.z).toBeGreaterThan(-1); expect(projected.max.z).toBeLessThan(1);
  });

  it.each(['outdoor', 'indoor', 'bedroom'] as const)('gives %s its own editable camera distance while one house owns the exterior cutaway walls', area => {
    const preset = homeWorldCamera(area), center = HOME_WORLD_REGIONS[area].center;
    expect(preset.target).toEqual(area === 'outdoor' ? [0, .75, 4.8] : [center.x, .75, center.z - .3]);
    const distance = new THREE.Vector3(...preset.position).distanceTo(new THREE.Vector3(...preset.target));
    expect(distance).toBeGreaterThan(preset.minDistance); expect(distance).toBeLessThan(preset.maxDistance);
    if (area === 'outdoor') return;
    const stage = world(), region = stage.getObjectByName(`home-environment-${area}`)!, architecture = stage.getObjectByName('home-world-architecture')!;
    expect(architecture).toBeDefined();
    for (const name of ['room-back-wall', 'room-left-wall']) expect(region.getObjectByName(name)).toBeUndefined();
    for (const side of ['front', 'back', 'left', 'right']) {
      const wall = architecture.getObjectByName(`home-exterior-${side}-upper-wall`)!;
      expect(wall.userData.architectureRole).toBe('exterior-wall-upper');
      expect(wall.userData.wallOrigin).toEqual(expect.objectContaining({ x: expect.any(Number), z: expect.any(Number) }));
      expect(wall.userData.wallNormal).toHaveLength(2);
    }
  });

  it('retains the old standalone outdoor builder default without a world-mode roof', () => {
    const standalone = buildHomeEnvironment('outdoor', 'summer', { resting: 0, sleeping: 0 }); roots.push(standalone);
    expect(standalone.getObjectByName('courtyard-stone-cottage')).toBeDefined();
    expect(world().getObjectByName('courtyard-stone-cottage')).toBeUndefined();
  });

  it('keeps all three real regions within a bounded untextured geometry budget', () => {
    const stage = world(); let triangles = 0, meshes = 0;
    expect(stage.children.filter(child => child.userData.homeRegion)).toHaveLength(3);
    stage.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      meshes++; triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
      expect(object.geometry.type).not.toBe('PlaneGeometry');
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) expect((material as THREE.MeshStandardMaterial).map).toBeNull();
    });
    expect(meshes).toBeLessThan(700); expect(triangles).toBeLessThan(50000);
  });

  it('does not prematurely dispose shared live resources and releases each one exactly once', () => {
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose'), materialDispose = vi.spyOn(THREE.Material.prototype, 'dispose');
    const stage = world(), geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
    stage.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    });
    for (const geometry of geometries) expect(geometryDispose.mock.contexts.filter(value => value === geometry)).toHaveLength(0);
    for (const material of materials) expect(materialDispose.mock.contexts.filter(value => value === material)).toHaveLength(0);
    roots.splice(roots.indexOf(stage), 1); disposeLivingObject(stage);
    for (const geometry of geometries) expect(geometryDispose.mock.contexts.filter(value => value === geometry)).toHaveLength(1);
    for (const material of materials) expect(materialDispose.mock.contexts.filter(value => value === material)).toHaveLength(1);
  });
});
