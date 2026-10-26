import * as THREE from 'three';
import { applyReferenceCourtyardVilla } from './living-home-reference-villa';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildHomeEnvironment } from './living-home-meshes';
import { HOME_WORLD_REGIONS, homeWorldCamera } from './living-home-world';
import { createHomeMaterials, type HomeMaterialRole } from './living-home-materials';

type Counts = { resting: number; sleeping: number };
type Slab = [number, number, number, number, number, number, number?];
export type HomeWorldArchitectureMode = 'interior' | 'exterior';
export type HomeWorldDoorId = 'home-main-entry-door' | 'home-room-connection-door' | 'home-courtyard-gate';
export type HomeWorldEnvironmentOptions = { realistic?: boolean; referenceVilla?: boolean; onTextureLoaded?: () => void };
const HOME_DOOR_OPEN_ANGLE = -68 * Math.PI / 180;

/** Rotate the existing hinge; frames, room layout and owned resources stay fixed. */
export function setHomeWorldDoorOpenness(environment: THREE.Group, id: HomeWorldDoorId, openness: number): void {
  const door = environment.getObjectByName(id);
  const leaf = door?.getObjectByName(`${id}-leaf`);
  if (!door || !leaf) return;
  const value = Number.isNaN(openness) ? 0 : Math.max(0, Math.min(1, openness));
  leaf.rotation.y = value === 0 ? 0 : HOME_DOOR_OPEN_ANGLE * value;
  door.userData.homeDoorOpenness = value;
  leaf.updateWorldMatrix(true, true);
}

/** Keep the full wall outline while making only the near upper walls see-through. */
export function applyHomeWorldArchitectureView(
  environment: THREE.Object3D,
  mode: HomeWorldArchitectureMode,
  camera: { x: number; y: number; z: number },
): void {
  environment.userData.architectureMode = mode;
  environment.traverse(object => {
    if(object.userData.referenceVillaSuperseded){object.visible=false;return;}
    if (!object.userData.architectureManaged) return;
    const role = object.userData.architectureRole;
    if (role === 'roof') object.visible = mode === 'exterior';
    else if (role === 'exterior-wall-upper') {
      const [nx, nz] = object.userData.wallNormal as [number, number];
      const origin = object.userData.wallOrigin as { x: number; z: number };
      const ghost = mode === 'interior' && (camera.x - origin.x) * nx + (camera.z - origin.z) * nz > 0;
      object.visible = true;
      object.userData.homeWallGhost = ghost;
      object.traverse(child => {
        if (!(child instanceof THREE.Mesh)) return;
        const contour = child.name.endsWith('-timber') || child.name.endsWith('-frame');
        const owned = Array.isArray(child.material) ? child.material : [child.material];
        for (const value of owned) {
          const opacity = value.userData.baseOpacity ?? 1;
          const transparent = ghost || (value.userData.baseTransparent ?? false);
          const changed = value.transparent !== transparent;
          value.opacity = ghost ? Math.min(opacity, contour ? .4 : .22) : opacity;
          value.transparent = transparent;
          value.depthWrite = ghost ? false : value.userData.baseDepthWrite ?? true;
          if (changed) value.needsUpdate = true;
        }
        child.castShadow = ghost ? false : child.userData.baseCastShadow ?? true;
      });
    } else object.visible = true;
  });
}

/** One complete cottage contains both rooms, joined to the saved courtyard by its front porch. */
export function buildHomeWorldEnvironment(season: string | null, counts: Counts, options: HomeWorldEnvironmentOptions = {}): THREE.Group {
  const world = new THREE.Group();
  world.name = 'home-world-environment';
  world.userData.modelling = 'original-procedural-volumetric';
  world.userData.continuousHome = true;
  const surfaces = options.realistic ? createHomeMaterials({ onTextureLoaded: options.onTextureLoaded }) : undefined;
  world.userData.homeMaterialMode = surfaces ? 'realistic' : 'classic';
  if (surfaces) {
    world.userData.homeTextureStatus = surfaces.status;
    world.userData.homeMaterialLibrary = surfaces;
    world.userData.homeMaterialOwnerId = surfaces.ownerId;
  }
  for (const area of ['indoor', 'bedroom', 'outdoor'] as const) {
    const region = buildHomeEnvironment(area, season, counts, { integrated: true, realistic: !!surfaces, materialLibrary: surfaces });
    const center = HOME_WORLD_REGIONS[area].center;
    region.position.set(center.x, center.y, center.z);
    region.userData.homeRegion = area;
    region.traverse(object => {
      if (object.userData.wallNormal) {
        object.userData.homeRegion = area;
        object.userData.wallOrigin = { ...center };
      }
    });
    world.add(region);
  }

  const connection = new THREE.Group();
  connection.name = 'home-continuous-veranda';
  connection.userData.connects = ['indoor', 'bedroom', 'outdoor'];
  world.add(connection);
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  function surfaceRole(parent?: THREE.Object3D): HomeMaterialRole {
    for (let object = parent; object; object = object.parent ?? undefined) {
      if (object.userData.homeMaterialRole) return object.userData.homeMaterialRole as HomeMaterialRole;
    }
    return 'plaster';
  }
  function material(color: string, parent?: THREE.Object3D, role = surfaceRole(parent)) {
    let scope = parent;
    while (scope && scope.userData.architectureRole !== 'exterior-wall-upper') scope = scope.parent ?? undefined;
    // Upper-wall materials stay attached to their meshes in every mode. This
    // isolates fading without hidden material copies outside the disposal tree.
    const key = `${scope?.uuid ?? 'shared'}:${color}`;
    if (surfaces) return surfaces.material(role, color, scope?.uuid ?? 'shared');
    let value = materials.get(key);
    if (!value) { value = new THREE.MeshStandardMaterial({ color, roughness: .87, metalness: 0 }); materials.set(key, value); }
    return value;
  }
  function finish(value: THREE.Mesh, role: HomeMaterialRole) {
    value.castShadow = true; value.receiveShadow = true;
    if (surfaces) {
      value.userData.homeMaterialRole = role; value.userData.baseCastShadow = role !== 'glass';
      value.castShadow = role !== 'glass';
    }
    return value;
  }
  function box(parent: THREE.Object3D, color: string, x: number, y: number, z: number, width: number, height: number, depth: number, role = surfaceRole(parent)) {
    const shape = new THREE.BoxGeometry(width, height, depth); surfaces?.uv(shape, role);
    const value = finish(new THREE.Mesh(shape, material(color, parent, role)), role);
    value.position.set(x, y, z); parent.add(value); return value;
  }
  function slabs(color: string, pieces: Slab[], role: HomeMaterialRole = 'paving') {
    const fragments = pieces.map(([x, y, z, width, height, depth, yaw = 0]) => {
      const value = new THREE.BoxGeometry(width, height, depth); value.rotateY(yaw); value.translate(x, y, z); return value;
    });
    const geometry = mergeGeometries(fragments, false);
    fragments.forEach(fragment => fragment.dispose());
    if (!geometry) return;
    surfaces?.uv(geometry, role);
    const value = finish(new THREE.Mesh(geometry, material(color, undefined, role)), role);
    connection.add(value); return value;
  }

  // One foundation and roof make the two unchanged room coordinate systems a single house.
  const architecture = new THREE.Group();
  architecture.name = 'home-world-architecture';
  architecture.userData.architectureRole = 'home-shell';
  architecture.userData.bounds = { minX: -11.3, maxX: 11.3, minZ: -8.3, maxZ: -.15, wallHeight: 3.3 };
  world.add(architecture);
  const foundation = box(architecture, '#97866d', 0, -.19, -4.225, 22.82, .34, 8.43, 'stone');
  foundation.name = 'home-common-foundation';
  const floorSeam = box(architecture, '#b6a080', 0, -.013, -4.2, .32, .026, 8, 'wood-floor');
  floorSeam.name = 'home-room-seam-foundation';

  function volumes(parent: THREE.Object3D, color: string, name: string, pieces: Slab[], exposedFaces?: number[], role = surfaceRole(parent)) {
    if (!pieces.length) return;
    const fragments = pieces.map(([x, y, z, width, height, depth, yaw = 0]) => {
      const part = new THREE.BoxGeometry(width, height, depth);
      if (exposedFaces) {
        const indices = part.index!;
        part.setIndex(exposedFaces.flatMap(face => Array.from({ length: 6 }, (_, i) => indices.getX(face * 6 + i))));
        part.clearGroups();
      }
      part.rotateY(yaw); part.translate(x, y, z); return part;
    });
    const shape = mergeGeometries(fragments, false);
    fragments.forEach(fragment => fragment.dispose());
    if (!shape) return;
    surfaces?.uv(shape, role);
    const value = finish(new THREE.Mesh(shape, material(color, parent, role)), role);
    // Collision consumers keep each solid separate instead of sealing door openings with the merged AABB.
    value.userData.homeJourneySlabs = pieces.map(piece => [...piece]);
    value.name = name; parent.add(value);
    return value;
  }
  function managed(name: string, role: string, parent: THREE.Object3D = architecture) {
    const group = new THREE.Group(); group.name = name;
    group.userData.architectureRole = role; group.userData.architectureManaged = true;
    parent.add(group); return group;
  }
  type Opening = { id: string; center: number; width: number; bottom: number; top: number; kind: 'door' | 'window' };
  function window(parent: THREE.Object3D, id: string, x: number, z: number, normal: [number, number], width: number) {
    const group = new THREE.Group(); group.name = `home-window-${id}`;
    group.position.set(x, 1.9, z); group.rotation.y = Math.atan2(normal[0], normal[1]);
    group.userData.architectureRole = 'window'; group.userData.homeMaterialRole = 'wood'; parent.add(group);
    const h = 1.3;
    box(group, '#abc3bd', 0, 0, .008, width, h, .055, 'glass').name = `${group.name}-glass`;
    volumes(group, '#896640', `${group.name}-frame`, [
      [-width / 2, 0, 0, .11, h + .17, .27], [width / 2, 0, 0, .11, h + .17, .27],
      [0, -h / 2, 0, width + .15, .11, .27], [0, h / 2, 0, width + .15, .11, .27],
      [0, 0, .055, .055, h, .13], [0, 0, .055, width, .055, .13],
    ]);
    volumes(group, '#d7c4a0', `${group.name}-stone-reveal`, [
      [0, -.77, .055, width + .36, .14, .46], [0, .77, -.005, width + .3, .14, .32],
    ], undefined, 'stone');
    const shutter: Slab[] = [];
    for (const side of [-1, 1]) {
      const sx = side * (width / 2 + .28);
      shutter.push([sx, 0, .15, .38, h + .08, .075]);
      for (let row = 0; row < 5; row++) shutter.push([sx, -.5 + row * .25, .2, .32, .055, .055]);
    }
    volumes(group, '#879073', `${group.name}-shutters`, shutter);
    if (surfaces && (id.endsWith('-back') || id === 'bedroom-front')) {
      box(group, '#a48b66', 0, .87, -.25, width + .85, .045, .045, 'wood').name = `${group.name}-curtain-rod`;
      for (const side of [-1, 1]) {
        const cloth = new THREE.PlaneGeometry(.42, 2.55, 8, 6), positions = cloth.getAttribute('position');
        for (let i = 0; i < positions.count; i++) {
          const x = positions.getX(i), y = positions.getY(i), down = (1.275 - y) / 2.55;
          positions.setXYZ(i, x * (1 + down * .08), y, Math.sin((x / .42 + .5) * Math.PI * 4) * .035 + down * .012);
        }
        cloth.computeVertexNormals(); surfaces.uv(cloth, 'fabric');
        const linen = surfaces.material('fabric', '#ded7c3', `${parent.uuid}:${id}:curtain`);
        linen.side = THREE.DoubleSide;
        const curtain = finish(new THREE.Mesh(cloth, linen), 'fabric');
        curtain.name = `${group.name}-curtain-${side < 0 ? 'left' : 'right'}`;
        curtain.position.set(side * (width / 2 + .1), -.425, -.25); group.add(curtain);
      }
    }
    return group;
  }
  function exteriorWall(id: string, along: 'x' | 'z', fixed: number, start: number, end: number, normal: [number, number], openings: Opening[]) {
    const low = managed(`home-exterior-${id}-low-wall`, 'exterior-wall-low');
    const upper = managed(`home-exterior-${id}-upper-wall`, 'exterior-wall-upper');
    upper.userData.wallNormal = normal;
    upper.userData.wallOrigin = { x: along === 'x' ? 0 : fixed, y: 0, z: along === 'z' ? -4.225 : fixed };
    const levels = [...new Set([0, .72, 3.3, ...openings.flatMap(o => [o.bottom, o.top])])].sort((a, b) => a - b);
    const body = new Map<THREE.Group, Slab[]>([[low, []], [upper, []]]);
    const stone = new Map<THREE.Group, Slab[][]>([[low, [[], [], [], []]], [upper, [[], [], [], []]]]);
    for (let band = 0; band < levels.length - 1; band++) {
      const bottom = levels[band], top = levels[band + 1], middle = (bottom + top) / 2;
      const parent = top <= .72 ? low : upper;
      let spans: [number, number][] = [[start, end]];
      for (const opening of openings.filter(o => middle > o.bottom && middle < o.top)) {
        const a = opening.center - opening.width / 2, b = opening.center + opening.width / 2;
        spans = spans.flatMap(([s, e]): [number, number][] => e <= a || s >= b ? [[s, e]] : [
          ...(s < a ? [[s, a] as [number, number]] : []), ...(e > b ? [[b, e] as [number, number]] : []),
        ]);
      }
      for (const [a, b] of spans) {
        const length = b - a, center = (a + b) / 2;
        body.get(parent)!.push(along === 'x' ? [center, middle, fixed, length, top - bottom, .24] : [fixed, middle, center, .24, top - bottom, length]);
        const rows = Math.ceil((top - bottom) / .32), columns = Math.ceil(length / .7);
        for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
          const width = length / columns - .027, height = (top - bottom) / rows - .025;
          const at = a + (col + .5) * length / columns, y = bottom + (row + .5) * (top - bottom) / rows;
          stone.get(parent)![(row + col * 3 + band) % 4].push(along === 'x'
            ? [at, y, fixed + normal[1] * .1125, width, height, .025]
            : [fixed + normal[0] * .1125, y, at, .025, height, width]);
        }
      }
    }
    for (const parent of [low, upper]) {
      volumes(parent, '#e3d4b5', `${parent.name}-body`, body.get(parent)!);
      // Stone color courses tessellate the solid wall surface. Faces embedded in
      // its .24 m body add no visible detail, so they do not consume triangles.
      const surface = along === 'x' ? (normal[1] > 0 ? 4 : 5) : (normal[0] > 0 ? 0 : 1);
      if (surfaces) {
        const veneer = body.get(parent)!.map(([x, y, z, w, h, d]): Slab => [x + normal[0] * .004, y, z + normal[1] * .004, w, h, d]);
        volumes(parent, '#d6c8ad', `${parent.name}-stone-realistic`, veneer, [surface], 'stone');
      } else {
        ['#c3b18f', '#d5c5a4', '#caba9c', '#d0bd9a'].forEach((color, index) => volumes(parent, color, `${parent.name}-stone-${index}`, stone.get(parent)![index], [surface]));
      }
    }
    volumes(upper, '#8b6844', `${upper.name}-timber`, along === 'x'
      ? [[(start + end) / 2, 3.25, fixed, end - start + .12, .17, .31]]
      : [[fixed, 3.25, (start + end) / 2, .31, .17, end - start + .12]], undefined, 'wood');
    for (const opening of openings.filter(o => o.kind === 'window')) {
      window(upper, opening.id, along === 'x' ? opening.center : fixed, along === 'z' ? opening.center : fixed, normal, opening.width);
    }
  }
  const entryX = -2.4;
  const entry: Opening = { id: 'main-entry', center: entryX, width: 1.8, bottom: 0, top: 2.35, kind: 'door' };
  const win = (id: string, center: number, width = 1.8): Opening => ({ id, center, width, bottom: 1.25, top: 2.55, kind: 'window' });
  exteriorWall('front', 'x', -.15, -11.3, 11.3, [0, 1], [entry, win('living-front', -9.05, 1.7), win('bedroom-front', 5.65, 2.5)]);
  exteriorWall('back', 'x', -8.3, -11.3, 11.3, [0, -1], [win('living-back', -9.3), win('bedroom-back', 2)]);
  exteriorWall('left', 'z', -11.3, -8.3, -.15, [-1, 0], [win('living-side', -4.8, 1.7)]);
  exteriorWall('right', 'z', 11.3, -8.3, -.15, [1, 0], [win('bedroom-side', -4.8, 1.7)]);

  const partition = managed('home-interior-partition', 'interior-partition');
  partition.userData.connects = ['indoor', 'bedroom'];
  const roomDoorMin = -2.2, roomDoorMax = -.85;
  volumes(partition, '#e2d2b2', 'home-interior-partition-body', [
    [0, 1.65, (-8.3 + roomDoorMin) / 2, .22, 3.3, roomDoorMin + 8.3],
    [0, 1.65, (roomDoorMax - .15) / 2, .22, 3.3, -.15 - roomDoorMax],
    [0, 2.825, (roomDoorMin + roomDoorMax) / 2, .22, .95, roomDoorMax - roomDoorMin],
  ]);
  volumes(partition, '#98764e', 'home-interior-partition-timber', [
    [0, 3.25, -4.225, .3, .16, 8.15],
    [0, 1.65, -8.22, .3, 3.3, .16], [0, 1.65, -.23, .3, 3.3, .16],
    [-.135, .09, (-8.3 + roomDoorMin) / 2, .045, .18, roomDoorMin + 8.3],
    [.135, .09, (-8.3 + roomDoorMin) / 2, .045, .18, roomDoorMin + 8.3],
    [-.135, .09, (roomDoorMax - .15) / 2, .045, .18, -.15 - roomDoorMax],
    [.135, .09, (roomDoorMax - .15) / 2, .045, .18, -.15 - roomDoorMax],
    ], undefined, 'wood');
  function door(name: HomeWorldDoorId, x: number, z: number, width: number, yaw: number, connects: string[], along: 'x' | 'z') {
    const group = managed(name, 'door'); group.position.set(x, 0, z); group.rotation.y = yaw;
    group.userData.homeMaterialRole = 'wood';
    group.userData.homeDoorId = name;
    group.userData.homeDoorOpenness = 1;
    group.userData.homeDoorClosedAngle = 0;
    group.userData.homeDoorOpenAngle = HOME_DOOR_OPEN_ANGLE;
    group.userData.connects = connects;
    group.userData.opening = { center: { x, z }, along, min: (along === 'x' ? x : z) - width / 2,
      max: (along === 'x' ? x : z) + width / 2, bottom: 0, top: 2.35, width, normal: along === 'x' ? [0, 1] : [1, 0] };
    const frame = new THREE.Group(); frame.name = `${name}-frame`; group.add(frame);
    volumes(frame, '#916b43', `${name}-frame-wood`, [
      [-width / 2 - .06, 1.175, 0, .12, 2.35, .31], [width / 2 + .06, 1.175, 0, .12, 2.35, .31],
      [0, 2.42, 0, width + .34, .14, .34],
    ]);
    volumes(frame, '#d5bd93', `${name}-frame-trim`, [
      [-width / 2 - .08, 1.18, .17, .065, 2.36, .045], [width / 2 + .08, 1.18, .17, .065, 2.36, .045],
      [0, 2.51, .02, width + .43, .055, .4], [0, .018, .015, width, .036, .4],
    ]);
    const leaf = new THREE.Group(); leaf.name = `${name}-leaf`;
    leaf.position.x = -width / 2; leaf.rotation.y = HOME_DOOR_OPEN_ANGLE; group.add(leaf);
    leaf.userData.openAngle = 68; leaf.userData.closedAngle = 0; leaf.userData.thickness = .095;
    box(leaf, '#ad8354', width / 2, 1.155, 0, width - .045, 2.29, .095).name = `${name}-panel`;
    const trim: Slab[] = [];
    for (const face of [-1, 1]) {
      for (const dx of [.11, width - .11]) trim.push([dx, 1.15, face * .06, .085, 2.12, .035]);
      for (const y of [.16, .88, 2.16]) trim.push([width / 2, y, face * .06, width - .2, .085, .035]);
      trim.push([width / 2, 1.53, face * .052, width - .34, 1.04, .02]);
    }
    volumes(leaf, '#bf9968', `${name}-panel-moulding`, trim);
    const handle = new THREE.Group(); handle.name = `${name}-handle`; leaf.add(handle);
    volumes(handle, '#b7a065', `${name}-handle-brass`, [-1, 1].flatMap((face): Slab[] => [
      [width - .17, 1.1, face * .083, .075, .22, .028], [width - .2, 1.12, face * .125, .2, .035, .05],
    ]), undefined, 'metal');
    const hinges: Slab[] = [.4, 1.17, 1.95].map(y => [0, y, .06, .055, .15, .1]);
    volumes(leaf, '#756245', `${name}-hinges`, hinges, undefined, 'metal');
    return group;
  }
  const mainEntry = door('home-main-entry-door', entryX, -.15, 1.8, 0, ['outdoor', 'indoor'], 'x');
  volumes(mainEntry, '#dcc9a7', 'home-main-entry-stone-surround', [
    [-1.055, 1.2, .035, .23, 2.4, .4], [1.055, 1.2, .035, .23, 2.4, .4],
    [0, 2.55, .04, 2.36, .2, .43], [0, .027, .25, 2.15, .054, .74],
  ], undefined, 'stone');
  door('home-room-connection-door', 0, (roomDoorMin + roomDoorMax) / 2, 1.35, -Math.PI / 2, ['indoor', 'bedroom'], 'z');

  const courtyard = managed('home-courtyard-enclosure', 'courtyard-enclosure');
  courtyard.userData.bounds = { minX: -5.45, maxX: 5.45, minZ: -.15, maxZ: 8.22, wallHeight: .9, thickness: .28, copingTop: 1.02 };
  const coping = season === 'winter' ? '#e4e7de' : '#d7c4a0';
  function courtyardWall(id: string, along: 'x' | 'z', fixed: number, start: number, end: number) {
    const group = managed(`home-courtyard-${id}-wall`, 'courtyard-wall', courtyard);
    group.userData.wallSpan = { along, fixed, start, end, height: .9, thickness: .28 };
    const center = (start + end) / 2, length = end - start;
    volumes(group, '#b9a789', `${group.name}-body`, [along === 'x'
      ? [center, .45, fixed, length, .9, .28] : [fixed, .45, center, .28, .9, length]], undefined, 'stone');
    volumes(group, coping, `${group.name}-coping`, [along === 'x'
      ? [center, .96, fixed, length + .02, .12, .4] : [fixed, .96, center, .4, .12, length + .02]], undefined, 'stone');
    const courses: Slab[][] = [[], [], [], []], rows = 3, columns = Math.ceil(length / .7);
    for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
      const at = start + (col + .5) * length / columns, y = (row + .5) * .3;
      courses[(row + col * 3) % 4].push(along === 'x'
        ? [at, y, fixed, length / columns - .025, .275, .29]
        : [fixed, y, at, .29, .275, length / columns - .025]);
    }
    if (!surfaces) ['#c3b18f', '#d5c5a4', '#caba9c', '#d0bd9a'].forEach((color, index) => volumes(
      group, color, `${group.name}-stone-${index}`, courses[index], along === 'x' ? [4, 5] : [0, 1],
    ));
  }
  courtyardWall('left', 'z', -5.45, -.15, 8.22);
  courtyardWall('right', 'z', 5.45, -.15, 8.22);
  courtyardWall('front-left', 'x', 8.22, -5.45, -.9);
  courtyardWall('front-right', 'x', 8.22, .9, 5.45);
  const entryPad = box(courtyard, '#cebc9b', 0, -.09, 9.1, 2.4, .2, 2.1, 'paving');
  entryPad.name = 'home-courtyard-entry-pad';

  const gateId: HomeWorldDoorId = 'home-courtyard-gate';
  const gate = managed(gateId, 'door', courtyard); gate.position.set(0, 0, 8.22);
  gate.userData.homeMaterialRole = 'wood';
  gate.userData.homeDoorId = gateId; gate.userData.homeDoorKind = 'courtyard-gate';
  gate.userData.homeDoorOpenness = 1;
  gate.userData.homeDoorClosedAngle = 0; gate.userData.homeDoorOpenAngle = HOME_DOOR_OPEN_ANGLE;
  gate.userData.connects = ['outdoor', 'outside'];
  gate.userData.opening = { center: { x: 0, z: 8.22 }, along: 'x', min: -.9, max: .9, bottom: 0, top: 1.15, width: 1.8, normal: [0, 1] };
  const gateFrame = new THREE.Group(); gateFrame.name = `${gateId}-frame`; gate.add(gateFrame);
  volumes(gateFrame, '#b9a789', `${gateId}-posts`, [
    [-1.1, .6, 0, .4, 1.2, .4], [1.1, .6, 0, .4, 1.2, .4],
  ], undefined, 'stone');
  volumes(gateFrame, coping, `${gateId}-post-caps`, [
    [-1.1, 1.26, 0, .52, .12, .52], [1.1, 1.26, 0, .52, .12, .52],
    [0, .025, .03, 1.8, .05, .5],
  ], undefined, 'stone');
  const gateLeaf = new THREE.Group(); gateLeaf.name = `${gateId}-leaf`;
  gateLeaf.position.x = -.9; gateLeaf.rotation.y = HOME_DOOR_OPEN_ANGLE;
  gateLeaf.userData.openAngle = 68; gateLeaf.userData.closedAngle = 0; gateLeaf.userData.thickness = .085;
  gate.add(gateLeaf);
  box(gateLeaf, '#ad8354', .9, .58, 0, 1.77, 1.08, .085).name = `${gateId}-panel`;
  const grain: Slab[] = [];
  for (let i = 1; i < 8; i++) grain.push([i * .225, .58, 0, .012, 1.01, .087]);
  volumes(gateLeaf, '#916b43', `${gateId}-plank-joints`, grain, [4, 5]);
  volumes(gateLeaf, '#bf9968', `${gateId}-rails`, [[.9, .23, -.07, 1.73, .1, .075], [.9, .92, -.07, 1.73, .1, .075]]);
  const brace = box(gateLeaf, '#bf9968', .9, .575, -.073, 1.72, .085, .075);
  brace.name = `${gateId}-brace`; brace.rotation.z = Math.atan2(.69, 1.52);
  volumes(gateLeaf, '#756245', `${gateId}-hinges`, [[0, .22, .055, .07, .14, .1], [0, .94, .055, .07, .14, .1]], undefined, 'metal');
  const gateHandle = new THREE.Group(); gateHandle.name = `${gateId}-handle`; gateLeaf.add(gateHandle);
  volumes(gateHandle, '#b7a065', `${gateId}-handle-brass`, [
    [1.62, .74, .066, .09, .19, .035], [1.57, .76, .1, .2, .035, .045],
    [1.62, .74, -.12, .09, .19, .035], [1.57, .76, -.15, .2, .035, .045],
  ], undefined, 'metal');

  const roof = managed('home-common-gabled-roof', 'roof');
  roof.userData.homeMaterialRole = 'roof';
  roof.userData.roofForm = 'single-continuous-gable';
  const porch = new THREE.Group(); porch.name = 'home-main-entry-porch-roof';
  porch.position.set(entryX, 2.8, .45); porch.rotation.x = .14; roof.add(porch);
  box(porch, '#866543', 0, 0, 0, 2.72, .14, 1.55);
  const porchTiles: Slab[] = [];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 6; col++) {
    porchTiles.push([-1.36 + (col + .5) * 2.72 / 6, .09, -.775 + (row + .5) * 1.55 / 4, .44, .065, .405]);
  }
  volumes(porch, '#aa7659', 'home-main-entry-porch-tiles', porchTiles);
  volumes(porch, '#8b6844', 'home-main-entry-porch-fascia', [[0, -.02, .79, 2.8, .18, .12]], undefined, 'wood');
  if (surfaces) {
    const lanterns = managed('home-farmhouse-eave-lanterns', 'eave-lanterns');
    lanterns.userData.homeFarmhouse = 'warm-lanterns';
    for (const side of [-1, 1]) {
      const lantern = new THREE.Group(); lantern.name = `home-farmhouse-lantern-${side < 0 ? 'left' : 'right'}`;
      lantern.position.set(entryX + side * 1.18, 2.43, .6); lanterns.add(lantern);
      const paper = new THREE.CylinderGeometry(.135, .16, .25, 8); surfaces.uv(paper, 'fabric');
      const body = finish(new THREE.Mesh(paper, surfaces.material('fabric', '#d7a05d', 'farmhouse-lantern-paper', true)), 'fabric');
      body.name = `${lantern.name}-paper`; body.castShadow = false; body.userData.baseCastShadow = false; lantern.add(body);
      for (const y of [-.14, .14]) {
        const trim = new THREE.CylinderGeometry(.15, .15, .035, 6); surfaces.uv(trim, 'wood');
        const rim = finish(new THREE.Mesh(trim, surfaces.material('wood', '#8c6744')), 'wood'); rim.position.y = y; lantern.add(rim);
      }
      const hook = new THREE.CylinderGeometry(.012, .012, .22, 4); surfaces.uv(hook, 'metal');
      const hanging = finish(new THREE.Mesh(hook, surfaces.material('metal', '#766145')), 'metal');
      hanging.position.y = .245; lantern.add(hanging);
    }
  }
  const ridgeZ = -4.225, ridgeY = 5.2, eaveY = 3.34, halfRun = 4.5;
  const slope = Math.atan2(ridgeY - eaveY, halfRun), slopeLength = Math.hypot(halfRun, ridgeY - eaveY);
  for (const side of [-1, 1]) {
    const plane = new THREE.Group(); plane.name = `home-roof-slope-${side < 0 ? 'back' : 'front'}`;
    plane.position.set(0, (ridgeY + eaveY) / 2, ridgeZ + side * halfRun / 2);
    plane.rotation.x = side * slope; roof.add(plane);
    box(plane, '#765d43', 0, 0, 0, 23.3, .16, slopeLength).name = `${plane.name}-solid`;
    const tiles: Slab[][] = [[], [], []], rows = 13, cols = 35;
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      tiles[(row + col * 2) % 3].push([-11.65 + (col + .5) * 23.3 / cols, .1 + (row % 2) * .007,
        -slopeLength / 2 + (row + .5) * slopeLength / rows, 23.3 / cols - .014, .07, slopeLength / rows + .025]);
    }
    // Every tile retains its top, sides and eave lip; the underside is buried in
    // the solid roof, and its ridge edge overlaps the next course.
    ['#9a6750', '#aa7659', '#b17e60'].forEach((color, index) => volumes(plane, color, `${plane.name}-tiles-${index}`, tiles[index], [0, 1, 2, side > 0 ? 4 : 5]));
    volumes(plane, '#86613f', `${plane.name}-fascia`, [
      [0, -.045, side * slopeLength / 2, 23.48, .2, .16],
      [-11.64, -.045, 0, .16, .2, slopeLength + .1], [11.64, -.045, 0, .16, .2, slopeLength + .1],
    ], undefined, 'wood');
  }
  box(roof, '#ad7858', 0, 5.25, ridgeZ, 23.5, .19, .28).name = 'home-roof-ridge-cap';
  const gableShape = new THREE.BufferGeometry();
  gableShape.setAttribute('position', new THREE.Float32BufferAttribute([
    -.12, 3.3, -8.3, -.12, 3.3, -.15, -.12, 5.18, ridgeZ,
    .12, 3.3, -8.3, .12, 3.3, -.15, .12, 5.18, ridgeZ,
  ], 3));
  gableShape.setIndex([0, 2, 1, 3, 4, 5, 0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 2, 0, 3, 2, 3, 5]);
  gableShape.computeVertexNormals();
  surfaces?.uv(gableShape, 'stone');
  for (const x of [-11.3, 11.3]) {
    const gable = new THREE.Mesh(gableShape, material('#d5c3a0', roof, 'stone')); gable.position.x = x;
    gable.name = `home-roof-gable-${x < 0 ? 'left' : 'right'}`;
    gable.castShadow = true; gable.receiveShadow = true; roof.add(gable);
  }
  volumes(roof, '#bda785', 'home-fireplace-chimney', [[-1.8, 4.22, -7.37, .85, 2, .75]], undefined, 'stone');
  volumes(roof, '#d7c3a0', 'home-chimney-coping', [[-1.8, 5.25, -7.37, 1.05, .18, .93]], undefined, 'stone');
  volumes(roof, '#67594a', 'home-chimney-flue', [[-1.8, 5.355, -7.37, .54, .04, .44]], undefined, 'metal');

  // The porch has one front door and one coherent approach from the courtyard.
  const veranda = box(connection, '#a08b6c', 0, -.13, .2, 22.6, .22, 1.4);
  veranda.name = 'home-veranda-foundation';
  const boards: Slab[][] = [[], [], []];
  for (let row = 0; row < 6; row++) for (let column = 0; column < 10; column++) {
    boards[(row * 3 + column) % 3].push([-10.17 + column * 2.26, -.01, -.37 + row * .225, 2.245, .02, .212]);
  }
  ['#c2a076', '#b69367', '#caae81'].forEach((color, index) => slabs(color, boards[index], 'wood'));
  box(connection, '#dfc9a5', 0, .005, .855, 22.62, .03, .11);
  for (const x of [-11.23, 11.23]) box(connection, '#c7ac80', x, .005, .2, .12, .03, 1.4);

  // A single stone path leads to the main entry, rather than two detached room entrances.
  const path: Slab[][] = [[], [], []];
  {
    const points = [[entryX, .4], [entryX, 1.35], [-1.8, 2.5], [0, 3.5]];
    connection.userData.approachPath = points.map(([x, z]) => ({ x, y: 0, z }));
    for (let segment = 0; segment < points.length - 1; segment++) {
      const [ax, az] = points[segment], [bx, bz] = points[segment + 1];
      const length = Math.hypot(bx - ax, bz - az), count = Math.ceil(length / .45), yaw = Math.atan2(bx - ax, bz - az);
      const underlay = box(connection, '#b9a180', (ax + bx) / 2, -.006, (az + bz) / 2, .82, .018, length + .03);
      underlay.rotation.y = yaw;
      for (let i = 0; i < count; i++) {
        const t = (i + .5) / count;
        path[(segment + i) % 3].push([ax + (bx - ax) * t, .012, az + (bz - az) * t, .8, .024, length / count - .026, yaw]);
      }
    }
  }
  ['#d9c7a5', '#ceb894', '#dfcfb1'].forEach((color, index) => slabs(color, path[index]));
  if (surfaces) {
    const backdrop = new THREE.Group(); backdrop.name = 'home-realistic-backdrop';
    backdrop.userData.homeBackdrop = true; world.add(backdrop);
    const ground = box(backdrop, '#9ca680', 0, -.44, 0, 70, .12, 70, 'grass');
    ground.name = 'home-realistic-grass-ground'; ground.userData.homeBackdrop = true;
    ground.userData.surfaceTop = -.38; ground.castShadow = false; ground.userData.baseCastShadow = false;
    const approach = [
      box(backdrop, '#cfc2a8', 0, -.09, 10.3, 2.2, .2, .45, 'paving'),
      box(backdrop, '#cfc2a8', 0, -.265, 10.72, 2.1, .2, .4, 'paving'),
      box(backdrop, '#cfc2a8', 0, -.365, 12.4, 1.9, .05, 3.05, 'paving'),
    ];
    approach.forEach((value, index) => { value.name = `home-realistic-outside-path-${index}`; value.userData.homeBackdrop = true; });
  }
  if(options.realistic&&options.referenceVilla)applyReferenceCourtyardVilla(world);
  const camera = homeWorldCamera('overview').position;
  applyHomeWorldArchitectureView(world, 'interior', { x: camera[0], y: camera[1], z: camera[2] });
  world.updateMatrixWorld(true);
  world.traverse(object => {
    const seats = object.userData.homeLeisureSeats as { x: number; y: number; z: number; yaw: number }[] | undefined;
    if (seats) object.userData.homeLeisureWorldSeats = seats.map(seat => {
      // References stay unresolved until the engine has placed the user's saved items.
      if (![seat.x, seat.y, seat.z].every(Number.isFinite)) return { ...seat };
      const point = object.localToWorld(new THREE.Vector3(seat.x, seat.y, seat.z));
      return { ...seat, x: point.x, y: point.y, z: point.z };
    });
    const target = object.userData.homeViewingTarget as { x: number; y: number; z: number } | undefined;
    if (target) {
      const point = object.localToWorld(new THREE.Vector3(target.x, target.y, target.z));
      object.userData.homeViewingWorldTarget = { x: point.x, y: point.y, z: point.z };
    }
    const leisureTarget = object.userData.homeLeisureTarget as { x: number; y: number; z: number } | undefined;
    if (leisureTarget) {
      const point = object.localToWorld(new THREE.Vector3(leisureTarget.x, leisureTarget.y, leisureTarget.z));
      object.userData.homeLeisureWorldTarget = { x: point.x, y: point.y, z: point.z };
    }
  });
  return world;
}
