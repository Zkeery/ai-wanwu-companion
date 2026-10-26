import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { homeBedSlots } from './living-home-layout';
import { createHomeMaterials, type HomeMaterialLibrary, type HomeMaterialRole } from './living-home-materials';
import { homeLeafCluster, homePillowGeometry, homeQuiltGeometry, homeSeatCushionGeometry, type HomeLeaf } from './living-home-realistic-details';

type HomeArea = 'outdoor' | 'indoor' | 'bedroom';
type HomeCounts = { resting: number; sleeping: number };
type BoxPart = [number, number, number, number, number, number, number?];
type Color = THREE.ColorRepresentation;
type HomeEnvironmentOptions = { integrated?: boolean; realistic?: boolean; onTextureLoaded?: () => void; materialLibrary?: HomeMaterialLibrary };

/** Original, bounded, volumetric cottage scenery. The caller owns motion and disposal. */
export function buildHomeEnvironment(area: HomeArea, season: string | null, counts: HomeCounts = { resting: 0, sleeping: 0 }, options: HomeEnvironmentOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = `home-environment-${area}`;
  root.userData.modelling = 'original-procedural-volumetric';
  root.userData.floorBounds = { minX: -5.5, maxX: 5.5, minZ: -4, maxZ: 4 };
  const surfaces = options.realistic ? options.materialLibrary ?? createHomeMaterials({ onTextureLoaded: options.onTextureLoaded }) : undefined;
  root.userData.homeMaterialMode = surfaces ? 'realistic' : 'classic';
  if (surfaces) {
    root.userData.homeTextureStatus = surfaces.status;
    root.userData.homeMaterialOwnerId = surfaces.ownerId;
  }
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const geometries = new Map<string, THREE.BufferGeometry>();
  const seasonKey = ['spring', 'summer', 'autumn', 'winter'].includes(season ?? '') ? season : 'summer';
  const leafColors = seasonKey === 'autumn' ? ['#a97a42', '#cf984c', '#b9613c'] : seasonKey === 'winter' ? ['#8a9584', '#788777', '#a4afa0'] : ['#698752', '#8b9c62', '#4e714e'];
  const flowerColor = seasonKey === 'spring' ? '#e4b3aa' : seasonKey === 'autumn' ? '#d0a165' : '#e9dfbc';

  function surfaceRole(parent: THREE.Object3D): HomeMaterialRole {
    for (let object: THREE.Object3D | null = parent; object; object = object.parent) {
      if (object.userData.homeMaterialRole) return object.userData.homeMaterialRole as HomeMaterialRole;
    }
    return 'plaster';
  }
  function material(color: Color, emissive = false, role: HomeMaterialRole = 'plaster') {
    if (surfaces) return surfaces.material(role, color, 'shared', emissive);
    const key = String(color) + (emissive ? ':lit' : '');
    let value = materials.get(key);
    if (!value) {
      value = new THREE.MeshStandardMaterial({ color, roughness: emissive ? .65 : .86, metalness: 0,
        ...(emissive ? { emissive: color, emissiveIntensity: .38 } : {}) });
      materials.set(key, value);
    }
    return value;
  }
  function geometry(key: string, create: () => THREE.BufferGeometry) {
    let value = geometries.get(key);
    if (!value) { value = create(); geometries.set(key, value); }
    return value;
  }
  function mesh(parent: THREE.Object3D, shape: THREE.BufferGeometry, color: Color, x: number, y: number, z: number, emissive = false, role = surfaceRole(parent)) {
    const value = new THREE.Mesh(shape, material(color, emissive, emissive ? 'foliage' : role));
    value.position.set(x, y, z); value.castShadow = true; value.receiveShadow = true; parent.add(value);
    if (surfaces) {
      value.userData.homeMaterialRole = role;
      value.userData.baseCastShadow = role !== 'glass'; value.castShadow = role !== 'glass';
    }
    return value;
  }
  function box(parent: THREE.Object3D, color: Color, x: number, y: number, z: number, w: number, h: number, d: number, radius = 0, role = surfaceRole(parent)) {
    return mesh(parent, geometry(`box:${w}:${h}:${d}:${radius}${surfaces ? ':' + role : ''}`, () => {
      const shape = radius > 0 ? new RoundedBoxGeometry(w, h, d, 1, radius) : new THREE.BoxGeometry(w, h, d);
      surfaces?.uv(shape, role); return shape;
    }), color, x, y, z, false, role);
  }
  function cylinder(parent: THREE.Object3D, color: Color, x: number, y: number, z: number, top: number, bottom: number, height: number, segments = 12, emissive = false, role = surfaceRole(parent)) {
    return mesh(parent, geometry(`cylinder:${top}:${bottom}:${height}:${segments}${surfaces ? ':' + role : ''}`, () => {
      const shape = new THREE.CylinderGeometry(top, bottom, height, segments); surfaces?.uv(shape, role); return shape;
    }), color, x, y, z, emissive, role);
  }
  function orb(parent: THREE.Object3D, color: Color, x: number, y: number, z: number, sx: number, sy = sx, sz = sx) {
    const value = mesh(parent, geometry('foliage', () => new THREE.IcosahedronGeometry(1, 1)), color, x, y, z, false, 'foliage');
    value.scale.set(sx, sy, sz); return value;
  }
  function rod(parent: THREE.Object3D, color: Color, a: number[], b: number[], radius: number) {
    const start = new THREE.Vector3(...a as [number, number, number]), end = new THREE.Vector3(...b as [number, number, number]);
    const direction = end.clone().sub(start), center = start.clone().add(end).multiplyScalar(.5);
    const value = cylinder(parent, color, center.x, center.y, center.z, radius, radius * 1.1, direction.length(), 7, false, 'wood');
    value.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()); return value;
  }
  // Merge repeated stone/plank volumes into ordinary meshes. No instance buffers or textures
  // require cleanup beyond disposeLivingObject's deduplicated geometry/material traversal.
  function boxes(parent: THREE.Object3D, color: Color, parts: BoxPart[], role = surfaceRole(parent)) {
    if (!parts.length) return;
    const fragments = parts.map(([x, y, z, w, h, d, angle = 0]) => {
      const fragment = new THREE.BoxGeometry(w, h, d);
      fragment.rotateZ(angle); fragment.translate(x, y, z); return fragment;
    });
    const merged = mergeGeometries(fragments, false);
    fragments.forEach(fragment => fragment.dispose());
    if (merged) { surfaces?.uv(merged, role); return mesh(parent, merged, color, 0, 0, 0, false, role); }
  }
  function motion(object: THREE.Object3D, kind: 'fire' | 'leaf') {
    object.userData.localMotion = kind;
    object.userData.baseRotation = { x: object.rotation.x, y: object.rotation.y, z: object.rotation.z };
    object.userData.basePosition = { x: object.position.x, y: object.position.y, z: object.position.z };
    object.userData.baseScale = { x: object.scale.x, y: object.scale.y, z: object.scale.z };
  }
  function rememberRestTransform(object: THREE.Object3D) {
    object.userData.homeRestTransform = { parentName: object.parent?.name,
      position: { x: object.position.x, y: object.position.y, z: object.position.z },
      quaternion: { x: object.quaternion.x, y: object.quaternion.y, z: object.quaternion.z, w: object.quaternion.w },
      scale: { x: object.scale.x, y: object.scale.y, z: object.scale.z } };
  }
  function wallGroup(name: string, normal: [number, number]) {
    const group = new THREE.Group(); group.name = name; group.userData.wallNormal = normal; root.add(group); return group;
  }
  function floor(stone: boolean) {
    box(root, stone ? '#8e846d' : '#88704d', 0, -.13, 0, 11, .2, 8);
    if (surfaces) {
      const top = box(root, stone ? '#d6c7ad' : '#bda783', 0, -.014, 0, 11, .028, 8, 0, stone ? 'paving' : 'wood-floor');
      top.name = stone ? 'home-realistic-paving-floor' : 'home-realistic-wood-floor';
      top.userData.surfaceTop = 0;
    } else {
    const palettes = stone ? ['#c9b48e', '#d6c39f', '#b9aa8d', '#d4bb92'] : ['#b89264', '#c29e70', '#b18a5d', '#cba778'];
    const batches: BoxPart[][] = palettes.map(() => []);
    if (stone) {
      for (let row = 0; row < 8; row++) for (let col = 0; col < 11; col++) {
        batches[(row * 3 + col * 7) % palettes.length].push([-5 + col, -.014, -3.5 + row, .972, .028, .972]);
      }
    } else {
      for (let row = 0; row < 4; row++) for (let col = 0; col < 16; col++) {
        batches[(row * 7 + col * 3) % palettes.length].push([-5.5 + (col + .5) * .6875, -.014, -3 + row * 2, .675, .028, 1.985]);
      }
      const grain: BoxPart[] = [];
      for (let i = 0; i < 26; i++) grain.push([-5.16 + (i % 16) * .6875, .002, -3.4 + (i * 1.17) % 6.7, .009, .003, .32 + (i % 4) * .12]);
      boxes(root, '#a58256', grain);
    }
    batches.forEach((parts, i) => boxes(root, palettes[i], parts));
    }
    for (const x of [-5.43, 5.43]) box(root, stone ? '#b7a383' : '#95734c', x, .015, 0, .14, .03, 8, 0, stone ? 'stone' : 'wood');
    for (const z of [-3.93, 3.93]) box(root, stone ? '#b7a383' : '#95734c', 0, .015, z, 11, .03, .14, 0, stone ? 'stone' : 'wood');
  }
  function stonework(parent: THREE.Object3D, x: number, z: number, width: number, height: number, depth: number, side = false) {
    box(parent, '#a29378', x, height / 2, z, side ? depth : width, height, side ? width : depth, 0, 'stone');
    const palette = ['#c1b08f', '#d1c09e', '#b8a98d', '#c7b799'];
    const batches: BoxPart[][] = palette.map(() => []);
    const courses = Math.max(1, Math.ceil(height / .34)), columns = Math.max(1, Math.ceil(width / .57));
    for (let row = 0; row < courses; row++) for (let col = 0; col < columns; col++) {
      const span = width / columns, along = -width / 2 + (col + .5) * span;
      batches[(row + col * 3) % palette.length].push([side ? x : x + along, (row + .5) * height / courses, side ? z + along : z,
        side ? depth + .035 : span - .025, height / courses - .025, side ? span - .025 : depth + .035]);
    }
    batches.forEach((parts, i) => boxes(parent, palette[i], parts, 'stone'));
    box(parent, '#ddccaa', x, height + .035, z, side ? depth + .12 : width + .08, .11, side ? width + .08 : depth + .12, .025, 'stone');
  }
  function window(parent: THREE.Object3D, x: number, y: number, z: number, width: number, height: number, shutters = false) {
    const group = new THREE.Group(); group.position.set(x, y, z); group.userData.homeMaterialRole = 'wood'; parent.add(group);
    box(group, '#bad3cd', 0, 0, -.045, width, height, .045, 0, 'glass');
    for (const dx of [-width / 2, width / 2]) box(group, '#84613d', dx, 0, 0, .1, height + .18, .16);
    for (const dy of [-height / 2, height / 2]) box(group, '#a07b4b', 0, dy, 0, width + .16, .1, .16);
    box(group, '#b28c56', 0, 0, .035, .065, height, .1);
    box(group, '#b28c56', 0, 0, .035, width, .055, .1);
    box(group, '#dfcba6', 0, -height / 2 - .1, .1, width + .3, .13, .4, .025);
    for (const side of [-1, 1]) {
      if (shutters) {
        const dx = side * (width / 2 + .3);
        box(group, '#8c7850', dx, 0, -.005, .42, height + .1, .09);
        for (let i = 0; i < 5; i++) box(group, '#b2a075', dx, -height / 2 + .12 + i * (height - .12) / 5, .05, .36, .055, .065);
      } else {
        const dx = side * (width / 2 + .07);
        for (let i = 0; i < 3; i++) cylinder(group, i % 2 ? '#e9ddbd' : '#ded0af', dx + side * i * .065, -.02, .15, .06, .075, height + .08, 8);
        box(group, '#a88e60', dx + side * .06, -.12, .225, .22, .045, .04);
      }
    }
    return group;
  }
  function pottedPlant(parent: THREE.Object3D, x: number, z: number, scale = 1, y = 0) {
    const group = new THREE.Group(); group.position.set(x, y, z); group.scale.setScalar(scale); group.userData.homeMaterialRole = 'plaster'; parent.add(group);
    group.name = `room-planter-${x}-${z}`;
    const pot = new THREE.Group(); pot.name = `${group.name}-pot`; pot.userData.homeNavObstacle = true; group.add(pot);
    cylinder(pot, '#b8815e', 0, .22, 0, .22, .16, .44);
    cylinder(pot, '#d3a17b', 0, .44, 0, .24, .24, .075);
    cylinder(pot, '#65563f', 0, .48, 0, .205, .205, .025);
    const stem = rod(group, '#61734b', [0, .47, 0], [0, 1.28, 0], .022);
    stem.name = `${group.name}-stem`; stem.userData.homeNavObstacle = true;
    if (surfaces) {
      const leaves: HomeLeaf[] = [];
      for (let i = 0; i < 9; i++) {
        const angle = i * 2.4, height = .63 + i * .066, reach = .16 + i % 3 * .024;
        leaves.push({ x: Math.sin(angle) * reach, y: height, z: Math.cos(angle) * reach,
          length: .35 + (i % 3) * .035, width: .16, rx: .3 * Math.cos(angle), ry: angle, rz: .8 * Math.sin(angle) });
      }
      const foliage = homeLeafCluster(group, `${group.name}-low-foliage`, leaves, leafColors, surfaces, true);
      motion(foliage, 'leaf');
      // Narrow soil-level rim and foot ring make the ceramic pot read as a vessel.
      cylinder(pot, '#a67452', 0, .045, 0, .17, .16, .045, 12);
    } else for (let i = 0; i < 6; i++) {
      const angle = i * 2.4, length = .27 + (i % 2) * .06, height = .63 + i * .105;
      const leaf = orb(group, leafColors[i % 3], Math.sin(angle) * length * .62, height, Math.cos(angle) * length * .62, .12, .26, .055);
      leaf.userData.homeNavObstacle = true;
      leaf.rotation.set(.3 * Math.cos(angle), angle, .65 * Math.sin(angle)); motion(leaf, 'leaf');
    }
    return group;
  }
  function books(parent: THREE.Object3D, x: number, y: number, z: number, count: number) {
    const colors = ['#85947a', '#b39a74', '#b27f61', '#c2b58e', '#7f9290'];
    for (let i = 0; i < count; i++) {
      const h = .3 + (i % 3) * .055, bx = x + i * .105;
      box(parent, colors[i % colors.length], bx, y + h / 2, z, .085, h, .22, 0, 'fabric');
      box(parent, '#decdaa', bx, y + h - .06, z + .116, .065, .012, .008, 0, 'fabric');
    }
  }
  function lamp(parent: THREE.Object3D, x: number, z: number, y: number, scale = 1) {
    const group = new THREE.Group(); group.position.set(x, y, z); group.scale.setScalar(scale); group.userData.homeMaterialRole = 'metal'; parent.add(group);
    cylinder(group, '#8e7953', 0, .04, 0, .18, .22, .08);
    cylinder(group, '#8e7953', 0, .48, 0, .025, .025, .88, 8);
    cylinder(group, '#eee0b7', 0, .98, 0, .19, .31, .4, 14, false, 'fabric');
    cylinder(group, '#f4e6bb', 0, .78, 0, .29, .29, .025, 14, true);
    return group;
  }
  function roomShell() {
    floor(false);
    if (options.integrated) {
      // The continuous home owns one exterior shell. Keep furniture and wall art at
      // their original room coordinates without building a second wall behind it.
      const back = new THREE.Group(), left = new THREE.Group();
      back.name = 'room-back-furnishings'; left.name = 'room-left-furnishings';
      back.userData.architectureAttachment = 'back';
      root.add(back, left);
      return { back, left };
    }
    const back = wallGroup('room-back-wall', [0, -1]), left = wallGroup('room-left-wall', [-1, 0]);
    // A real opening in the back wall keeps the window reveal visibly three-dimensional.
    box(back, '#e7d9bb', 0, .625, -3.91, 11, 1.25, .18);
    box(back, '#e7d9bb', 0, 2.925, -3.91, 11, .75, .18);
    box(back, '#e7d9bb', -5.025, 1.9, -3.91, .95, 1.3, .18);
    box(back, '#e7d9bb', 1.375, 1.9, -3.91, 8.25, 1.3, .18);
    box(left, '#d8c7a6', -5.41, 1.35, 0, .18, 2.7, 8);
    stonework(back, 0, -3.785, 11, .5, .13);
    stonework(left, -5.285, 0, 8, .5, .13, true);
    box(back, '#8a6341', 0, 3.28, -3.8, 11, .19, .28);
    box(left, '#8a6341', -5.29, 2.68, 0, .24, .2, 8);
    for (const x of [-5.28, 5.28]) box(back, '#987047', x, 1.64, -3.77, .18, 3.28, .23);
    box(left, '#987047', -5.28, 1.34, 3.78, .18, 2.68, .18);
    window(back, -3.65, 1.9, -3.77, 1.8, 1.3);
    return { back, left };
  }
  function sofa(name: string, width: number, z: number, seats: number) {
    const group = new THREE.Group(); group.name = name; root.add(group);
    group.userData.homeMaterialRole = 'fabric';
    group.userData.homeNavObstacle = true;
    group.userData.seatSurfaceY = .72;
    group.userData.seatContactZ = z + .15;
    const seatXs = seats === 3 ? [0, -1.35, 1.35] : [-4.2, -2.8, -1.4, 0, 1.4, 2.8, 4.2];
    group.userData.homeRestSeatSpace = 'local';
    group.userData.homeRestSeats = seatXs.map((x, index) => ({ id: `${name}-rest-${index}`, x, y: .72, z: z + .5, yaw: 0 }));
    for (const x of [-width / 2 + .13, 0, width / 2 - .13]) for (const dz of [-.38, .38]) {
      if (surfaces) cylinder(group, '#775739', x, .13, z + dz, .066, .047, .26, 8, false, 'wood');
      else box(group, '#775739', x, .13, z + dz, .13, .26, .15, .02, 'wood');
    }
    box(group, '#89977a', 0, .425, z, width + .1, .35, 1.09, .075);
    let cushion: THREE.Mesh;
    if (surfaces) {
      const parts: THREE.BufferGeometry[] = [];
      for (let i = 0; i < seats; i++) {
        const minX = -width / 2 + i * width / seats + (i ? .014 : 0);
        const maxX = -width / 2 + (i + 1) * width / seats - (i < seats - 1 ? .014 : 0);
        const part = homeSeatCushionGeometry(maxX - minX, .12, 1.1);
        part.translate((minX + maxX) / 2, 0, 0); parts.push(part);
      }
      const shape = mergeGeometries(parts, false)!; parts.forEach(part => part.dispose()); surfaces.uv(shape, 'fabric');
      cushion = mesh(group, shape, '#bac3a1', 0, .66, z, false, 'fabric');
      cushion.userData.homeDetail = 'separate-seat-cushions'; cushion.userData.cushionCount = seats;
    } else cushion = box(group, '#bac3a1', 0, .66, z, width, .12, 1.1, .045);
    cushion.name = `${name}-seat`; cushion.userData.contactY = .72;
    box(group, '#a7b393', 0, 1.055, z - .59, width + .35, .79, .25, .11);
    if (surfaces) {
      const parts: THREE.BufferGeometry[] = [];
      for (let i = 0; i < seats; i++) {
        const part = homePillowGeometry(width / seats - .035, .51, .2);
        part.rotateX(-.075); part.translate(-width / 2 + (i + .5) * width / seats, 1.11, z - .435); parts.push(part);
      }
      const shape = mergeGeometries(parts, false)!; parts.forEach(part => part.dispose()); surfaces.uv(shape, 'fabric');
      const backs = mesh(group, shape, '#b8c1a0', 0, 0, 0, false, 'fabric'); backs.name = `${name}-back-cushions`;
      backs.userData.homeDetail = 'padded-back-cushions'; backs.userData.cushionCount = seats;
      box(group, '#866744', 0, .275, z + .47, width - .1, .075, .075, .012, 'wood');
    } else box(group, '#b8c1a0', 0, 1.11, z - .44, width + .05, .51, .17, .07);
    for (const side of [-1, 1]) {
      box(group, '#98a787', side * (width / 2 + .13), .72, z, .27, .64, 1.19, .085);
      box(group, '#c4c8a8', side * (width / 2 + .13), 1.035, z, .28, .06, 1.12, .028);
    }
    if (!surfaces) for (let i = 1; i < seats; i++) {
      const x = -width / 2 + i * width / seats;
      box(group, '#9ba98b', x, .723, z, .012, .003, 1.01);
      box(group, '#9ba98b', x, 1.1, z - .345, .012, .42, .006);
    }
    box(group, '#d5d4b1', 0, .652, z + .552, width - .13, .014, .008);
    box(group, '#bac3a1', 0, .363, z + .553, width - .11, .013, .008);
    return group;
  }
  function picture(parent: THREE.Object3D, x: number, y: number, z: number) {
    box(parent, '#8d6946', x, y, z, 1.22, 1.23, .09, .025);
    box(parent, '#eadfc2', x, y, z + .052, 1.08, 1.09, .025);
    rod(parent, '#77845b', [x, y - .36, z + .077], [x + .08, y + .32, z + .077], .013);
    for (let i = 0; i < 4; i++) {
      const side = i % 2 ? -1 : 1;
      const leaf = orb(parent, '#84916a', x + side * .115, y - .16 + i * .14, z + .079, .13, .055, .012);
      leaf.rotation.z = side * .5;
    }
  }
  function fireplace(parent: THREE.Object3D, x: number, z: number) {
    const group = new THREE.Group(); group.name = 'room-stone-fireplace'; group.position.set(x, 0, z); parent.add(group);
    group.userData.homeMaterialRole = 'stone';
    group.userData.homeNavObstacle = true;
    box(group, '#c7b38f', 0, .12, .08, 1.65, .24, 1.03, .035);
    for (const side of [-1, 1]) stonework(group, side * .55, 0, .34, 1.6, .62);
    box(group, '#bba987', 0, 1.48, 0, 1.35, .3, .65);
    box(group, '#8b6640', 0, 1.7, .035, 1.67, .13, .83, .025);
    box(group, '#c3b18e', 0, 2.05, -.13, .92, .6, .35);
    box(group, '#554a39', 0, .73, -.28, .78, 1.12, .06);
    for (const side of [-1, 1]) {
      const log = cylinder(group, '#86603e', side * .13, .31, .05, .075, .08, .66, 9, false, 'wood');
      log.rotation.set(Math.PI / 2, 0, side * .34);
    }
    for (let i = 0; i < 3; i++) {
      const flame = mesh(group, geometry(`fire:${i}`, () => new THREE.ConeGeometry(.13 - i * .018, .46 + (i % 2) * .16, 7)), i === 1 ? '#ffe1a1' : '#e4a055', -.22 + i * .21, .55 + (i % 2) * .06, .075, true);
      flame.rotation.z = (i - 1) * .17; motion(flame, 'fire');
    }
    for (let i = 0; i < 5; i++) cylinder(group, '#605440', -.36 + i * .18, .4, .37, .016, .016, .43, 6);
    box(group, '#605440', 0, .41, .37, .84, .025, .035);
    cylinder(group, '#dad0ad', -.48, 1.91, .02, .1, .12, .3);
    cylinder(group, '#84977c', .45, 1.87, .01, .1, .12, .22);
  }
  function bookcase(parent: THREE.Object3D, x: number, z: number) {
    const group = new THREE.Group(); group.position.set(x, 0, z); parent.add(group);
    group.name = 'room-bookcase'; group.userData.homeNavObstacle = true;
    group.userData.homeMaterialRole = 'wood';
    box(group, '#9a7850', 0, 1.16, -.2, 1.22, 2.3, .09);
    for (const side of [-1, 1]) box(group, '#b18c5c', side * .58, 1.16, 0, .09, 2.3, .52);
    for (let shelf = 0; shelf < 4; shelf++) {
      const y = .13 + shelf * .66;
      box(group, '#b58f5e', 0, y, 0, 1.22, .09, .55);
      if (shelf < 3) books(group, -.43, y + .05, .04, shelf === 1 ? 5 : 8);
    }
    cylinder(group, '#cec4a2', .27, 1.65, .06, .11, .16, .32);
    if (surfaces) {
      boxes(group, '#b58f5e', [[0, .07, .01, 1.3, .12, .61], [0, 2.34, .01, 1.31, .1, .62],
        [-.53, 1.17, .273, .035, 2.2, .025], [.53, 1.17, .273, .035, 2.2, .025]], 'wood');
      group.userData.homeDetail = 'framed-wood-cabinet';
    }
  }
  function livingRoom() {
    const { back } = roomShell();
    sofa('sofa-main', 4.4, -1.95, 3);
    if (counts.resting > 3) sofa('sofa-extra', 10, 1.25, 7);
    box(root, '#b5b49a', 0, .008, -.1, 4.6, .016, 2.5, .025, 'fabric');
    for (const x of [-2.14, 2.14]) box(root, '#d9cfad', x, .018, -.1, .035, .004, 2.22);
    for (const z of [-1.2, 1]) box(root, '#d9cfad', 0, .018, z, 4.3, .004, .035);
    picture(back, 0, 2.14, -3.76);
    fireplace(back, 3.85, -3.17);
    bookcase(back, -4.6, -3.38);
    const side = new THREE.Group(); root.add(side); side.name = 'room-side-table';
    side.userData.homeMaterialRole = 'wood';
    side.userData.homeNavObstacle = true;
    box(side, '#ba9464', -3.15, .64, -1.75, .82, .12, .72, .045);
    for (const dx of [-.29, .29]) for (const dz of [-.24, .24]) box(side, '#947047', -3.15 + dx, .3, -1.75 + dz, .075, .6, .075);
    lamp(side, -3.27, -1.9, .7, .72);
    box(side, '#889a81', -2.94, .727, -1.63, .26, .05, .29);
    cylinder(side, '#e4d7b7', -2.93, .805, -1.62, .067, .06, .12);
    if (surfaces) {
      boxes(side, '#a27c50', [[-3.15, .535, -1.455, .66, .11, .035], [-3.15, .535, -2.045, .66, .11, .035],
        [-3.49, .535, -1.75, .035, .11, .57], [-2.81, .535, -1.75, .035, .11, .57],
        [-3.15, .14, -1.75, .64, .035, .49]], 'wood');
      side.userData.homeDetail = 'joined-wood-table';
      televisionSnacks(side);
    }
    pottedPlant(root, -4.28, -.55, .94);
    pottedPlant(back, 2.16, -3.54, .55, .03);
    if (surfaces) television();
  }
  function televisionSnacks(parent: THREE.Object3D) {
    const bowl = new THREE.Group(); bowl.name = 'home-television-snack-bowl';
    bowl.position.set(-3.32, .7, -1.56); bowl.userData.homeSnackBowl = true; parent.add(bowl);
    rememberRestTransform(bowl);
    const bowlShape = new THREE.LatheGeometry([new THREE.Vector2(0, 0), new THREE.Vector2(.065, 0),
      new THREE.Vector2(.11, .065), new THREE.Vector2(.1, .075), new THREE.Vector2(.055, .014), new THREE.Vector2(0, .014)], 8);
    surfaces!.uv(bowlShape, 'plaster');
    mesh(bowl, bowlShape, '#d5d0b9', 0, 0, 0, false, 'plaster').name = 'home-television-snack-bowl-body';
    const seedShape = geometry('television-snack-seed', () => {
      const shape = new THREE.IcosahedronGeometry(1, 0); shape.scale(.012, .025, .006); surfaces!.uv(shape, 'foliage'); return shape;
    });
    for (let i = 0; i < 3; i++) {
      const seed = mesh(bowl, seedShape, '#625440', (i - 1) * .035, 0, i === 1 ? .008 : -.008, false, 'foliage');
      seed.name = `home-television-seed-${i}`; seed.rotation.z = (i - 1) * .4;
      const positions = seedShape.getAttribute('position'), point = new THREE.Vector3(); let bottom = Infinity;
      for (let vertex = 0; vertex < positions.count; vertex++) bottom = Math.min(bottom, point.fromBufferAttribute(positions, vertex).applyQuaternion(seed.quaternion).y);
      seed.position.y = .015 - bottom;
      seed.userData.homeSnackSeed = true; seed.userData.viewerIndex = i; seed.userData.homeSnackViewerIndex = i;
      rememberRestTransform(seed);
    }
  }
  function television() {
    const group = new THREE.Group(); group.name = 'home-living-television';
    group.position.set(-.6, 0, 3.7); group.userData.homeLeisure = 'television'; root.add(group);
    group.userData.homeLeisureSeatSpace = 'local';
    group.userData.homeLeisureSeats = [0, -1.35, 1.35].map((x, index) => ({
      id: `television-sofa-${index}`, source: 'sofa-main', x: x + .6, y: .72, z: -5.15,
      supportName: 'sofa-main',
      yaw: Math.atan2(-.6 - x, 3.617 + 1.45),
    }));
    group.userData.homeViewingTarget = { x: 0, y: 1.55, z: -.083 };
    group.userData.homeLeisureTarget = { ...group.userData.homeViewingTarget };
    group.userData.homeMaterialRole = 'wood';
    const console = new THREE.Group(); console.name = 'home-television-console';
    console.userData.homeNavObstacle = true; group.add(console);
    box(console, '#a17c50', 0, .43, -.11, 2.55, .62, .5, .035, 'wood');
    boxes(console, '#b79567', [[-.66, .43, -.368, 1.17, .49, .025], [.66, .43, -.368, 1.17, .49, .025],
      [0, .765, -.11, 2.63, .06, .54], [-1.04, .09, -.11, .09, .18, .36], [1.04, .09, -.11, .09, .18, .36]], 'wood');
    boxes(console, '#6e634d', [[-.13, .45, -.39, .13, .023, .018], [.13, .45, -.39, .13, .023, .018]], 'metal');
    box(group, '#34352f', 0, 1.55, -.025, 2.22, 1.28, .1, .025, 'metal');
    const screenShape = new THREE.BoxGeometry(2.09, 1.155, .012);
    const screen = new THREE.Mesh(screenShape, surfaces!.material('metal', '#34494c', `${root.uuid}:television-screen`));
    screen.position.set(0, 1.55, -.083); screen.name = 'home-television-screen';
    screen.userData.homeMaterialRole = 'metal'; screen.userData.homeLocalDisplay = true; group.add(screen);
    screen.receiveShadow = true;
    // A quiet local landscape has actual depth and needs neither a video nor a service.
    const program = new THREE.Group(); program.name = 'home-television-program'; screen.add(program);
    const sky=new THREE.Mesh(new THREE.BoxGeometry(2.04,1.11,.003),new THREE.MeshBasicMaterial({color:'#91b7c5',toneMapped:false}));sky.position.z=-.007;sky.name='home-television-local-sky';program.add(sky);
    const screenHills:BoxPart[]=[[0, -.40, -.014, 2.04, .30, .004], [-.42, -.23, -.015, 1.14, .27, .004, -.12], [.51, -.25, -.015, 1.18, .27, .004, .14]];
    const hillParts=screenHills.map(([x,y,z,w,h,d,angle=0])=>{const geometry=new THREE.BoxGeometry(w,h,d);geometry.rotateZ(angle);geometry.translate(x,y,z);return geometry;});
    const hillGeometry=mergeGeometries(hillParts,false);hillParts.forEach(geometry=>geometry.dispose());
    if(hillGeometry)program.add(new THREE.Mesh(hillGeometry,new THREE.MeshBasicMaterial({color:'#708a69',toneMapped:false})));
    const sun=new THREE.Mesh(new THREE.CircleGeometry(.085,12),new THREE.MeshBasicMaterial({color:'#f1deb0',side:THREE.DoubleSide,toneMapped:false}));sun.position.set(.59,.30,-.017);sun.name='home-television-local-sun';program.add(sun);
    box(group, '#74776d', 0, .963, -.082, .055, .012, .015, 0, 'metal');
  }
  function mahjong() {
    const group = new THREE.Group(); group.name = 'home-mahjong-table'; group.position.set(-2.4, 0, 1.35);
    group.userData.homeMaterialRole = 'wood'; group.userData.homeLeisure = 'mahjong'; root.add(group);
    const table = new THREE.Group(); table.name = 'home-mahjong-table-body'; table.userData.homeNavObstacle = true; group.add(table);
    box(table, '#a37a4f', 0, .735, 0, 1.28, .11, 1.28, .035, 'wood');
    box(table, '#728974', 0, .795, 0, 1.14, .016, 1.14, 0, 'fabric');
    const tableParts: BoxPart[] = [];
    for (const x of [-.49, .49]) for (const z of [-.49, .49]) tableParts.push([x, .34, z, .09, .68, .09]);
    for (const z of [-.54, .54]) tableParts.push([0, .635, z, 1.07, .13, .055]);
    for (const x of [-.54, .54]) tableParts.push([x, .635, 0, .055, .13, 1.07]);
    boxes(table, '#8b6846', tableParts, 'wood');
    const seats = [{ x: 0, y: .465, z: -1.035, yaw: 0 }, { x: 1.035, y: .465, z: 0, yaw: -Math.PI / 2 },
      { x: 0, y: .465, z: 1.035, yaw: Math.PI }, { x: -1.035, y: .465, z: 0, yaw: Math.PI / 2 }];
    group.userData.homeLeisureSeats = seats;
    for (let i = 0; i < seats.length; i++) {
      const seat = seats[i], chair = new THREE.Group(); chair.name = `home-mahjong-chair-${i}`;
      chair.position.set(seat.x, 0, seat.z); chair.rotation.y = seat.yaw; chair.userData.homeNavObstacle = true; group.add(chair);
      const cushion = box(chair, '#c0b18c', 0, .43, -.0775, .70, .07, .645, .025, 'fabric');
      cushion.name = `home-mahjong-chair-${i}-seat`; cushion.userData.contactY = seat.y;
      const wood: BoxPart[] = [[0, .374, -.08, .72, .045, .67], [0, .755, -.415, .72, .3, .055],
        [-.32, .617, -.415, .055, .69, .055], [.32, .617, -.415, .055, .69, .055],
        [-.32, .19, .18, .055, .38, .055], [.32, .19, .18, .055, .38, .055],
        [-.32, .19, -.37, .055, .38, .055], [.32, .19, -.37, .055, .38, .055],
        [0, .17, -.37, .64, .035, .035]];
      boxes(chair, '#b18c5d', wood, 'wood');
    }
    const tiles: BoxPart[] = [], backs: BoxPart[] = [];
    for (const side of [-1, 1]) for (let i = 0; i < 6; i++) {
      const x = -.205 + i * .082, z = side * .39;
      if (i === 0 || i === 5) {
        const seatIndex = side < 0 ? i === 0 ? 0 : 1 : i === 5 ? 2 : 3;
        const tile = new THREE.Group(); tile.name = `home-mahjong-tile-${seatIndex}`; tile.position.set(x, .833, z); group.add(tile);
        tile.userData.homeMahjongTile = true; tile.userData.homeMahjongSeatIndex = seatIndex; tile.userData.seatIndex = seatIndex;
        box(tile, '#ebe5cf', 0, 0, 0, .065, .06, .095, 0, 'plaster');
        box(tile, '#758c74', 0, .032, 0, .058, .005, .086, 0, 'foliage');
        rememberRestTransform(tile);
      } else {
        tiles.push([x, .833, z, .065, .06, .095]);
        backs.push([x, .865, z, .058, .005, .086]);
      }
    }
    const legacyTiles=boxes(group, '#ebe5cf', tiles, 'plaster'),legacyBacks=boxes(group, '#758c74', backs, 'foliage');
    if(legacyTiles)legacyTiles.name='home-mahjong-legacy-tiles';if(legacyBacks)legacyBacks.name='home-mahjong-legacy-backs';
  }
  function farmhouseCourtyard() {
    const tea = new THREE.Group(); tea.name = 'home-farmhouse-tea-table';
    tea.position.set(2.35, 0, 1.85); tea.userData.homeFarmhouse = 'tea'; tea.userData.homeLeisure = 'tea';
    tea.userData.homeMaterialRole = 'wood'; root.add(tea);
    tea.userData.homeLeisureSeatSpace = 'local';
    tea.userData.homeLeisureSeats = [
      { id: 'tea-bench-0', source: 'saved-bench', referenceKind: 'bench', referenceSeatIndex: 0 },
      { id: 'tea-stool-0', source: 'built-in', supportName: 'home-tea-stool', x: 0, y: .465, z: -1.55, yaw: 0 },
    ];
    tea.userData.homeLeisureTarget = { x: 0, y: .83, z: 0 };
    tea.userData.homeLeisureTableSurfaceY = .73;
    const stool = new THREE.Group(); stool.name = 'home-tea-stool'; stool.position.z = -1.55;
    stool.userData.homeNavObstacle = true; stool.userData.homeRestSeatSpace = 'local';
    stool.userData.homeRestSeats = [{ id: 'tea-stool-0', x: 0, y: .465, z: 0, yaw: -Math.PI / 2 }]; tea.add(stool);
    const stoolSeat = cylinder(stool, '#b38c5b', 0, .43, 0, .21, .21, .07, 8, false, 'wood');
    stoolSeat.name = 'home-tea-stool-seat'; stoolSeat.userData.contactY = .465;
    const stoolParts: BoxPart[] = [];
    for (const x of [-.13, .13]) for (const z of [-.13, .13]) stoolParts.push([x, .2, z, .045, .4, .045]);
    stoolParts.push([0, .16, -.13, .26, .035, .035], [0, .16, .13, .26, .035, .035]);
    boxes(stool, '#92704b', stoolParts, 'wood');
    const body = new THREE.Group(); body.name = 'home-farmhouse-tea-table-body'; body.userData.homeNavObstacle = true; tea.add(body);
    box(body, '#b18b5d', 0, .685, 0, 1.08, .09, .72, 0, 'wood');
    const joinery: BoxPart[] = [];
    for (const x of [-.43, .43]) for (const z of [-.25, .25]) joinery.push([x, .32, z, .075, .64, .075]);
    for (const z of [-.285, .285]) joinery.push([0, .59, z, .89, .1, .045]);
    for (const x of [-.46, .46]) joinery.push([x, .59, 0, .045, .1, .55]);
    boxes(body, '#92704b', joinery, 'wood');
    box(tea, '#8e6d49', 0, .744, 0, .65, .028, .4, 0, 'wood');
    const bodyShape = new THREE.LatheGeometry([new THREE.Vector2(0, 0), new THREE.Vector2(.06, 0),
      new THREE.Vector2(.105, .035), new THREE.Vector2(.1, .13), new THREE.Vector2(.06, .17), new THREE.Vector2(0, .17)], 6);
    bodyShape.translate(-.08, .759, 0);
    const lid = new THREE.CylinderGeometry(.063, .073, .022, 6); lid.translate(-.08, .933, 0);
    const handle = new THREE.TorusGeometry(.067, .013, 4, 6, Math.PI * 1.5); handle.rotateZ(Math.PI / 4); handle.translate(-.18, .848, 0);
    const spout = new THREE.CylinderGeometry(.017, .032, .14, 6); spout.rotateZ(-.72); spout.translate(.045, .86, 0);
    const teapotParts = [bodyShape, lid, handle, spout], teapotShape = mergeGeometries(teapotParts, false)!;
    teapotParts.forEach(part => part.dispose()); surfaces!.uv(teapotShape, 'plaster');
    const teapot = mesh(tea, teapotShape, '#87917b', 0, 0, 0, false, 'plaster'); teapot.name = 'home-farmhouse-teapot';
    const mouthX = .045 + Math.sin(.72) * .07, mouthY = .86 + Math.cos(.72) * .07;
    teapot.userData.homeTeaSteamAnchor = { x: mouthX, y: mouthY + .02, z: 0 };
    for (let i = 0; i < 2; i++) {
      const cupShape = new THREE.LatheGeometry([new THREE.Vector2(.034, 0), new THREE.Vector2(.052, .083),
        new THREE.Vector2(.045, .083), new THREE.Vector2(.028, .016), new THREE.Vector2(0, .016)], 8);
      surfaces!.uv(cupShape, 'plaster');
      const cup = mesh(tea, cupShape, '#d5d0b9', .17, .759, i ? .1 : -.1, false, 'plaster');
      cup.name = `home-teacup-${i}`; cup.userData.homeTeaCup = true;
      cup.userData.homeTeaCupGrip = { x: 0, y: .0415, z: 0 };
      cup.userData.homeRestTransform = { parentName: tea.name,
        position: { x: cup.position.x, y: cup.position.y, z: cup.position.z },
        quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } };
    }
    for (const side of [-1, 1]) {
      const planter = new THREE.Group(); planter.name = `home-farmhouse-planter-${side < 0 ? 'left' : 'right'}`;
      planter.position.set(side * 4.1, 0, 2.85); planter.userData.homeFarmhouse = 'vegetable-planter';
      planter.userData.homeNavObstacle = true; root.add(planter);
      boxes(planter, '#a17b51', [[0, .04, 0, 1.18, .06, .42], [0, .23, -.19, 1.18, .34, .045],
        [0, .23, .19, 1.18, .34, .045], [-.56, .23, 0, .05, .34, .34], [.56, .23, 0, .05, .34, .34],
        [0, .41, -.205, 1.22, .04, .055], [0, .41, .205, 1.22, .04, .055]], 'wood');
      box(planter, '#66543d', 0, .368, 0, 1.06, .025, .32, 0, 'foliage');
      const leaves: HomeLeaf[] = [-1, 0, 1].map((x, i) => ({ x: x * .34, y: .53, z: i % 2 ? .025 : -.025,
        length: .32 + i % 2 * .06, width: .24, rx: -.16 + i * .16, ry: i * 2.4, rz: x * .24 }));
      homeLeafCluster(planter, `${planter.name}-herbs`, leaves, ['#74865b', '#8e9b6e'], surfaces);
    }
  }
  function bedroom() {
    const { back } = roomShell();
    picture(back, .1, 2.1, -3.76);
    const slots = homeBedSlots(counts.sleeping);
    for (const slot of slots) {
      const bed = new THREE.Group(); bed.name = `room-bed-${slot.id}`;
      bed.userData.homeMaterialRole = 'wood';
      bed.userData.homeNavObstacle = true;
      bed.position.set(slot.x, 0, slot.z); root.add(bed);
      bed.userData.mattressTop = slot.y;
      const width = slot.width, length = slot.length;
      for (const side of [-1, 1]) for (const end of [-1, 1]) {
        if (surfaces) cylinder(bed, '#8d6741', side * (width / 2 - .1), .14, end * (length / 2 - .14), .07, .05, .28, 8, false, 'wood');
        else box(bed, '#8d6741', side * (width / 2 - .1), .14, end * (length / 2 - .14), .12, .28, .14, .02);
      }
      box(bed, '#ac8355', 0, .35, 0, width + .12, .23, length + .13, .055);
      box(bed, '#d3b187', 0, .47, 0, width + .14, .055, length + .14, .02);
      const mattress = box(bed, '#eee5ce', 0, slot.y - .12, 0, width, .24, length, .085, 'fabric');
      mattress.name = `room-bed-${slot.id}-mattress`;
      box(bed, '#f6edda', 0, slot.y - .045, 0, width + .012, .04, length + .012, .018, 'fabric');
      box(bed, '#a47b4f', 0, .86, -length / 2 - .075, width + .18, 1.16, .13, .055);
      box(bed, '#c9aa7d', 0, .95, -length / 2 + .005, width - .1, .58, .035, .015);
      box(bed, '#dec299', 0, 1.435, -length / 2 - .07, width + .24, .055, .18, .02);
      const pillowCount = width > 1.8 ? 2 : 1;
      for (let i = 0; i < pillowCount; i++) {
        const px = pillowCount === 1 ? 0 : (i - .5) * width * .43;
        if (surfaces) {
          const shape = homePillowGeometry(width * (pillowCount === 1 ? .71 : .39), .17, .54); surfaces.uv(shape, 'fabric');
          const pillow = mesh(bed, shape, '#f4ecd7', px, slot.y + .085, -length * .335, false, 'fabric');
          pillow.name = `room-bed-${slot.id}-pillow-${i}`; pillow.userData.homeDetail = 'padded-pillow';
        } else box(bed, '#f4ecd7', px, slot.y + .085, -length * .335, width * (pillowCount === 1 ? .71 : .39), .17, .54, .075, 'fabric');
      }
      // A folded, thin foot quilt leaves the head, hands and most of the body visible.
      if (surfaces) {
        const shape = homeQuiltGeometry(width + .035, .07, length * .34); surfaces.uv(shape, 'fabric');
        const quilt = mesh(bed, shape, slot.id % 2 ? '#aab79b' : '#b3bda3', 0, slot.y + .035, length * .295, false, 'fabric');
        quilt.name = `room-bed-${slot.id}-foot-quilt`; quilt.userData.homeDetail = 'folded-quilt';
      } else box(bed, slot.id % 2 ? '#aab79b' : '#b3bda3', 0, slot.y + .035, length * .295, width + .035, .07, length * .34, .025, 'fabric');
      box(bed, '#d1d3b3', 0, slot.y + .072, length * .15, width + .03, .012, .08, .005, 'fabric');
      for (const side of [-1, 1]) box(bed, '#9cae90', side * (width / 2 + .025), slot.y - .075, length * .295, .04, .23, length * .34, .015, 'fabric');
      const tableSide = slot.x > 0 ? 1 : -1;
      const tableX = slot.x + tableSide * (width / 2 + .22), tableZ = slot.z - length * .31;
      if (Math.abs(tableX) + .16 < 5.3) {
        const table = new THREE.Group(); table.name = `room-bedside-table-${slot.id}`;
        table.userData.homeMaterialRole = 'wood'; table.userData.homeNavObstacle = true; root.add(table);
        box(table, '#bd9869', tableX, .39, tableZ, .32, .7, .48, .025);
        box(table, '#d8b98b', tableX, .75, tableZ, .36, .045, .51, .015);
        box(table, '#a08054', tableX, .48, tableZ + .246, .26, .014, .008);
        cylinder(table, '#8d7750', tableX, .52, tableZ + .256, .022, .022, .028, 8).rotation.x = Math.PI / 2;
        if (slots.length <= 4) lamp(table, tableX, tableZ, .775, .34);
        if (surfaces) {
          boxes(table, '#9b784e', [[tableX, .105, tableZ + .237, .27, .065, .018],
            [tableX - .13, .385, tableZ + .245, .018, .53, .025], [tableX + .13, .385, tableZ + .245, .018, .53, .025]], 'wood');
          table.userData.homeDetail = 'framed-bedside-cabinet';
        }
      }
    }
    if (slots.length < 5) pottedPlant(root, 4.75, -2.97, .78);
  }
  function outdoor() {
    floor(true);
    const house = options.integrated ? null : new THREE.Group();
    if (house) {
      house.name = 'courtyard-stone-cottage'; root.add(house);
      stonework(house, -1.2, -3.55, 5.8, 2.65, 1.3);
      const gable = new THREE.Shape(); gable.moveTo(-2.9, 0); gable.lineTo(2.9, 0); gable.lineTo(0, 1.2); gable.closePath();
      const gableMesh = mesh(house, new THREE.ExtrudeGeometry(gable, { depth: 1.42, bevelEnabled: false }), '#c7b593', -1.2, 2.65, -4.28);
      gableMesh.name = 'cottage-stone-gable';
      const pitch = Math.atan2(1.25, 3.13), roofColors = ['#9d6547', '#b57c54', '#ad704b', '#c28d60'];
      const roofBatches: BoxPart[][] = roofColors.map(() => []);
      for (const side of [-1, 1]) {
        const base = box(house, '#70523b', -1.2 + side * 1.56, 3.25, -3.55, 3.42, .13, 1.92);
        base.rotation.z = -side * pitch;
        for (let row = 0; row < 8; row++) for (let col = 0; col < 6; col++) {
          const horizontal = .2 + row * .395;
          roofBatches[(row * 3 + col) % roofColors.length].push([-1.2 + side * horizontal, 3.94 - horizontal * Math.tan(pitch), -4.34 + col * .317, .43, .075, .35, -side * pitch]);
        }
      }
      roofBatches.forEach((parts, i) => boxes(house, roofColors[i], parts));
      for (let i = 0; i < 7; i++) cylinder(house, '#b37b51', -1.2, 3.965, -4.4 + i * .29, .12, .12, .32, 8).rotation.x = Math.PI / 2;
      box(house, '#8e6944', -1.2, 2.64, -2.79, 6.21, .17, .2);
      box(house, '#8d6743', -.98, 1.01, -2.838, 1.08, 2.02, .13, .035);
      for (let i = 0; i < 6; i++) box(house, i % 2 ? '#a47b4e' : '#b18b59', -1.415 + i * .174, 1.02, -2.747, .16, 1.94, .045, .012);
      for (const x of [-1.59, -.37]) box(house, '#d8c39c', x, 1.07, -2.78, .15, 2.14, .26, .025);
      box(house, '#d8c39c', -.98, 2.13, -2.78, 1.37, .17, .27, .025);
      for (const y of [.48, 1.57]) box(house, '#665a41', -.98, y, -2.707, .96, .055, .025);
      orb(house, '#73603d', -.67, 1, -2.665, .055);
      box(house, '#bca886', -.98, .08, -2.54, 1.55, .16, .58, .035);
      box(house, '#d0bd99', -.98, .025, -2.14, 1.83, .05, .35, .02);
      window(house, -3.04, 1.72, -2.795, .91, 1.02, true);
      window(house, 1.09, 1.72, -2.795, .91, 1.02, true);
      for (const x of [-3.04, 1.09]) {
        box(house, '#9c744a', x, 1.02, -2.58, 1.13, .28, .34, .025);
        for (let i = 0; i < 5; i++) {
          orb(house, leafColors[i % 3], x - .44 + i * .22, 1.22, -2.55, .16, .13, .16);
          orb(house, flowerColor, x - .38 + i * .19, 1.31 + i % 2 * .06, -2.48, .062);
        }
      }
    }
    if (!options.integrated) {
      stonework(root, -5.28, .12, 7.6, .69, .24, true);
      stonework(root, 5.28, .12, 7.6, .69, .24, true);
    }
    if (!options.integrated) stonework(root, 3.65, -3.67, 3.26, .92, .25);
    const border = new THREE.Group(); border.name = 'courtyard-fixed-border-foliage'; root.add(border);
    // Fixed boundary planting and eave branches are scenery, never duplicate saved tree/bench items.
    for (const side of [-1, 1]) for (let i = 0; i < 8; i++) {
      const z = -3.1 + i * .88;
      const shrub = new THREE.Group(); shrub.name = `courtyard-border-shrub-${side}-${i}`;
      shrub.userData.homeNavObstacle = true; border.add(shrub);
      if (surfaces) {
        const core = mesh(shrub, geometry('realistic-shrub-core', () => new THREE.IcosahedronGeometry(1, 0)), leafColors[(i + 1) % 3], side * 5.03, .49, z, false, 'foliage');
        core.scale.set(.23, .32 + i % 2 * .07, .37);
        const leaves: HomeLeaf[] = [];
        for (let j = 0; j < 3; j++) {
          const angle = j * 2.4 + i;
          leaves.push({ x: side * 5.03 + Math.sin(angle) * .15, y: .51 + (j % 2) * .15, z: z + Math.cos(angle) * .21,
            length: .46, width: .24, rx: Math.cos(angle) * .5, ry: angle, rz: Math.sin(angle) * .6 });
        }
        homeLeafCluster(shrub, `${shrub.name}-foliage`, leaves, leafColors, surfaces);
      } else orb(shrub, leafColors[(i + 1) % 3], side * 5.03, .52, z, .27, .38 + (i % 2) * .1, .45);
      if (seasonKey !== 'winter' && i % 2 === 0) {
        if (surfaces) {
          const flower = mesh(shrub, geometry('realistic-border-small-flower', () => new THREE.IcosahedronGeometry(1, 0)), flowerColor,
            side * 4.86, .74, z + .1, false, 'foliage');
          flower.scale.setScalar(.065);
        } else orb(shrub, flowerColor, side * 4.86, .74, z + .1, .065);
      }
    }
    if (house) for (let i = 0; i < 17; i++) {
      const t = i / 16, x = -4.11 + Math.sin(i * 1.7) * .14, y = .48 + t * 2.55;
      if (i > 0) rod(house, '#6f7a4c', [x, y - .19, -2.738], [x + .04, y, -2.73], .014);
      const leaf = orb(house, leafColors[i % 3], x + (i % 2 ? .1 : -.1), y, -2.725, .14, .09, .065);
      leaf.rotation.z = i % 2 ? .4 : -.4; motion(leaf, 'leaf');
    }
    const trunk = rod(border, '#715840', [-5.45, .7, -2.15], [-5.28, 2.8, -2.25], .14);
    trunk.name = 'courtyard-fixed-tree-trunk'; trunk.userData.homeNavObstacle = true;
    rod(border, '#715840', [-5.28, 2.7, -2.25], [-3.96, 3.6, -1.5], .09);
    rod(border, '#715840', [-5.28, 2.5, -2.25], [-4.96, 3.2, -.2], .07);
    const leafCount = seasonKey === 'winter' ? 5 : 17;
    const canopyLeaves: HomeLeaf[] = [];
    for (let i = 0; i < leafCount; i++) {
      const x = -5.1 + (i % 5) * .4, y = 3.05 + Math.sin(i * 2.2) * .35, z = -2 + Math.cos(i * 1.8) * .78;
      if (surfaces) {
        for (let j = 0; j < 3; j++) {
          const angle = i * .8 + j * 2.2;
          canopyLeaves.push({ x: x + Math.sin(angle) * .18, y: y + (j - 1) * .07, z: z + Math.cos(angle) * .16,
            length: .52, width: .35, rx: Math.PI / 2 + .22 * Math.sin(angle), ry: angle, rz: .2 * Math.cos(angle) });
        }
      } else {
        const leaf = orb(border, seasonKey === 'spring' && i % 4 === 0 ? flowerColor : leafColors[i % 3], x, y, z, .48, .24, .4);
        leaf.rotation.y = i * .8; motion(leaf, 'leaf');
      }
    }
    if (surfaces) {
      const canopy = homeLeafCluster(border, 'courtyard-fixed-tree-high-canopy', canopyLeaves, leafColors, surfaces);
      motion(canopy, 'leaf');
      mahjong();
      farmhouseCourtyard();
    }
    if (seasonKey === 'winter') {
      if (!options.integrated) for (const side of [-1, 1]) box(root, '#e4e7de', side * 5.28, .81, .12, .35, .06, 7.65, .02);
      if (!options.integrated) box(root, '#e4e7de', 3.65, 1.05, -3.67, 3.32, .07, .36, .02);
    }
  }

  if (area === 'outdoor') outdoor();
  else if (area === 'bedroom') bedroom();
  else livingRoom();
  root.updateMatrixWorld(true);
  return root;
}
