import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGathering } from '@/lib/gatherings';
import { buildHomeWorldEnvironment } from '@/lib/living-home-world-meshes';
import { buildRealisticHomeItem } from '@/lib/living-home-realistic-details';
import { collectHomeLeisureSeats, createHomeTeaCupBinding } from '@/lib/living-home-leisure-scene';
import { createHomeLeisureController } from '@/lib/living-home-leisure';
import { disposeLivingObject } from '@/lib/living-world-engine';
import { createHomeActivityEffects } from '@/lib/living-home-activity-effects';

const roots: THREE.Object3D[] = [];
beforeEach(() => { vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>()); });
afterEach(() => { roots.splice(0).forEach(root => disposeLivingObject(root)); vi.restoreAllMocks(); });
function fixture() {
  const gathering = parseGathering({ id: 'synthetic-daily-geometry', title: '日常实体座位', scene_type: 'home', revision: 1,
    closed: false, is_manager: true, me: 'owner', members: [{ id: 'owner', name: '合成成员', manager: true }],
    companions: [{ id: 4, owner_id: 'owner', name: '原沙发伙伴', activity: 'rest', area: 'indoor', x: .5, y: .5 }],
    items: [], votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
  const world = buildHomeWorldEnvironment('summer', { resting: 1, sleeping: 1 }, { realistic: true }); roots.push(world);
  const items = new THREE.Group(); roots.push(items);
  const table = world.getObjectByName('home-farmhouse-tea-table')!; world.updateMatrixWorld(true);
  const point = table.getWorldPosition(new THREE.Vector3());
  const bench = buildRealisticHomeItem('bench', 'summer', world.userData.homeMaterialLibrary);
  bench.userData.homeItemId = 'actual-bench'; bench.position.set(point.x, point.y, point.z - .9); items.add(bench);
  return { gathering, world, items, bench, table };
}
function exactTransform(object: THREE.Object3D) {
  return { parent: object.parent, position: object.position.toArray(), quaternion: object.quaternion.toArray(),
    scale: object.scale.toArray(), matrix: object.matrix.toArray(), matrixAutoUpdate: object.matrixAutoUpdate };
}

describe('daily scene actual Three furniture adapters and cups', () => {
  it('keeps the full ten-seat runtime and steam volume within the mesh budget and disposes each unique FX resource once', () => {
    const scene = new THREE.Scene(), world = buildHomeWorldEnvironment('summer', { resting: 10, sleeping: 10 }, { realistic: true });
    scene.add(world); roots.push(scene);
    for (const kind of ['tree', 'bench', 'shade'] as const) scene.add(buildRealisticHomeItem(kind, 'summer', world.userData.homeMaterialLibrary));
    const count = () => {
      let meshes = 0, triangles = 0;
      scene.traverse(o => { if (o instanceof THREE.Mesh) { meshes++; triangles += (o.geometry.index?.count ?? o.geometry.getAttribute('position').count) / 3; } });
      return { meshes, triangles };
    };
    const before = count(), fx = createHomeActivityEffects(scene), group = scene.getObjectByName('home-local-activity-effects')!;
    const volumes = group.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
    for (const child of group.children as Array<THREE.Mesh | THREE.Line | THREE.Points>) {
      geometries.add(child.geometry); for (const material of Array.isArray(child.material) ? child.material : [child.material]) materials.add(material);
    }
    const disposals = [...geometries, ...materials].map(resource => vi.spyOn(resource, 'dispose'));
    try {
      expect(before).toEqual({ meshes: 648, triangles: 49_738 });
      expect(volumes).toHaveLength(3); expect(new Set(volumes.map(o => o.geometry)).size).toBe(1);
      expect(new Set(volumes.map(o => o.material)).size).toBe(3);
      expect(volumes.reduce((sum, o) => sum + (o.geometry.index?.count ?? o.geometry.getAttribute('position').count) / 3, 0)).toBe(240);
      expect(group.children.filter(o => o instanceof THREE.Line)).toHaveLength(3);
      expect((group.children.find(o => o instanceof THREE.Points) as THREE.Points).geometry.getAttribute('position').count).toBe(18);
      expect(geometries.size).toBe(5); expect(materials.size).toBe(7);
      expect(count()).toEqual({ meshes: 651, triangles: 49_978 });
      expect(count().meshes).toBeLessThanOrEqual(700); expect(count().triangles).toBeLessThanOrEqual(50_000);
      const state = createHomeLeisureController({ scope: { groupId: 'synthetic-volume-budget', ownerId: 'owner', synthetic: true, optIn: true }, actors: [], seats: [] }).getSnapshot();
      const capture = () => volumes.map(o => ({ position: o.position.toArray(), quaternion: o.quaternion.toArray(), scale: o.scale.toArray(), opacity: (o.material as THREE.MeshBasicMaterial).opacity }));
      fx.update(world, new Map(), state, [], 2.75); const frozen = capture();
      fx.update(world, new Map(), state, [], 2.75); expect(capture()).toEqual(frozen);
      console.info('DAILY_FX_RUNTIME_BUDGET ' + JSON.stringify({ baseline: before, runtime: count(), fx: { volumeMeshes: volumes.length, volumeTriangles: 240, uniqueGeometries: geometries.size, uniqueMaterials: materials.size }, resourcesDisposedOnce: disposals.length }));
    } finally { fx.dispose(); fx.dispose(); }
    disposals.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
  });

  it('anchors three steam lines above the actual teapot spout vertices and uses world transforms at the frozen elapsed time', () => {
    const { gathering, world, items } = fixture(), scene = new THREE.Scene(); scene.add(world);
    world.position.set(2, .3, -1); world.rotation.y = .4; world.scale.setScalar(1.1); world.updateMatrixWorld(true);
    const teapot = world.getObjectByName('home-farmhouse-teapot') as THREE.Mesh, vertices = teapot.geometry.getAttribute('position');
    const mouth = new THREE.Box3(); let mouthCount = 0;
    for (let i = 0; i < vertices.count; i++) if (vertices.getX(i) > .06 && vertices.getY(i) > .89) { mouth.expandByPoint(new THREE.Vector3().fromBufferAttribute(vertices, i)); mouthCount++; }
    expect(mouthCount).toBeGreaterThan(5);
    const actualAnchor = mouth.getCenter(new THREE.Vector3()).add(new THREE.Vector3(0, .02, 0));
    const raw = teapot.userData.homeTeaSteamAnchor; expect(new THREE.Vector3(raw.x, raw.y, raw.z).distanceTo(actualAnchor)).toBeLessThan(1e-5);
    const seats = collectHomeLeisureSeats(world, items, gathering), controller = createHomeLeisureController({ scope: { groupId: gathering.id, ownerId: gathering.me, synthetic: true, optIn: true }, actors: [], seats });
    const fx = createHomeActivityEffects(scene);
    try {
      fx.update(world, new Map(), controller.getSnapshot(), seats, 2.75);
      const group = scene.getObjectByName('home-local-activity-effects')!;
      expect(group.children.filter(o => o instanceof THREE.Line)).toHaveLength(3);
      expect(group.children.filter(o => o instanceof THREE.Points)).toHaveLength(1);
      expect(group.children.some(o => o instanceof THREE.Light)).toBe(false);
      expect(group.position.distanceTo(teapot.localToWorld(actualAnchor))).toBeLessThan(1e-5);
      const before = group.children.map(o => Array.from((o as THREE.Line).geometry.getAttribute('position').array));
      fx.update(world, new Map(), controller.getSnapshot(), seats, 2.75);
      expect(group.children.map(o => Array.from((o as THREE.Line).geometry.getAttribute('position').array))).toEqual(before);
      fx.update(world, new Map(), controller.getSnapshot(), seats, 2.85);
      expect(group.children.map(o => Array.from((o as THREE.Line).geometry.getAttribute('position').array))).not.toEqual(before);
      fx.update(null, new Map(), controller.getSnapshot(), seats, 2.85); expect(group.visible).toBe(false);
    } finally { fx.dispose(); }
  });

  it('collects real table, stool, sofa and chair coordinates from world matrices without changing Gathering', () => {
    const { gathering, world, items, bench, table } = fixture(), original = JSON.stringify(gathering);
    const seats = collectHomeLeisureSeats(world, items, gathering);
    expect(seats.filter(s => s.station === 'tea')).toHaveLength(2);
    expect(seats.filter(s => s.station === 'mahjong')).toHaveLength(4);
    expect(seats.filter(s => s.station === 'television')).toHaveLength(3);
    const tea = seats.find(s => s.id === 'tea-0')!, benchSeat = seats.find(s => s.station === 'bench')!;
    expect(tea.physicalId).toBe(benchSeat.physicalId); expect([tea.x, tea.y, tea.z]).toEqual([benchSeat.x, benchSeat.y, benchSeat.z]);
    const raw = bench.userData.homeRestSeats[0], actual = bench.localToWorld(new THREE.Vector3(raw.x, raw.y, raw.z));
    expect([tea.x, tea.y, tea.z]).toEqual(actual.toArray());
    const tablePoint = table.getWorldPosition(new THREE.Vector3()); expect(tea.yaw).toBeCloseTo(Math.atan2(tablePoint.x - tea.x, tablePoint.z - tea.z), 8);
    const stool = world.getObjectByName('home-tea-stool-seat')!, top = new THREE.Box3().setFromObject(stool, true).max.y;
    expect(seats.find(s => s.id === 'tea-1')!.y).toBeCloseTo(top, 5);
    for (let i = 0; i < 4; i++) {
      const chair = world.getObjectByName(`home-mahjong-chair-${i}-seat`)!;
      const actualTop = new THREE.Box3().setFromObject(chair, true).max.y;
      expect(seats.find(s => s.id === `mahjong-${i}`)!.y).toBeCloseTo(actualTop, 5);
    }
    expect(seats.every(s => [s.x, s.y, s.z, s.yaw].every(Number.isFinite))).toBe(true);
    expect(JSON.stringify(gathering)).toBe(original);
  });

  it('uses saved bench world transforms, rejects a distant or backward bench, and never invents a tea bench', () => {
    const { gathering, world, items, bench } = fixture();
    bench.rotation.y = Math.PI; expect(collectHomeLeisureSeats(world, items, gathering).some(s => s.id === 'tea-0')).toBe(false);
    bench.rotation.y = 0; bench.position.z -= 10; expect(collectHomeLeisureSeats(world, items, gathering).some(s => s.id === 'tea-0')).toBe(false);
    bench.position.z += 10; items.position.set(.1, 0, .1); items.rotation.y = .03;
    const seat = collectHomeLeisureSeats(world, items, gathering).find(s => s.station === 'bench')!;
    const raw = bench.userData.homeRestSeats[0], actual = bench.localToWorld(new THREE.Vector3(raw.x, raw.y, raw.z));
    expect([seat.x, seat.y, seat.z]).toEqual(actual.toArray());
    expect(seat.yaw).toBeCloseTo(.03, 8);
    expect(collectHomeLeisureSeats(null, items, gathering)).toEqual([]);
  });

  it('enforces mutual exclusion across actual tea/bench aliases and releases the physical seat on stop', () => {
    const { gathering, world, items } = fixture(), seats = collectHomeLeisureSeats(world, items, gathering);
    const tea = seats.find(s => s.id === 'tea-0')!, bench = seats.find(s => s.station === 'bench')!;
    const controller = createHomeLeisureController({ scope: { groupId: gathering.id, ownerId: gathering.me, synthetic: true, optIn: true }, actors: [{ id: 1 }, { id: 2 }], seats });
    expect(controller.assign({ activity: 'tea', actorId: 1, seatId: tea.id }).ok).toBe(true);
    const before = controller.getSnapshot();
    expect(controller.assign({ activity: 'bench', actorId: 2, seatId: bench.id })).toMatchObject({ ok: false, error: 'seat_busy' });
    expect(controller.getSnapshot()).toEqual(before); expect(controller.stop({ actorId: 1 }).ok).toBe(true);
    expect(controller.assign({ activity: 'bench', actorId: 2, seatId: bench.id }).ok).toBe(true);
  });

  it('preserves the original sofa occupant reservation from real furniture geometry', () => {
    const { gathering, world, items } = fixture(), seats = collectHomeLeisureSeats(world, items, gathering);
    const reserved = seats.find(s => s.id === 'television-0')!; expect(reserved.reservedByActorId).toBe(4);
    const controller = createHomeLeisureController({ scope: { groupId: gathering.id, ownerId: gathering.me, synthetic: true, optIn: true }, actors: [{ id: 1 }, { id: 4 }], seats });
    expect(controller.assign({ activity: 'television', actorId: 1, seatId: reserved.id })).toMatchObject({ ok: false, error: 'seat_busy' });
    expect(controller.assign({ activity: 'television', actorId: 4 }).snapshot.assignments[0].seatId).toBe(reserved.id);
  });

  it('explicit station switching keeps the actor original activity while moving to a new free real seat', () => {
    const { gathering, world, items } = fixture(), seats = collectHomeLeisureSeats(world, items, gathering);
    const controller = createHomeLeisureController({ scope: { groupId: gathering.id, ownerId: gathering.me, synthetic: true, optIn: true }, actors: [{ id: 1, activity: 'walk' }], seats });
    expect(controller.assign({ activity: 'tea', actorId: 1, elapsed: 1 }).ok).toBe(true);
    const result = controller.assign({ activity: 'bench', actorId: 1, elapsed: 2 });
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(result.snapshot.assignments).toEqual([expect.objectContaining({ actorId: 1, activity: 'bench', originalActivity: 'walk', startedAtElapsed: 2 })]);
  });

  it('a full target station rejects explicit switching without losing the current seat or original activity', () => {
    const { gathering, world, items } = fixture(), seats = collectHomeLeisureSeats(world, items, gathering);
    const controller = createHomeLeisureController({ scope: { groupId: gathering.id, ownerId: gathering.me, synthetic: true, optIn: true }, actors: [{ id: 1, activity: 'walk' }, { id: 2, activity: 'observe' }], seats });
    expect(controller.assign({ activity: 'bench', actorId: 2 }).ok).toBe(true);
    expect(controller.assign({ activity: 'tea', actorId: 1 }).ok).toBe(true); const before = controller.getSnapshot();
    expect(controller.assign({ activity: 'bench', actorId: 1 })).toMatchObject({ ok: false, error: 'insufficient_seats' });
    expect(controller.getSnapshot()).toEqual(before);
  });

  it('automatic starts do not switch an actor out of their current station', () => {
    const { gathering, world, items } = fixture(), seats = collectHomeLeisureSeats(world, items, gathering);
    const controller = createHomeLeisureController({ scope: { groupId: gathering.id, ownerId: gathering.me, synthetic: true, optIn: true }, actors: [{ id: 1, activity: 'observe' }], seats });
    expect(controller.assign({ activity: 'tea', actorId: 1 }).ok).toBe(true); const before = controller.getSnapshot();
    expect(controller.start('television')).toMatchObject({ ok: false, error: 'insufficient_actors' });
    expect(controller.getSnapshot()).toEqual(before);
  });

  it('borrows the actual table cup, is idempotent, and restores exact parent, transform and matrix policy', () => {
    const { gathering, world, items } = fixture(), seats = collectHomeLeisureSeats(world, items, gathering), binding = createHomeTeaCupBinding();
    const cup = world.getObjectByName('home-teacup-1')!; cup.rotation.set(.1, .2, -.15); cup.scale.set(.8, 1.2, .9); cup.updateMatrix(); cup.matrixAutoUpdate = false;
    const before = exactTransform(cup), root = new THREE.Group(), rightArm = new THREE.Group(); root.scale.setScalar(.7); root.add(rightArm); roots.push(root);
    const avatars = new Map([[1, { root, rightArm }]]), assignment = [{ actorId: 1, activity: 'tea', seatId: 'tea-1' }];
    binding.sync(world, assignment, seats, avatars); expect(cup.parent).toBe(rightArm); expect(binding.getHeld()).toEqual([1]);
    expect(cup.scale.x).toBeCloseTo(1 / .7, 8); const held = exactTransform(cup);
    binding.sync(world, assignment, seats, avatars); expect(exactTransform(cup)).toEqual(held);
    binding.restore(); binding.restore(); expect(exactTransform(cup)).toEqual(before); expect(binding.getHeld()).toEqual([]);
  });

  it.each(['stopped', 'removed-avatar'] as const)('returns a real cup to its table when the actor is %s', reason => {
    const { gathering, world, items } = fixture(), seats = collectHomeLeisureSeats(world, items, gathering), binding = createHomeTeaCupBinding();
    const cup = world.getObjectByName('home-teacup-0')!, before = exactTransform(cup), root = new THREE.Group(), rightArm = new THREE.Group(); root.add(rightArm); roots.push(root);
    const avatars = new Map([[1, { root, rightArm }]]), assignment = [{ actorId: 1, activity: 'tea', seatId: 'tea-0' }];
    binding.sync(world, assignment, seats, avatars); expect(cup.parent).toBe(rightArm);
    binding.sync(world, reason === 'stopped' ? [] : assignment, seats, reason === 'removed-avatar' ? new Map() : avatars);
    expect(exactTransform(cup)).toEqual(before); expect(binding.getHeld()).toEqual([]);
  });
});
