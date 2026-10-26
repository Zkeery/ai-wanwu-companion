import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyNaturalHouseView, buildNaturalHouse, naturalHousePlan, setNaturalHouseDoorOpenness, type NaturalSceneType } from '../lib/living-natural-house';
import { createHomeMaterials } from '../lib/living-home-materials';
import { buildForestEnvironment } from '../lib/living-forest-world';
import { buildDesertEnvironment } from '../lib/living-desert-world';
import { collectNaturalNavigationObstacles } from '../lib/living-natural-navigation';
import { createLivingNavigation } from '../lib/living-navigation';
const roots: THREE.Object3D[] = [];
function keep<T extends THREE.Object3D>(root: T): T { roots.push(root); return root; }
function upward(root: THREE.Object3D, x: number, z: number) { root.updateWorldMatrix(true, true); return new THREE.Raycaster(new THREE.Vector3(x, 2, z), new THREE.Vector3(0, -1, 0), 0, 3).intersectObject(root, true); }
function physical(root: THREE.Object3D): THREE.Mesh[] { const values: THREE.Mesh[] = []; root.traverse(o => { if (o instanceof THREE.Mesh) values.push(o); }); return values; }

function bodyAt(point: { x: number; z: number }) { return new THREE.Box3(new THREE.Vector3(point.x - .9, .01, point.z - .9), new THREE.Vector3(point.x + .9, 1.8, point.z + .9)); }
function expectTrianglesOutside(body: THREE.Box3, part: THREE.Mesh) {
  const vertices = part.geometry.getAttribute('position'), indices = part.geometry.index;
  for (let i = 0; i < (indices?.count ?? vertices.count); i += 3) {
    const points = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(vertices, indices ? indices.getX(i + k) : i + k).applyMatrix4(part.matrixWorld));
    expect(body.intersectsTriangle(new THREE.Triangle(points[0], points[1], points[2])), part.name).toBe(false);
  }
  expect(body.intersectsBox(new THREE.Box3().setFromObject(part, true)), part.name).toBe(false);
}
beforeEach(() => { vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture()); });
afterEach(() => { const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>(); for (const root of roots.splice(0)) root.traverse(o => { if (!(o instanceof THREE.Mesh)) return; geometries.add(o.geometry); for (const m of Array.isArray(o.material) ? o.material : [o.material]) { materials.add(m); for (const value of Object.values(m)) if (value instanceof THREE.Texture) textures.add(value); } }); textures.forEach(x => x.dispose()); materials.forEach(x => x.dispose()); geometries.forEach(x => x.dispose()); vi.restoreAllMocks(); });

describe.each(['forest', 'desert'] as const)('enterable %s house geometry', (scene: NaturalSceneType) => {
  it('has immutable metre-space plans with separate bounds, two supported seats and one supported bed', () => {
    const plan = naturalHousePlan(scene), root = keep(buildNaturalHouse(scene, createHomeMaterials())); expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan.portals.main.before)).toBe(true);
    expect(plan.bounds.outdoor).toEqual({ minX: scene === 'forest' ? -7 : -8, maxX: 7, minZ: -5.8, maxZ: 5.8 }); expect(plan.bounds.indoor.maxX).toBeLessThan(plan.bounds.bedroom.minX);
    expect(plan.portals.main.before.x).toBeCloseTo(plan.portals.main.after.x + .7, 8); expect(plan.portals.main.before.z).toBeGreaterThan(plan.portals.main.after.z);
    expect(plan.portals.bedroom.before.z).toBe(plan.portals.bedroom.after.z); expect(plan.portals.bedroom.before.x).toBeLessThan(plan.portals.bedroom.after.x);
    expect(plan.restSeats).toHaveLength(2); expect(Math.abs(plan.restSeats[0].z - plan.restSeats[1].z)).toBeGreaterThanOrEqual(1.75); expect(plan.beds).toHaveLength(1);
    for (const slot of [...plan.restSeats, ...plan.beds]) for (const source of slot.support) expect(root.getObjectByName(source)?.userData.naturalNavObstacle).toBe(true);
    expect(root.userData.naturalNavObstacle).toBeUndefined(); expect(root.userData.naturalHouse).toBe(true);
  });
  it('builds a Y=0 floor and real front, back, side and partition walls around an openable 1.9m passage', () => {
    const plan = naturalHousePlan(scene), root = keep(buildNaturalHouse(scene, createHomeMaterials())), floor = root.getObjectByName('natural-' + scene + '-house-floor')!;
    expect(floor.userData.naturalNavObstacle).toBeUndefined(); for (const portal of Object.values(plan.portals)) { const hits = upward(floor, portal.after.x, portal.after.z); expect(hits.length).toBeGreaterThan(0); expect(hits[0].point.y).toBeCloseTo(0, 6); }
    const walls = physical(root).filter(m => m.userData.naturalHouseWall); expect(walls.filter(m => m.userData.naturalHousePartition)).toHaveLength(3); expect(walls.filter(m => m.userData.architectureRole === 'exterior-wall').length).toBeGreaterThanOrEqual(8);
    for (const spec of plan.doors) { const door = root.getObjectByName(spec.id)!, opening = door.userData.opening; expect(opening.width).toBe(1.9); expect(opening.top).toBe(2.2); expect(door.userData.homeDoorOpenness).toBe(0); expect(door.getObjectByName(spec.id + '-leaf')?.userData.naturalNavObstacle).toBe(true); }
    expect(collectNaturalNavigationObstacles(root, null).some(b => /lintel|frame-head|floor|roof/.test(b.source))).toBe(false);
  });
  it('blocks closed doors and wall crossings, while an actual body-width path is clear only through the open leaves', () => {
    const plan = naturalHousePlan(scene), root = keep(buildNaturalHouse(scene, createHomeMaterials()));
    for (const portal of Object.values(plan.portals)) {
      const points = 'elbow' in portal ? [portal.before, portal.elbow, portal.after] : [portal.before, portal.after]; let nav = createLivingNavigation({ bounds: plan.worldBounds, blocked: collectNaturalNavigationObstacles(root, null), clearance: .9 }); expect(points.slice(1).some((to, i) => !nav.isSegmentClear(points[i], to))).toBe(true);
      setNaturalHouseDoorOpenness(root, portal.door, 1); nav = createLivingNavigation({ bounds: plan.worldBounds, blocked: collectNaturalNavigationObstacles(root, null), clearance: .78 }); for (let i = 1; i < points.length; i++) expect(nav.isSegmentClear(points[i - 1], points[i])).toBe(true);
      const door = root.getObjectByName(portal.door)!, leaf = door.getObjectByName(portal.door + '-leaf')!; expect(leaf.rotation.y).toBeCloseTo(portal.door === plan.portals.bedroom.door ? 0 : -Math.PI / 2, 8); if (portal.door === plan.portals.bedroom.door) expect(leaf.position.x).toBeCloseTo(Number(leaf.userData.naturalDoorClosedX) + plan.doors[1].width + .08, 8);
    }
    const b = plan.bounds, nav = createLivingNavigation({ bounds: plan.worldBounds, blocked: collectNaturalNavigationObstacles(root, null), clearance: .6 });
    expect(nav.isSegmentClear({ x: b.bedroom.maxX - .5, z: b.bedroom.minZ + .7 }, { x: b.bedroom.maxX + 1, z: b.bedroom.minZ + .7 })).toBe(false);
  });
  it('places each seat and mattress at a measured surface and leaves full body space in front of contact approaches', () => {
    const plan = naturalHousePlan(scene), root = keep(buildNaturalHouse(scene, createHomeMaterials()));
    for (const seat of plan.restSeats) { const pad = root.getObjectByName('natural-' + scene + '-sofa-seat-' + seat.id)!; const hit = upward(pad, seat.x, seat.z)[0]; expect(hit).toBeDefined(); expect(hit.point.y).toBeCloseTo(seat.y, 6); const b = new THREE.Box3().setFromObject(root.getObjectByName(seat.support[0])!, true); expect(seat.approach.x - b.max.x).toBeGreaterThan(.8); }
    for (const bed of plan.beds) { const mattress = root.getObjectByName('natural-' + scene + '-bed-mattress')!, hit = upward(mattress, bed.x, bed.z)[0]; expect(hit).toBeDefined(); expect(hit.point.y).toBeCloseTo(bed.y, 6); const b = new THREE.Box3().setFromObject(mattress, true); expect(b.max.x - b.min.x).toBeCloseTo(bed.width, 5); expect(b.max.z - b.min.z).toBeCloseTo(bed.length, 5); expect(bed.approach.z - b.max.z).toBeGreaterThan(1); }
  });
  it('keeps the actual cloth surface and uncovered mattress on the same physical sleeping support plane', () => {
    const plan = naturalHousePlan(scene), root = keep(buildNaturalHouse(scene, createHomeMaterials())), slot = plan.beds[0], bed = root.getObjectByName(slot.support[0])!;
    for (const [x, z] of [[0, 0], [.4, .8], [-.4, .8], [.4, 1.15], [-.4, 1.15], [.75, -.6], [-.75, -.6]]) {
      const hit = upward(bed, slot.x + x, slot.z + z)[0]; expect(hit).toBeDefined(); expect(hit.point.y).toBeCloseTo(slot.y, 6);
    }
    const cloth = bed.getObjectByName(bed.name + '-blanket') as THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
    expect(new THREE.Box3().setFromObject(cloth, true).max.y).toBeCloseTo(slot.y, 6); expect(cloth.material.polygonOffset).toBe(true); expect(cloth.userData.naturalBedTop).toBe(slot.y);
  });
  it('keeps cutaway walls physically solid and restores the complete exterior without moving furniture', () => {
    const root = keep(buildNaturalHouse(scene, createHomeMaterials())), before = collectNaturalNavigationObstacles(root, null), furniture = root.getObjectByName('natural-' + scene + '-bed')!, position = furniture.getWorldPosition(new THREE.Vector3());
    let roofs = 0; root.traverse(o => { if (o.userData.naturalHouseRoof) { roofs++; expect(o.visible).toBe(true); } }); expect(roofs).toBeGreaterThan(0);
    applyNaturalHouseView(root, 'interior', new THREE.Vector3(10, 8, 12)); root.traverse(o => { if (o.userData.naturalHouseRoof) expect(o.visible).toBe(false); });
    expect(physical(root).some(m => m.userData.naturalHouseWall && (m.material as THREE.MeshStandardMaterial).opacity < .2)).toBe(true); expect(collectNaturalNavigationObstacles(root, null)).toEqual(before); expect(furniture.getWorldPosition(new THREE.Vector3()).equals(position)).toBe(true);
    applyNaturalHouseView(root, 'exterior'); root.traverse(o => { if (o.userData.naturalHouseRoof) expect(o.visible).toBe(true); if (o instanceof THREE.Mesh && o.userData.naturalHouseWall && o.userData.homeMaterialRole !== 'glass') expect((o.material as THREE.MeshStandardMaterial).opacity).toBe(1); });
  });
  it('reaches the entrance through the complete outdoor environment and preserves every full-body landing point', () => {
    const world = keep(scene === 'forest' ? buildForestEnvironment(null, { indoor: true }) : buildDesertEnvironment(null, { indoor: true })), plan = naturalHousePlan(scene);
    for (const door of plan.doors) setNaturalHouseDoorOpenness(world, door.id, 1);
    const blocked = collectNaturalNavigationObstacles(world, null), graphs = {
      outdoor: createLivingNavigation({ bounds: plan.bounds.outdoor, blocked, clearance: .9 }),
      indoor: createLivingNavigation({ bounds: plan.bounds.indoor, blocked, clearance: .9 }),
      bedroom: createLivingNavigation({ bounds: plan.bounds.bedroom, blocked, clearance: .9 }),
    }, portalGraph = createLivingNavigation({ bounds: plan.worldBounds, blocked, clearance: .9 });
    const regionLandings = { outdoor: [plan.portals.main.before], indoor: [plan.portals.main.after, plan.portals.bedroom.before, ...plan.restSeats.map(s => s.approach)], bedroom: [plan.portals.bedroom.after, ...plan.beds.map(b => b.approach)] };
    for (const area of ['outdoor', 'indoor', 'bedroom'] as const) for (const landing of regionLandings[area]) { expect(graphs[area].findSafePoint(landing, [])).toEqual(landing); expect(graphs[area].isSegmentClear(landing, landing)).toBe(true); }
    for (const portal of Object.values(plan.portals)) { const points = 'elbow' in portal ? [portal.before, portal.elbow, portal.after] : [portal.before, portal.after]; for (let i = 1; i < points.length; i++) expect(portalGraph.isSegmentClear(points[i - 1], points[i]), JSON.stringify({ portal: portal.door, from: points[i - 1], to: points[i], nearby: blocked.filter(b => b.minX - 1 < Math.max(points[i - 1].x, points[i].x) && b.maxX + 1 > Math.min(points[i - 1].x, points[i].x) && b.minZ - 1 < Math.max(points[i - 1].z, points[i].z) && b.maxZ + 1 > Math.min(points[i - 1].z, points[i].z)) })).toBe(true); }
    const route = graphs.outdoor.planTo({ from: { x: 0, z: 1.8 }, to: plan.portals.main.before, id: 'full-body-outdoor-to-entry' });
    expect(route.blocked).toBeNull(); expect(route.safeAnchor).toEqual({ x: 0, z: 1.8 }); expect(route.points.at(-1)).toEqual(plan.portals.main.before);
    for (let i = 1; i < route.points.length; i++) expect(graphs.outdoor.isSegmentClear(route.points[i - 1], route.points[i])).toBe(true);
    for (const seat of plan.restSeats) expect(graphs.indoor.planTo({ from: plan.portals.main.after, to: seat.approach, id: 'seat-' + seat.id }).blocked).toBeNull();
    expect(graphs.indoor.planTo({ from: plan.portals.main.after, to: plan.portals.bedroom.before, id: 'indoor-room-entry' }).blocked).toBeNull();
    for (const bed of plan.beds) expect(graphs.bedroom.planTo({ from: plan.portals.bedroom.after, to: bed.approach, id: 'bed-' + bed.id }).blocked).toBeNull();
    const house = world.getObjectByName(scene === 'forest' ? 'forest-timber-cabin' : 'desert-adobe-oasis-home')!; expect(house.userData.naturalNavObstacle).toBeUndefined();
    if (scene === 'forest') { const relocated = world.getObjectByName('forest-edge-stone-7')!; expect(relocated.position.x).toBe(-7.6); expect(relocated.position.z).toBe(-2.5); expect(world.getObjectByName('forest-understory-0')!.position.toArray()).toEqual([-8, 0, -2]); }
    else { expect(world.getObjectByName('desert-native-edge-detail-0')!.position.x).toBe(-9.4); expect(world.getObjectByName('desert-native-low-shrub-3')!.position.x).toBe(-8.8); }
  });
  it('keeps the waiting body outside every 5-degree entry-door sweep and final seat contacts clear of real walls', () => {
    const world = keep(scene === 'forest' ? buildForestEnvironment(null, { indoor: true }) : buildDesertEnvironment(null, { indoor: true })), plan = naturalHousePlan(scene), entry = plan.portals.main, door = world.getObjectByName(entry.door)!, leaf = door.getObjectByName(entry.door + '-leaf')!;
    const body = new THREE.Box3(new THREE.Vector3(entry.before.x - .9, .01, entry.before.z - .9), new THREE.Vector3(entry.before.x + .9, 1.8, entry.before.z + .9));
    for (let angle = 0; angle <= 90; angle += 5) {
      setNaturalHouseDoorOpenness(world, entry.door, angle / 90);
      for (const part of physical(leaf)) {
        const vertices = part.geometry.getAttribute('position'), triangles = part.geometry.index, matrix = part.matrixWorld;
        for (let i = 0; i < (triangles?.count ?? vertices.count); i += 3) { const points = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(vertices, triangles ? triangles.getX(i + k) : i + k).applyMatrix4(matrix)); expect(body.intersectsTriangle(new THREE.Triangle(points[0], points[1], points[2]))).toBe(false); }
        expect(body.intersectsBox(new THREE.Box3().setFromObject(part, true))).toBe(false);
      }
    }
    const blocked = collectNaturalNavigationObstacles(world, null);
    for (const seat of plan.restSeats) { const contact = createLivingNavigation({ bounds: plan.bounds.indoor, blocked: blocked.filter(b => !seat.support.includes(b.source)), clearance: .81 }); expect(contact.isSegmentClear(seat, seat)).toBe(true); expect(contact.findSafePoint(seat, [])).toEqual({ x: seat.x, z: seat.z }); }
  });
  it('slides the room door along the rear partition with physical rails and recessed pulls, preserving the entry hinge', () => {
    const root = keep(buildNaturalHouse(scene, createHomeMaterials())), plan = naturalHousePlan(scene), id = plan.portals.bedroom.door, door = root.getObjectByName(id)!, leaf = door.getObjectByName(id + '-leaf')!, start = leaf.getWorldPosition(new THREE.Vector3()), closedX = leaf.position.x;
    expect(door.userData.naturalDoorMotion).toBe('slide'); expect(door.userData.naturalDoorTravel).toBeCloseTo(plan.doors[1].width + .08, 8);
    expect(door.getObjectByName(id + '-slide-rail')).toBeInstanceOf(THREE.Mesh); expect(physical(door).filter(m => m.name.includes('-roller-') && !m.name.includes('hanger'))).toHaveLength(2);
    expect(physical(door).some(m => m.name.includes('-hinge-'))).toBe(false); expect(physical(door).filter(m => m.name.includes('-pull-recess-'))).toHaveLength(2);
    const moving = physical(leaf).map(part => ({ part, position: part.position.clone() }));
    for (const amount of [0, .25, .5, .75, 1, .5, 0]) {
      setNaturalHouseDoorOpenness(root, id, amount); const actual = leaf.getWorldPosition(new THREE.Vector3());
      expect(leaf.rotation.y).toBe(0); expect(leaf.position.x).toBeCloseTo(closedX + (plan.doors[1].width + .08) * amount, 8);
      expect(actual.x).toBeCloseTo(start.x, 8); expect(actual.z).toBeCloseTo(start.z - (plan.doors[1].width + .08) * amount, 8);
      for (const { part, position } of moving) expect(part.position.equals(position)).toBe(true);
    }
    const entry = root.getObjectByName(plan.portals.main.door)!, entryLeaf = entry.getObjectByName(entry.name + '-leaf')!, hinge = entryLeaf.position.clone();
    expect(entry.userData.naturalDoorMotion).toBe('hinge'); expect(entry.userData.naturalDoorTravel).toBeUndefined();
    setNaturalHouseDoorOpenness(root, plan.portals.main.door, 1); expect(entryLeaf.rotation.y).toBeCloseTo(-Math.PI / 2, 8); expect(entryLeaf.position.equals(hinge)).toBe(true);
  });
  it('keeps both .9m waiting bodies and real walls, frames and bed clear for the entire sliding motion, then admits the same full-body route', () => {
    const root = keep(buildNaturalHouse(scene, createHomeMaterials())), plan = naturalHousePlan(scene), portal = plan.portals.bedroom, door = root.getObjectByName(portal.door)!, leaf = door.getObjectByName(portal.door + '-leaf')!, waiting = [bodyAt(portal.before), bodyAt(portal.after)];
    const surfaces = physical(root).filter(part => part.userData.naturalHouseWall || part.name.startsWith(plan.beds[0].support[0]) || (part.parent === door && /-jamb-|-frame-head$/.test(part.name)));
    for (let step = 0; step <= 40; step++) {
      setNaturalHouseDoorOpenness(root, portal.door, step / 40); root.updateWorldMatrix(true, true);
      for (const part of physical(leaf)) {
        for (const body of waiting) expectTrianglesOutside(body, part);
        const box = new THREE.Box3().setFromObject(part, true);
        for (const surface of surfaces) {
          const fixed = new THREE.Box3().setFromObject(surface, true); expect(box.intersectsBox(fixed), part.name + ' vs ' + surface.name).toBe(false);
          expectTrianglesOutside(fixed, part);
        }
      }
    }
    const nav = createLivingNavigation({ bounds: plan.worldBounds, blocked: collectNaturalNavigationObstacles(root, null), clearance: .9 });
    expect(nav.isSegmentClear(portal.before, portal.after)).toBe(true);
    for (const point of [portal.before, portal.after]) expect(nav.findSafePoint(point, [])).toEqual(point);
    const bed = plan.beds[0]; expect(new THREE.Box3().setFromObject(root.getObjectByName(bed.support[0])!, true).getCenter(new THREE.Vector3()).x).toBeCloseTo(bed.x, 8);
  });
  it('clamps and reverses the sliding leaf without moving the frame or allocating replacement mesh objects', () => {
    const root = keep(buildNaturalHouse(scene, createHomeMaterials())), plan = naturalHousePlan(scene), id = plan.portals.bedroom.door, door = root.getObjectByName(id)!, leaf = door.getObjectByName(id + '-leaf')!, start = leaf.position.clone(), frame = door.getObjectByName(id + '-jamb--1')!, frameBefore = frame.position.clone(), children = [...leaf.children];
    for (const [input, expected] of [[-1, 0], [2, 1], [NaN, 0], [Infinity, 0], [.5, .5], [1, 1], [0, 0]]) {
      setNaturalHouseDoorOpenness(root, id, input); expect(door.userData.homeDoorOpenness).toBe(expected); expect(leaf.rotation.y).toBe(0); expect(leaf.position.x).toBeCloseTo(start.x + (plan.doors[1].width + .08) * expected, 8); expect(leaf.position.z).toBe(start.z); expect(door.getObjectByName(id + '-leaf')).toBe(leaf); expect(leaf.children).toEqual(children); expect(frame.position.equals(frameBefore)).toBe(true);
    }
  });
  it('clamps malformed door values without allocating a new leaf or changing the frame', () => {
    const root = keep(buildNaturalHouse(scene, createHomeMaterials())), id = naturalHousePlan(scene).doors[0].id, group = root.getObjectByName(id)!, leaf = group.getObjectByName(id + '-leaf')!, frame = group.getObjectByName(id + '-jamb--1')!, before = frame.position.clone();
    for (const [input, expected] of [[-1, 0], [2, 1], [NaN, 0], [Infinity, 0], [.5, .5]]) { setNaturalHouseDoorOpenness(root, id, input); expect(group.userData.homeDoorOpenness).toBe(expected); expect(group.getObjectByName(id + '-leaf')).toBe(leaf); expect(frame.position.equals(before)).toBe(true); }
  });
});

it('keeps original outdoor architecture by default and makes only the new opt-in woodland context shifts', () => {
  const originalForest = keep(buildForestEnvironment(null)), indoorForest = keep(buildForestEnvironment(null, { indoor: true })), originalDesert = keep(buildDesertEnvironment(null)), indoorDesert = keep(buildDesertEnvironment(null, { indoor: true }));
  expect(originalForest.getObjectByName('forest-timber-cabin')?.userData.naturalNavObstacle).toBe(true); expect(originalForest.getObjectByName('home-main-entry-door')).toBeUndefined(); expect(originalDesert.getObjectByName('home-main-entry-door')).toBeUndefined();
  expect(indoorForest.getObjectByName('forest-timber-cabin')?.userData.naturalNavObstacle).toBeUndefined(); expect(indoorDesert.getObjectByName('home-main-entry-door')).toBeDefined();
  expect(originalForest.getObjectByName('forest-edge-tree-0')!.position.x).toBe(-7); expect(indoorForest.getObjectByName('forest-edge-tree-0')!.position.x).toBe(-7.5); expect(originalForest.getObjectByName('forest-edge-tree-8')!.position.x).toBe(0); expect(indoorForest.getObjectByName('forest-edge-tree-8')!.position.x).toBe(.8);
  expect(originalForest.getObjectByName('forest-understory-0')!.position.toArray()).toEqual([-6.4, 0, -1.8]); expect(indoorForest.getObjectByName('forest-understory-0')!.position.toArray()).toEqual([-8, 0, -2]);
  expect(indoorForest.getObjectByName('forest-canvas-tent')!.position.toArray()).toEqual(originalForest.getObjectByName('forest-canvas-tent')!.position.toArray());
});
