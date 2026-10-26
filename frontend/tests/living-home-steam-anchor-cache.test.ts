import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHomeActivityEffects } from '../lib/living-home-activity-effects';
import type { HomeLeisureSnapshot } from '../lib/living-home-leisure';

const effects: ReturnType<typeof createHomeActivityEffects>[] = [];
const snapshot: HomeLeisureSnapshot = {
  revision: 0,
  scope: { groupId: 'synthetic-steam-cache', ownerId: 'owner', synthetic: true, optIn: true },
  permitted: true, assignments: [], television: { powered: false, watchingActorIds: [] },
};
afterEach(() => { effects.splice(0).forEach(effect => effect.dispose()); vi.restoreAllMocks(); });
function fixture() {
  const scene = new THREE.Scene(), effect = createHomeActivityEffects(scene);
  effects.push(effect);
  const group = scene.getObjectByName('home-local-activity-effects')!;
  const update = (world: THREE.Object3D | null, elapsed = 0) => effect.update(world, new Map(), snapshot, [], elapsed);
  return { scene, effect, group, update };
}
function pot(parent: THREE.Object3D, x: number) {
  const value = new THREE.Group(); value.position.set(x, .7, 2);
  value.userData.homeTeaSteamAnchor = { x: .12, y: .31, z: -.08 };
  parent.add(value); return value;
}
function expectedPosition(anchor: THREE.Object3D) {
  const { x, y, z } = anchor.userData.homeTeaSteamAnchor;
  return anchor.localToWorld(new THREE.Vector3(x, y, z));
}

describe('local tea steam anchor lifecycle cache', () => {
  it('walks an unchanged world once while preserving the actual animated steam buffers', () => {
    const f = fixture(), world = new THREE.Group(), anchor = pot(world, 1);
    for (let i = 0; i < 200; i++) world.add(new THREE.Group());
    const traverse = vi.spyOn(world, 'traverse');
    f.update(world, 0);
    const line = f.group.getObjectByName('home-tea-steam-0') as THREE.Line;
    const position = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    const version = position.version, before = Array.from(position.array);
    for (let i = 1; i <= 120; i++) f.update(world, i / 30);
    expect(traverse).toHaveBeenCalledTimes(1);
    expect(position.version).toBe(version + 120);
    expect(Array.from(position.array)).not.toEqual(before);
    expect(f.group.visible).toBe(true);
    expect(f.group.position.distanceTo(expectedPosition(anchor))).toBeLessThan(1e-10);
    expect(f.group.children).toHaveLength(7);
  });

  it('binds each replacement world separately and hides steam for null or anchor-free worlds', () => {
    const f = fixture(), a = new THREE.Group(), b = new THREE.Group(), empty = new THREE.Group();
    const first = pot(a, 1), second = pot(b, 9);
    f.update(a); expect(f.group.position.distanceTo(expectedPosition(first))).toBeLessThan(1e-10);
    f.update(b); expect(f.group.position.distanceTo(expectedPosition(second))).toBeLessThan(1e-10);
    f.update(empty); expect(f.group.visible).toBe(false);
    f.update(null); expect(f.group.visible).toBe(false);
    f.update(a); expect(f.group.visible).toBe(true);
    expect(f.group.position.distanceTo(expectedPosition(first))).toBeLessThan(1e-10);
  });

  it('drops a detached ancestor and discovers a replacement without displaying the old pot position', () => {
    const f = fixture(), world = new THREE.Group(), stand = new THREE.Group(), outside = new THREE.Group();
    world.add(stand); pot(stand, 1); f.update(world);
    outside.add(stand); stand.position.set(100, 0, 0); f.update(world);
    expect(f.group.visible).toBe(false);
    const replacement = pot(world, 8); f.update(world);
    expect(f.group.visible).toBe(true);
    expect(f.group.position.distanceTo(expectedPosition(replacement))).toBeLessThan(1e-10);
  });

  it('uses current parent transforms after reparenting within the same world without rescanning', () => {
    const f = fixture(), world = new THREE.Group(), table = new THREE.Group(), hand = new THREE.Group();
    world.add(table, hand); const anchor = pot(table, 1);
    const traverse = vi.spyOn(world, 'traverse'); f.update(world);
    hand.add(anchor); hand.position.set(-3, 2, 4); hand.rotation.set(.2, .7, -.1); hand.scale.set(1.3, .8, 1.1);
    f.update(world, 1);
    expect(traverse).toHaveBeenCalledTimes(1);
    expect(f.group.position.distanceTo(expectedPosition(anchor))).toBeLessThan(1e-10);
  });

  it('invalidates the current anchor when its steam marker is removed', () => {
    const f = fixture(), world = new THREE.Group(), anchor = pot(world, 1);
    f.update(world); delete anchor.userData.homeTeaSteamAnchor; f.update(world);
    expect(f.group.visible).toBe(false);
    anchor.userData.homeTeaSteamAnchor = { x: .5, y: .8, z: .1 }; f.update(world);
    expect(f.group.visible).toBe(true);
    expect(f.group.position.distanceTo(expectedPosition(anchor))).toBeLessThan(1e-10);
  });

  it('clears world bindings and hides the old effect on restore before discovering the restored world', () => {
    const f = fixture(), world = new THREE.Group(); pot(world, 1); f.update(world);
    f.effect.restore(); expect(f.group.visible).toBe(false);
    const replacement = pot(world, 7), traverse = vi.spyOn(world, 'traverse'); f.update(world);
    expect(traverse).toHaveBeenCalledTimes(1);
    expect(f.group.visible).toBe(true);
    expect(f.group.position.distanceTo(expectedPosition(replacement))).toBeLessThan(1e-10);
  });

  it('stays inert after repeated disposal without rescanning or recreating effects', () => {
    const f = fixture(), world = new THREE.Group(); pot(world, 1); f.update(world);
    f.effect.dispose(); f.effect.dispose(); const traverse = vi.spyOn(world, 'traverse'); f.update(world);
    expect(traverse).not.toHaveBeenCalled();
    expect(f.group.parent).toBeNull();
    expect(f.scene.getObjectByName('home-local-activity-effects')).toBeUndefined();
  });
});
