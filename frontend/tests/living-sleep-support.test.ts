import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAvatar } from '../lib/living-meshes';
import { prepareLivingSleepSupport, setLivingSleepSupport } from '../lib/living-sleep-support';
import type { Avatar3D } from '../lib/shared-living-3d';

const kinds = ['cup', 'bouquet', 'plant', 'fruit', 'garment', 'creature'] as const;
const roots: THREE.Group[] = [];
function avatar(kind: Avatar3D['kind'], seed = 1) {
  const value = buildAvatar({ version: 1, kind, seed, body: '#d9dfd1', accent: '#a6be9c', detail: '#6a6259', source: 'procedural_existing_features' });
  roots.push(value.root); return value;
}
// Independent actual rendered-vertex measurement: no support helper or Box3 proxy.
function minY(root: THREE.Object3D, bodyOnly = false) {
  root.updateWorldMatrix(true, true); let min = Infinity;
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !object.visible || (bodyOnly && object.userData.sleepBodySupport !== true)) return;
    const positions = object.geometry.getAttribute('position'), vertex = new THREE.Vector3();
    for (let i = 0; i < positions.count; i++) min = Math.min(min, vertex.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld).y);
  });
  return min;
}
function sleep(value: ReturnType<typeof buildAvatar>, breathing = 1, useLegacy = false) {
  const support = useLegacy ? value.bedSupportZ : value.bedBodySupportZ;
  setLivingSleepSupport(value.sleepSupport, !useLegacy);
  value.root.rotation.set(-Math.PI / 2, 0, 0);
  value.root.position.set(2.4, .66 - support * value.root.scale.z, -1.5);
  value.body.scale.z = breathing; value.body.position.z = support * (1 - breathing);
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
    root.traverse(object => { if (object instanceof THREE.Mesh) { geometries.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material); } });
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
  }
});

describe('body-based sleeping contact', () => {
  it('reproduces the cup floating gap caused by legacy whole-body support before removing it', () => {
    const cup = avatar('cup'); cup.root.scale.multiplyScalar(.9);
    sleep(cup, 1, true);
    const oldBodyGap = minY(cup.root, true) - .66;
    expect(oldBodyGap).toBeGreaterThan(.01);
    sleep(cup);
    expect(minY(cup.root, true)).toBeCloseTo(.66, 6);
    expect(minY(cup.root)).toBeGreaterThanOrEqual(.66 - 1e-6);
    // Retain the legacy API for older consumers, rather than silently changing its meaning.
    expect(cup.bedSupportZ).toBeLessThan(cup.bedBodySupportZ);
  });

  it.each(kinds)('%s core actually meets the mattress and all visible volumes remain above it through breathing', kind => {
    for (const seed of [1, 123, 65535]) {
      const value = avatar(kind, seed); value.root.scale.multiplyScalar(.9);
      expect(value.sleepSupport).not.toBeNull();
      expect(value.bedBodySupportZ).toBe(value.sleepSupport!.bodySupportZ);
      for (const breathing of [.992, 1, 1.008]) {
        sleep(value, breathing);
        expect(minY(value.root, true)).toBeCloseTo(.66, 5);
        expect(minY(value.root)).toBeGreaterThanOrEqual(.66 - 1e-6);
      }
    }
  });

  it.each(kinds)('%s accessory repose is idempotent and waking restores its exact original geometry', kind => {
    const value = avatar(kind), before = value.body.children.map(part => ({ part, position: part.position.clone() }));
    setLivingSleepSupport(value.sleepSupport, true);
    const asleep = value.body.children.map(part => part.position.clone());
    for (let i = 0; i < 100; i++) setLivingSleepSupport(value.sleepSupport, true);
    expect(value.body.children.map(part => part.position.toArray())).toEqual(asleep.map(p => p.toArray()));
    setLivingSleepSupport(value.sleepSupport, false);
    for (const original of before) expect(original.part.position.equals(original.position)).toBe(true);
  });

  it('does not let a newly attached rear decoration become the body support point or pierce the bed', () => {
    const value = avatar('creature');
    const originalSupport = value.bedBodySupportZ;
    const decoration = new THREE.Mesh(new THREE.BoxGeometry(.15, .15, .4), new THREE.MeshStandardMaterial());
    decoration.position.set(.2, 0, -.9); value.body.add(decoration);
    value.sleepSupport = prepareLivingSleepSupport(value.root, value.body);
    expect(value.sleepSupport!.bodySupportZ).toBeCloseTo(originalSupport, 8);
    expect(value.sleepSupport!.adjustments.some(a => a.part === decoration)).toBe(true);
    sleep(value);
    expect(minY(value.root, true)).toBeCloseTo(.66, 6);
    expect(minY(value.root)).toBeGreaterThanOrEqual(.66 - 1e-6);
    setLivingSleepSupport(value.sleepSupport, false);
    expect(decoration.position.z).toBe(-.9);
  });

  it('leaves unavailable avatars absent and handles missing support without inventing geometry', () => {
    const value = avatar('unavailable');
    expect(value.sleepSupport).toBeNull();
    setLivingSleepSupport(value.sleepSupport, true);
    expect(value.root.children).toHaveLength(0);
    expect(Number.isFinite(value.bedBodySupportZ)).toBe(true);
  });
});
