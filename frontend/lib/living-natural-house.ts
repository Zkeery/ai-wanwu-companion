import * as THREE from 'three';
import type { HomeMaterialLibrary, HomeMaterialRole } from './living-home-materials';
import type { HomeNavBounds } from './living-home-navigation';
import type { JourneyArea, JourneyDoorId } from './living-home-journey';
import type { NavPoint } from './living-navigation';

export type NaturalSceneType = 'forest' | 'desert';
export type NaturalHousePlan = Readonly<{
  sceneType: NaturalSceneType;
  bounds: Readonly<Record<JourneyArea, HomeNavBounds>>;
  worldBounds: HomeNavBounds;
  portals: Readonly<{
    main: Readonly<{ door: 'home-main-entry-door'; before: NavPoint; elbow: NavPoint; after: NavPoint }>;
    bedroom: Readonly<{ door: 'home-room-connection-door'; before: NavPoint; after: NavPoint }>;
  }>;
  doors: readonly Readonly<{ id: JourneyDoorId; x: number; z: number; width: number; height: number; yaw: number }>[];
  restSeats: readonly Readonly<{ id: number; index: number; x: number; y: number; z: number; yaw: number; approach: NavPoint; support: readonly string[] }>[];
  beds: readonly Readonly<{ id: number; x: number; y: number; z: number; width: number; length: number; approach: NavPoint; support: readonly string[] }>[];
}>;
const frozenPoint = (x: number, z: number): NavPoint => Object.freeze({ x, z });
const frozenBounds = (minX: number, maxX: number, minZ: number, maxZ: number): HomeNavBounds => Object.freeze({ minX, maxX, minZ, maxZ });
function makePlan(sceneType: NaturalSceneType): NaturalHousePlan {
  const forest = sceneType === 'forest', front = forest ? -4.45 : -4.4, back = front - 6;
  const minX = forest ? -6.85 : -7.8, maxX = forest ? -.05 : -1.4, divider = forest ? -3.45 : -4.1;
  const mainX = forest ? -5.15 : -6.2, sofaX = forest ? -5.9 : -6.65, approachX = forest ? -4.55 : -5.35;
  const main = Object.freeze({ door: 'home-main-entry-door' as const, before: frozenPoint(mainX + .7, front + 2.8), elbow: frozenPoint(mainX, front + 1.2), after: frozenPoint(mainX, front - 1.05) });
  const bedroom = Object.freeze({ door: 'home-room-connection-door' as const, before: frozenPoint(divider - 1.05, -6.5), after: frozenPoint(divider + 1.05, -6.5) });
  return Object.freeze({ sceneType,
    bounds: Object.freeze({ outdoor: frozenBounds(forest ? -7 : -8, 7, -5.8, 5.8), indoor: frozenBounds(minX + .09, divider - .08, back + .09, front - .09), bedroom: frozenBounds(divider + .08, maxX - .09, back + .09, front - .09) }),
    worldBounds: frozenBounds(Math.min(-7, minX - .2), 7, back - .2, 5.8),
    portals: Object.freeze({ main, bedroom }),
    doors: Object.freeze([
      Object.freeze({ id: main.door, x: mainX, z: front, width: 1.9, height: 2.2, yaw: 0 }),
      Object.freeze({ id: bedroom.door, x: divider, z: -6.5, width: 1.9, height: 2.2, yaw: Math.PI / 2 }),
    ]),
    restSeats: Object.freeze([-7.65, -9.4].map((z, id) => Object.freeze({ id, index: id, x: sofaX, y: .49, z, yaw: Math.PI / 2, approach: frozenPoint(approachX, z), support: Object.freeze(['natural-' + sceneType + '-sofa']) }))),
    beds: Object.freeze([Object.freeze({ id: 0, x: forest ? -1.75 : -3, y: .52, z: -8.85, width: 1.65, length: 2.6, approach: frozenPoint(forest ? -1.75 : -3, -6.5), support: Object.freeze(['natural-' + sceneType + '-bed']) })]),
  });
}
const plans = Object.freeze({ forest: makePlan('forest'), desert: makePlan('desert') });
/** Immutable world-space coordinates. Existing saved item transforms are never rebased. */
export function naturalHousePlan(sceneType: NaturalSceneType): NaturalHousePlan { return plans[sceneType]; }

/** The widened/deepened cabin is opt-in; outdoor-only callers keep their original architecture. */
export function buildNaturalHouse(sceneType: NaturalSceneType, surfaces: HomeMaterialLibrary): THREE.Group {
  const plan = naturalHousePlan(sceneType), forest = sceneType === 'forest', prefix = 'natural-' + sceneType + '-house';
  const root = new THREE.Group(); root.name = forest ? 'forest-timber-cabin' : 'desert-adobe-oasis-home';
  const origin = new THREE.Vector3(forest ? -3.45 : -4.6, 0, forest ? -6.15 : -6.2); root.position.copy(origin);
  root.userData.naturalHouse = true; root.userData.naturalScene = sceneType; root.userData.naturalHousePlan = plan; root.userData.naturalStructure = 'enterable-' + sceneType + '-house'; root.userData.homeMaterialOwnerId = surfaces.ownerId;
  const minX = forest ? -6.85 : -7.8, maxX = forest ? -.05 : -1.4, front = forest ? -4.45 : -4.4, back = front - 6, divider = plan.doors[1].x;
  const wallRole: HomeMaterialRole = forest ? 'wood' : 'plaster', wallColor = forest ? '#826c51' : '#bfae94', trim = forest ? '#66543d' : '#806a4d';
  function material(role: HomeMaterialRole, color: string, name: string) { return surfaces.material(role, color, prefix + ':' + name); }
  function mesh(parent: THREE.Object3D, name: string, shape: THREE.BufferGeometry, role: HomeMaterialRole, color: string, at: readonly [number, number, number], solid = false, local = false) {
    surfaces.uv(shape, role); const m = new THREE.Mesh(shape, material(role, color, name)); m.name = name;
    m.position.set(...at); if (!local) m.position.sub(origin); m.castShadow = role !== 'glass'; m.receiveShadow = true;
    m.userData.homeMaterialOwnerId = surfaces.ownerId; m.userData.homeMaterialRole = role;
    if (solid) m.userData.naturalNavObstacle = true; parent.add(m); return m;
  }
  function box(parent: THREE.Object3D, name: string, x: number, y: number, z: number, w: number, h: number, d: number, role: HomeMaterialRole, color: string, solid = false, local = false) {
    return mesh(parent, name, new THREE.BoxGeometry(w, h, d), role, color, [x, y, z], solid, local);
  }
  function wall(name: string, x: number, z: number, w: number, d: number, normal: readonly [number, number], bottom = 0, top = 2.75, partition = false) {
    const value = box(root, prefix + '-wall-' + name, x, (bottom + top) / 2, z, w, top - bottom, d, wallRole, wallColor, bottom < 1.85);
    value.userData.naturalHouseWall = true; value.userData.naturalHousePartition = partition; value.userData.naturalWallNormal = normal; value.userData.architectureRole = partition ? 'interior-partition' : 'exterior-wall'; return value;
  }
  const floor = box(root, prefix + '-floor', (minX + maxX) / 2, -.045, (front + back) / 2, maxX - minX, .09, 6, forest ? 'wood-floor' : 'stone', forest ? '#927d60' : '#bbb099'); floor.userData.naturalWalkSurface = true;
  box(root, prefix + '-plinth', (minX + maxX) / 2, -.15, (front + back) / 2, maxX - minX + .12, .21, 6.12, 'stone', forest ? '#817e6c' : '#b1a58e');
  wall('back', (minX + maxX) / 2, back, maxX - minX, .18, [0, -1]);
  wall('left', minX, (back + front) / 2, .18, 6, [-1, 0]);
  wall('right', maxX, (back + front) / 2, .18, 6, [1, 0]);
  const entry = plan.doors[0], leftEdge = entry.x - entry.width / 2, rightEdge = entry.x + entry.width / 2;
  wall('front-left', (minX + leftEdge) / 2, front, leftEdge - minX, .18, [0, 1]);
  // The bedroom window remains a genuine opening, framed and glazed rather than painted on a wall.
  const windowX = (divider + maxX) / 2, windowWidth = forest ? 1.3 : 1.5, windowLeft = windowX - windowWidth / 2, windowRight = windowX + windowWidth / 2;
  wall('front-inner', (rightEdge + windowLeft) / 2, front, windowLeft - rightEdge, .18, [0, 1]);
  wall('front-right', (windowRight + maxX) / 2, front, maxX - windowRight, .18, [0, 1]);
  wall('front-lintel', entry.x, front, entry.width, .18, [0, 1], entry.height, 2.75);
  wall('window-base', windowX, front, windowWidth, .18, [0, 1], 0, .95);
  wall('window-head', windowX, front, windowWidth, .18, [0, 1], 2.15, 2.75);
  const window = box(root, prefix + '-window-glass', windowX, 1.55, front + .015, windowWidth - .1, 1.1, .035, 'glass', '#b8c8c4', true); window.userData.naturalHouseWall = true; window.userData.naturalWallNormal = [0, 1];
  for (const x of [windowLeft, windowX, windowRight]) box(root, prefix + '-window-frame-' + x, x, 1.55, front + .075, x === windowX ? .045 : .09, 1.24, .10, 'wood', trim);
  for (const y of [.95, 1.55, 2.15]) box(root, prefix + '-window-frame-' + y, windowX, y, front + .075, windowWidth + .12, .07, .10, 'wood', trim);
  box(root, prefix + '-window-sill', windowX, .90, front + .12, windowWidth + .22, .09, .30, 'stone', '#aa9d84');
  const roomDoor = plan.doors[1], roomNear = roomDoor.z + roomDoor.width / 2, roomFar = roomDoor.z - roomDoor.width / 2;
  wall('partition-front', divider, (front + roomNear) / 2, .16, front - roomNear, [1, 0], 0, 2.75, true);
  wall('partition-back', divider, (back + roomFar) / 2, .16, roomFar - back, [1, 0], 0, 2.75, true);
  wall('partition-lintel', divider, roomDoor.z, .16, roomDoor.width, [1, 0], roomDoor.height, 2.75, true);
  function door(spec: NaturalHousePlan['doors'][number]) {
    const sliding = spec.id === plan.portals.bedroom.door;
    const group = new THREE.Group(); group.name = spec.id; group.position.set(spec.x - origin.x, 0, spec.z - origin.z); group.rotation.y = spec.yaw;
    group.userData.homeDoorId = spec.id; group.userData.homeDoorOpenness = 0; group.userData.homeDoorClosedAngle = 0; group.userData.homeDoorOpenAngle = sliding ? 0 : -Math.PI / 2;
    group.userData.naturalDoorMotion = sliding ? 'slide' : 'hinge';
    if (sliding) group.userData.naturalDoorTravel = spec.width + .08;
    group.userData.opening = { center: { x: spec.x, z: spec.z }, along: spec.yaw === 0 ? 'x' : 'z', min: (spec.yaw === 0 ? spec.x : spec.z) - spec.width / 2, max: (spec.yaw === 0 ? spec.x : spec.z) + spec.width / 2, bottom: 0, top: spec.height, width: spec.width };
    root.add(group);
    for (const side of [-1, 1]) box(group, spec.id + '-jamb-' + side, side * (spec.width / 2 + .05), spec.height / 2, 0, .10, spec.height, sliding ? .16 : .25, 'wood', trim, true, true);
    box(group, spec.id + '-frame-head', 0, spec.height + .055, 0, spec.width + .30, .11, sliding ? .16 : .27, 'wood', trim, false, true);
    const leaf = new THREE.Group(); leaf.name = spec.id + '-leaf'; leaf.position.x = -spec.width / 2 - .08; leaf.userData.naturalDoorClosedX = leaf.position.x; leaf.userData.naturalNavObstacle = true; leaf.userData.homeDoorId = spec.id; group.add(leaf);
    // A compact room cannot accommodate a 1.9m hinged sweep. This 5cm sliding
    // panel runs 1cm off the partition, on a real overhead track. Its recessed
    // pulls remain within that panel depth, keeping both .9m landings clear.
    if (sliding) leaf.position.z = .115;
    box(leaf, spec.id + '-panel', spec.width / 2, spec.height / 2, 0, spec.width - .035, spec.height - .025, sliding ? .05 : .07, 'wood', trim, false, true);
    for (let i = 1; i < 10; i++) box(leaf, spec.id + '-plank-' + i, spec.width * i / 10, spec.height / 2, sliding ? .025 : .039, .009, spec.height - .10, sliding ? .002 : .012, 'wood', forest ? '#594a38' : '#6c5d46', false, true);
    if (sliding) {
      for (const sign of [-1, 1]) {
        box(leaf, spec.id + '-pull-recess-' + sign, .20, 1.05, sign * .024, .07, .23, .002, 'metal', '#41433e', false, true);
        box(leaf, spec.id + '-handle-' + sign, .20, 1.05, sign * .025, .025, .15, .002, 'metal', '#a4a196', false, true);
      }
      const travel = Number(group.userData.naturalDoorTravel);
      box(group, spec.id + '-slide-rail', travel / 2, spec.height + .10, .135, spec.width + travel + .20, .075, .10, 'metal', '#66685e', false, true);
      for (const x of [-spec.width / 2 - .08, spec.width / 2 + travel + .08]) box(group, spec.id + '-slide-stop-' + x, x, spec.height + .10, .135, .035, .12, .12, 'metal', '#46483f', false, true);
      for (const x of [.30, spec.width - .30]) {
        box(leaf, spec.id + '-roller-hanger-' + x, x, spec.height + .015, 0, .035, .15, .018, 'metal', '#62665b', false, true);
        const wheel = mesh(leaf, spec.id + '-roller-' + x, new THREE.CylinderGeometry(.035, .035, .014, 12), 'metal', '#343831', [x, spec.height + .10, 0], false, true); wheel.rotation.x = Math.PI / 2;
      }
    } else {
      for (const sign of [-1, 1]) box(leaf, spec.id + '-handle-' + sign, spec.width - .16, 1.05, sign * .065, .07, .13, .07, 'metal', '#6e6b60', false, true);
      for (const y of [.34, 1.86]) box(leaf, spec.id + '-hinge-' + y, .045, y, .04, .08, .12, .035, 'metal', '#68695f', false, true);
    }
    // The original hinge compensation also aligns the slider's closed panel
    // with the same immutable opening; sliding follows local +X = world -Z.
    for (const part of leaf.children) part.position.x += .08;
    return group;
  }
  plan.doors.forEach(door);
  if (forest) {
    const width = maxX - minX + .6, rise = 1.1, slope = Math.hypot(width / 2, rise), a = Math.atan2(rise, width / 2), cx = (minX + maxX) / 2;
    for (const sign of [-1, 1]) { const roof = box(root, prefix + '-roof-' + sign, cx + sign * width / 4, 2.82 + rise / 2, (front + back) / 2, slope, .15, 6.6, 'wood', '#60503d'); roof.rotation.z = -sign * a; roof.userData.naturalHouseRoof = true;
      for (let i = 0; i < 10; i++) { const t = (i + .5) / 10, batten = box(root, prefix + '-roof-batten-' + sign + '-' + i, cx + sign * width / 2 * t, 2.92 + rise * (1 - t), (front + back) / 2, .045, .04, 6.65, 'wood', '#635440'); batten.rotation.z = -sign * a; batten.userData.naturalHouseRoof = true; } }
    for (const z of [front, back]) { const g = new THREE.Shape(); g.moveTo(-width / 2 + .3, 0); g.lineTo(width / 2 - .3, 0); g.lineTo(0, rise); g.closePath(); const m = mesh(root, prefix + '-gable-' + z, new THREE.ExtrudeGeometry(g, { depth: .10, bevelEnabled: false }), 'wood', wallColor, [cx, 2.75, z]); m.userData.naturalHouseRoof = true; }
    box(root, prefix + '-ridge', cx, 4.0, (front + back) / 2, .12, .07, 6.75, 'metal', '#615d53').userData.naturalHouseRoof = true;
    for (let i = 0; i < 11; i++) { const y = .17 + i * .235; for (const x of [minX - .102, maxX + .102]) box(root, prefix + '-timber-lap-' + i + '-' + x, x, y, (front + back) / 2, .025, .025, 6, 'wood', '#716148'); }
  } else {
    box(root, prefix + '-roof', (minX + maxX) / 2, 2.93, (front + back) / 2, maxX - minX + .35, .22, 6.35, 'plaster', '#d0c1a6').userData.naturalHouseRoof = true;
    for (let i = 0; i < 5; i++) box(root, prefix + '-roof-beam-' + i, minX + .4 + i * (maxX - minX - .8) / 4, 2.81, (front + back) / 2, .13, .16, 6.55, 'wood', trim).userData.naturalHouseRoof = true;
    const awning = new THREE.PlaneGeometry(maxX - minX, 1.08, 12, 3); awning.rotateX(-Math.PI / 2); const p = awning.getAttribute('position'); for (let i = 0; i < p.count; i++) p.setY(i, -.12 * (1 - Math.pow(p.getX(i) / ((maxX - minX) / 2), 2))); awning.computeVertexNormals(); const cloth = mesh(root, prefix + '-awning', awning, 'fabric', '#c8bfa8', [(minX + maxX) / 2, 2.55, front + .48]); cloth.material.side = THREE.DoubleSide;
    for (const x of [minX + .25, maxX - .25]) mesh(root, prefix + '-awning-post-' + x, new THREE.CylinderGeometry(.05, .065, 2.52, 7), 'wood', trim, [x, 1.26, front + .98], true);
  }
  // Furniture is registered independently; no solid whole-building box can seal the doorway.
  const sofa = new THREE.Group(); sofa.name = 'natural-' + sceneType + '-sofa'; sofa.userData.naturalNavObstacle = true; sofa.userData.homeFurnitureKind = 'sofa';
  const sofaX = plan.restSeats[0].x, sofaZ = (plan.restSeats[0].z + plan.restSeats[1].z) / 2, sofaLength = Math.abs(plan.restSeats[0].z - plan.restSeats[1].z) + 1.59; sofa.position.set(sofaX - origin.x, 0, sofaZ - origin.z); root.add(sofa);
  box(sofa, sofa.name + '-base', 0, .24, 0, .74, .32, sofaLength, 'wood', trim, false, true);
  box(sofa, sofa.name + '-back', -.35, .66, 0, .14, .78, sofaLength, 'fabric', forest ? '#9a9e87' : '#b7af95', false, true);
  for (const seat of plan.restSeats) { const cushion = box(sofa, sofa.name + '-seat-' + seat.id, 0, .42, seat.z - sofaZ, .70, .14, 1.44, 'fabric', forest ? '#b4b7a0' : '#c4bca5', false, true); cushion.userData.naturalSeatTop = .49; }
  for (const z of [-sofaLength / 2, sofaLength / 2]) box(sofa, sofa.name + '-arm-' + z, 0, .54, z, .78, .52, .14, 'fabric', forest ? '#9a9e87' : '#b7af95', false, true);
  const slot = plan.beds[0], bed = new THREE.Group(); bed.name = 'natural-' + sceneType + '-bed'; bed.userData.naturalNavObstacle = true; bed.userData.homeFurnitureKind = 'bed'; bed.position.set(slot.x - origin.x, 0, slot.z - origin.z); root.add(bed);
  box(bed, bed.name + '-frame', 0, .28, 0, slot.width + .08, .16, slot.length + .10, 'wood', trim, false, true);
  for (const x of [-slot.width / 2 + .12, slot.width / 2 - .12]) for (const z of [-slot.length / 2 + .14, slot.length / 2 - .14]) box(bed, bed.name + '-leg-' + x + '-' + z, x, .12, z, .11, .24, .11, 'wood', trim, false, true);
  const mattress = box(bed, bed.name + '-mattress', 0, .43, 0, slot.width, .18, slot.length, 'fabric', '#e1decf', false, true); mattress.userData.naturalBedTop = .52;
  box(bed, bed.name + '-headboard', 0, .63, -slot.length / 2 - .04, slot.width + .14, .98, .11, 'wood', trim, false, true);
  box(bed, bed.name + '-pillow', 0, .59, -slot.length / 2 + .32, slot.width * .71, .14, .45, 'fabric', '#ece7da', false, true);
  // The thin blanket is inset into the soft mattress: its physical top is the
  // same support plane as plan.beds.y, rather than an unaccounted extra 3cm.
  const blanket = box(bed, bed.name + '-blanket', 0, slot.y - .015, .32, slot.width - .04, .03, slot.length * .53, 'fabric', forest ? '#9ca68b' : '#b6a786', false, true);
  blanket.userData.naturalBedTop = slot.y;
  // Flush cloth and mattress triangles share the contact plane. Depth offset
  // keeps the visible cloth stable without moving its collision surface.
  blanket.material.polygonOffset = true; blanket.material.polygonOffsetFactor = -1; blanket.material.polygonOffsetUnits = -1;
  const lamp = mesh(root, prefix + '-ceiling-light', new THREE.SphereGeometry(.14, 12, 8), 'glass', '#e6d4ae', [(minX + divider) / 2, 2.40, -7.8]); lamp.material.emissive.set('#c9b68b'); lamp.material.emissiveIntensity = .18;
  const light = new THREE.PointLight('#f4e2bc', forest ? 5 : 4, 7, 2); light.position.set((minX + divider) / 2 - origin.x, 2.35, -7.2 - origin.z); root.add(light);
  applyNaturalHouseView(root, 'exterior'); root.updateMatrixWorld(true); return root;
}

/** Reveal rooms only by a view request; physical collision is independent of visibility. */
export function applyNaturalHouseView(environment: THREE.Object3D, mode: 'interior' | 'exterior', cameraPosition?: THREE.Vector3): void {
  environment.updateWorldMatrix(true, true); const camera = cameraPosition ?? new THREE.Vector3(8, 7, 10);
  environment.traverse(object => {
    if (object.userData.naturalHouseRoof) object.visible = mode !== 'interior';
    if (!(object instanceof THREE.Mesh) || !object.userData.naturalHouseWall) return;
    const normal = object.userData.naturalWallNormal as readonly [number, number] | undefined, center = object.getWorldPosition(new THREE.Vector3());
    const near = !!normal && normal[0] * (camera.x - center.x) + normal[1] * (camera.z - center.z) > .1;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      if (material.userData.naturalHouseBaseOpacity === undefined) material.userData.naturalHouseBaseOpacity = material.opacity;
      const base = Number(material.userData.naturalHouseBaseOpacity), cutaway = mode === 'interior' && near;
      material.opacity = cutaway ? Math.min(base, .13) : base; material.transparent = cutaway || base < 1; material.depthWrite = !cutaway && base === 1; material.needsUpdate = true;
    }
  });
  environment.userData.naturalHouseView = mode;
}

export function setNaturalHouseDoorOpenness(environment: THREE.Object3D, id: JourneyDoorId, openness: number): void {
  const group = environment.getObjectByName(id), leaf = group?.getObjectByName(id + '-leaf'); if (!group || !leaf) return;
  const value = Number.isFinite(openness) ? Math.max(0, Math.min(1, openness)) : 0;
  group.userData.homeDoorOpenness = value;
  if (group.userData.naturalDoorMotion === 'slide') {
    leaf.position.x = Number(leaf.userData.naturalDoorClosedX) + Number(group.userData.naturalDoorTravel) * value;
    leaf.rotation.y = 0;
  } else leaf.rotation.y = -Math.PI / 2 * value;
  leaf.updateWorldMatrix(true, true);
}
