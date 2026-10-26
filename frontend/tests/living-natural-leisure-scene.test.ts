import * as T from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGathering } from '../lib/gatherings';
import { createHomeMaterials } from '../lib/living-home-materials';
import { buildForestEnvironment, buildForestItem } from '../lib/living-forest-world';
import { buildDesertEnvironment, buildDesertItem } from '../lib/living-desert-world';
import { buildNaturalLeisureScene, collectNaturalLeisureSeats } from '../lib/living-natural-leisure-scene';
import { naturalHousePlan } from '../lib/living-natural-house';
import { collectNaturalNavigationObstacles } from '../lib/living-natural-navigation';
import { createLivingNavigation } from '../lib/living-navigation';
import { createHomeLeisureController } from '../lib/living-home-leisure';
import { createHomeTeaCupBinding } from '../lib/living-home-leisure-scene';
import { createHomeActivityEffects } from '../lib/living-home-activity-effects';
import { disposeLivingObject } from '../lib/living-world-engine';
const roots: T.Object3D[] = [];
const keep = <O extends T.Object3D>(o: O): O => { roots.push(o); return o; };
const example = (scene: 'forest' | 'desert') => parseGathering({ id: 'synthetic-natural-leisure', title: '免费几何', closed: false, is_manager: true, invitation: null, story_enabled: false, goal: null, votes: [], stories: [], season: { current_season: 'summer' }, me: 'A', scene_type: scene, companions: [1, 2, 3].map(id => ({ id, name: '伙伴' + id, owner_id: 'A', activity: 'observe', area: 'outdoor', x: .5, y: .5 })), items: [], members: [], events: [], revision: 1 })!;
function setup(scene: 'forest' | 'desert') {
  const world = keep(scene === 'forest' ? buildForestEnvironment(null, { indoor: true, leisure: true }) : buildDesertEnvironment(null, { indoor: true, leisure: true }));
  const items = keep(new T.Group()), material = world.userData.homeMaterialLibrary;
  for (const [id, kind, x, z] of [['tree-original', 'tree', -2.8, -1.456], ['bench-original', 'bench', 2, .78]] as const) {
    const item = scene === 'forest' ? buildForestItem(kind, null, material) : buildDesertItem(kind, null, material); item.position.set(x, 0, z); item.userData.homeItemId = id;
    if (kind === 'bench') item.userData.naturalLeisureSupportId = 'natural-' + scene + '-bench-' + id;
    items.add(item);
  }
  return { world, items, g: example(scene) };
}
function hit(root: T.Object3D, x: number, z: number) { root.updateWorldMatrix(true, true); return new T.Raycaster(new T.Vector3(x, 2, z), new T.Vector3(0, -1, 0), 0, 3).intersectObject(root, true); }
beforeEach(() => { vi.spyOn(T.TextureLoader.prototype, 'load').mockImplementation(() => new T.Texture()); });
afterEach(() => { for (const root of roots.splice(0)) disposeLivingObject(root); vi.restoreAllMocks(); });

describe.each(['forest', 'desert'] as const)('%s opt-in physical tea and saved bench', scene => {
  it('adds two separated seats, actual named cups and a spout anchor with only the world material owner', () => {
    const { world, items, g } = setup(scene), slots = collectNaturalLeisureSeats(world, items, g), tea = slots.filter(s => s.station === 'tea');
    expect(tea).toHaveLength(2); expect(tea.every(s => s.available)).toBe(true);
    expect(Math.hypot(tea[0].x - tea[1].x, tea[0].z - tea[1].z)).toBeGreaterThanOrEqual(1.62);
    expect(new Set(tea.map(s => s.physicalId)).size).toBe(2); expect(new Set(tea.flatMap(s => s.support)).size).toBe(2);
    const table = world.getObjectByName('home-farmhouse-tea-table')!; expect(table.userData.homeLeisure).toBe('tea');
    table.traverse(o => { if (o instanceof T.Mesh) { expect(o.userData.homeMaterialOwnerId).toBe(world.userData.homeMaterialLibrary.ownerId); const material = o.material as T.MeshStandardMaterial; for (const texture of [material.map, material.normalMap, material.roughnessMap]) if (texture) expect(texture.userData.homeSource ?? '').not.toMatch(/^https?:/); } });
    for (const seat of tea) { const cup = world.getObjectByName(seat.cupId!)!; expect(cup.userData.homeTeaCup).toBe(true); expect(cup.userData.homeTeaCupGrip).toEqual({ x: 0, y: .0415, z: 0 }); const support = world.getObjectByName(seat.support[0])!; const hits = hit(support, seat.x, seat.z); expect(hits.length).toBeGreaterThan(0); expect(hits[0].point.y).toBeCloseTo(seat.y, 6); }
    const pot = world.getObjectByName('natural-' + scene + '-teapot')!; expect(pot.userData.homeTeaSteamAnchor.y).toBeGreaterThan(.19);
  });
  it('keeps .9m standing routes and .81m seated contact clear of the table, other chair, house and saved props', () => {
    const { world, items, g } = setup(scene), plan = naturalHousePlan(scene), slots = collectNaturalLeisureSeats(world, items, g), blocked = collectNaturalNavigationObstacles(world, items);
    for (const seat of slots) {
      expect(seat.available, seat.id).toBe(true); const filtered = blocked.filter(o => !seat.support.includes(o.source)), standing = createLivingNavigation({ bounds: plan.bounds.outdoor, blocked: filtered, clearance: .9 }), contact = createLivingNavigation({ bounds: plan.bounds.outdoor, blocked: filtered, clearance: .81 });
      expect(standing.findSafePoint(seat.approach, []), seat.id).toEqual(seat.approach); expect(contact.findSafePoint(seat, []), seat.id).toEqual({ x: seat.x, z: seat.z });
      const route = standing.planTo({ from: plan.portals.main.before, to: seat.approach, id: seat.id }); expect(route.blocked, seat.id).toBeNull(); expect(route.points.at(-1), seat.id).toEqual(seat.approach);
      for (let i = 1; i < route.points.length; i++) expect(standing.isSegmentClear(route.points[i - 1], route.points[i]), seat.id).toBe(true);
      expect(contact.isSegmentClear(seat.approach, seat), seat.id).toBe(true);
    }
  });
  it('resolves only one forward-facing physical saved-bench seat without moving any saved transform', () => {
    const { world, items, g } = setup(scene); items.rotation.y = .14; items.updateWorldMatrix(true, true); const before = items.children.map(o => ({ position: o.position.toArray(), rotation: o.rotation.toArray(), scale: o.scale.toArray(), matrix: o.matrix.toArray(), world: o.matrixWorld.toArray() }));
    const slots = collectNaturalLeisureSeats(world, items, g), bench = slots.filter(s => s.station === 'bench'); expect(bench).toHaveLength(1);
    expect(bench[0].id).toBe('natural-' + scene + '-bench-bench-original'); expect(bench[0].support).toEqual([bench[0].id]);
    const source = items.children[1], hits = hit(source, bench[0].x, bench[0].z); expect(hits.length).toBeGreaterThan(0); expect(hits[0].point.y).toBeCloseTo(bench[0].y, 6);
    const local = source.worldToLocal(new T.Vector3(bench[0].x, bench[0].y, bench[0].z)); expect(local.z).toBeCloseTo(scene === 'forest' ? .16 : -.16, 6);
    expect(items.children.map(o => ({ position: o.position.toArray(), rotation: o.rotation.toArray(), scale: o.scale.toArray(), matrix: o.matrix.toArray(), world: o.matrixWorld.toArray() }))).toEqual(before);
  });
  it('uses distinct support identities for saved benches and never aliases two bodies to one bench', () => {
    const { world, items, g } = setup(scene), source = items.children[1], another = source.clone(true); another.userData.homeItemId = 'second'; another.position.set(3.8, 0, -1.8); items.add(another);
    const benches = collectNaturalLeisureSeats(world, items, g).filter(s => s.station === 'bench'); expect(benches).toHaveLength(2); expect(new Set(benches.flatMap(s => s.support)).size).toBe(2);
    const obstacles = collectNaturalNavigationObstacles(world, items); for (const seat of benches) expect(obstacles.filter(o => seat.support.includes(o.source))).toHaveLength(1);
    const slots = collectNaturalLeisureSeats(world, keep(new T.Group()), g).filter(s => s.station === 'tea'), controller = createHomeLeisureController({ scope: { groupId: g.id, ownerId: g.me, synthetic: true, optIn: true }, actors: [{ id: 1 }, { id: 2 }, { id: 3 }], seats: slots });
    expect(controller.assign({ activity: 'tea', actorId: 1 }).ok).toBe(true); expect(controller.assign({ activity: 'tea', actorId: 2 }).ok).toBe(true); expect(controller.assign({ activity: 'tea', actorId: 3 }).ok).toBe(false);
  });
  it('disables the new tea station when a saved item intersects the real table, retaining original records and matrices', () => {
    const { world, items, g } = setup(scene), item = items.children[0]; item.position.set(-1, 0, 2.7); items.updateMatrixWorld(true); const before = item.matrixWorld.toArray(), original = JSON.stringify(g);
    const slots = collectNaturalLeisureSeats(world, items, g); expect(slots.filter(s => s.station === 'tea').every(s => s.available === false)).toBe(true); expect(item.matrixWorld.toArray()).toEqual(before); expect(JSON.stringify(g)).toBe(original);
    item.position.set(-2.8, 0, -1.456); expect(collectNaturalLeisureSeats(world, items, g).filter(s => s.station === 'tea').every(s => s.available)).toBe(true);
  });
  it('borrows the actual matching cup, preserves the occupied seat during reconciliation, and restores cup transform on release', () => {
    const { world, items, g } = setup(scene), slots = collectNaturalLeisureSeats(world, items, g), tea = slots.find(s => s.station === 'tea')!, cup = world.getObjectByName(tea.cupId!)!, parent = cup.parent!, position = cup.position.clone(), rig = { root: keep(new T.Group()), rightArm: new T.Group() }; rig.root.add(rig.rightArm);
    const controller = createHomeLeisureController({ scope: { groupId: g.id, ownerId: g.me, synthetic: true, optIn: true }, actors: [{ id: 1 }], seats: slots }); expect(controller.assign({ activity: 'tea', actorId: 1, seatId: tea.id }).ok).toBe(true);
    const binding = createHomeTeaCupBinding(); binding.sync(world, controller.getSnapshot().assignments, slots, new Map([[1, rig]])); expect(cup.parent).toBe(rig.rightArm); expect(world.getObjectByName(tea.cupId!)).toBeUndefined();
    const refreshed = collectNaturalLeisureSeats(world, items, g, controller.getSnapshot()); expect(refreshed.find(s => s.id === tea.id)).toMatchObject({ available: true, reservedByActorId: 1 });
    binding.restore(); expect(cup.parent).toBe(parent); expect(cup.position.equals(position)).toBe(true); expect(binding.getHeld()).toEqual([]);
  });
  it('drives same-origin steam and disposes its generated effect resources without disposing shared world surfaces', () => {
    const { world, items, g } = setup(scene), output = keep(new T.Scene()), effects = createHomeActivityEffects(output), slots = collectNaturalLeisureSeats(world, items, g), controller = createHomeLeisureController({ scope: { groupId: g.id, ownerId: g.me, synthetic: true, optIn: true }, actors: [], seats: slots });
    effects.update(world, new Map(), controller.getSnapshot(), slots, 0); const mist = output.getObjectByName('home-tea-steam-mist') as T.Points, first = Array.from(mist.geometry.getAttribute('position').array); effects.update(world, new Map(), controller.getSnapshot(), slots, 2); expect(Array.from(mist.geometry.getAttribute('position').array)).not.toEqual(first);
    const geom = vi.spyOn(mist.geometry, 'dispose'), material = vi.spyOn(mist.material as T.Material, 'dispose'), shared = world.getObjectByName('natural-' + scene + '-tea-table-top') as T.Mesh, sharedDispose = vi.spyOn(shared.material as T.Material, 'dispose'); effects.dispose(); expect(geom).toHaveBeenCalledTimes(1); expect(material).toHaveBeenCalledTimes(1); expect(sharedDispose).not.toHaveBeenCalled(); expect(output.getObjectByName('home-local-activity-effects')).toBeUndefined();
  });
});
it('requires both builder switches, rejects other scenes, and keeps all original default object transforms', () => {
  for (const scene of ['forest', 'desert'] as const) {
    const build = scene === 'forest' ? buildForestEnvironment : buildDesertEnvironment, old = keep(build(null, { indoor: true })), off = keep(build(null, { indoor: true, leisure: false })), withoutIndoor = keep(build(null, { leisure: true }));
    expect(old.getObjectByName('home-farmhouse-tea-table')).toBeUndefined(); expect(off.getObjectByName('home-farmhouse-tea-table')).toBeUndefined(); expect(withoutIndoor.getObjectByName('home-farmhouse-tea-table')).toBeUndefined();
    const transforms = (root: T.Object3D) => { const list: unknown[] = []; root.traverse(o => list.push([o.name, o.position.toArray(), o.rotation.toArray(), o.scale.toArray()])); return list; }; expect(transforms(off)).toEqual(transforms(old));
    const { world, items, g } = setup(scene); expect(collectNaturalLeisureSeats(world, items, { ...g, scene_type: 'home' })).toEqual([]); expect(collectNaturalLeisureSeats(null, items, g)).toEqual([]);
  }
});
it('builds the station around an unchanged identity transform and does not request any additional texture family', () => {
  const surfaces = createHomeMaterials(), station = keep(buildNaturalLeisureScene('forest', surfaces)); expect(station.position.toArray()).toEqual([-1, 0, 2.7]); const textures = new Set<T.Texture>(); station.traverse(o => { if (o instanceof T.Mesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) for (const v of Object.values(m)) if (v instanceof T.Texture) textures.add(v); }); expect(textures.size).toBeGreaterThan(0); expect(surfaces.status.failed).toBe(0);
});
