import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { HomeMaterialLibrary, HomeMaterialRole } from './living-home-materials';

export type HomeLeaf = { x: number; y: number; z: number; length: number; width: number; rx?: number; ry?: number; rz?: number };

/** A solid, curved blade with a raised central rib rather than a flat billboard. */
export function homeLeafGeometry(length: number, width: number): THREE.BufferGeometry {
  const points: number[] = [], indices: number[] = [];
  for (let face = 0; face < 2; face++) for (let row = 0; row < 5; row++) {
    const t = row / 4, span = Math.sin(Math.PI * t) * width * .5;
    const columns = row === 0 || row === 4 ? [0] : [-1, 0, 1];
    for (const cross of columns) {
      points.push(cross * span, (t - .5) * length,
        Math.sin(Math.PI * t) * length * .11 + (1 - Math.abs(cross)) * width * .13 + (face ? -.004 : .004));
    }
  }
  const front = [0, 3, 2, 0, 2, 1, 7, 8, 10, 8, 9, 10];
  for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
    const a = 1 + row * 3 + col, b = a + 1, c = a + 3, d = c + 1;
    front.push(a, b, c, b, d, c);
  }
  indices.push(...front);
  for (let i = 0; i < front.length; i += 3) indices.push(front[i] + 11, front[i + 2] + 11, front[i + 1] + 11);
  const outline = [0, 3, 6, 9, 10, 7, 4, 1];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    indices.push(a, a + 11, b, b, a + 11, b + 11);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  geometry.userData.homeDetail = 'curved-leaf';
  return geometry;
}

/** Leaves share two meshes per plant, keeping the visible silhouette without many draw calls. */
export function homeLeafCluster(parent: THREE.Object3D, name: string, leaves: HomeLeaf[], colors: string[], library?: HomeMaterialLibrary, obstacle = false): THREE.Group {
  const group = new THREE.Group(); group.name = name;
  if (obstacle) group.userData.homeNavObstacle = true;
  group.userData.homeDetail = 'layered-foliage'; parent.add(group);
  for (let palette = 0; palette < Math.min(2, colors.length); palette++) {
    const fragments = leaves.filter((_, i) => i % 2 === palette).map(leaf => {
      const shape = homeLeafGeometry(leaf.length, leaf.width);
      shape.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(leaf.x, leaf.y, leaf.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(leaf.rx ?? 0, leaf.ry ?? 0, leaf.rz ?? 0)), new THREE.Vector3(1, 1, 1)));
      return shape;
    });
    if (!fragments.length) continue;
    const geometry = mergeGeometries(fragments, false);
    fragments.forEach(value => value.dispose());
    if (!geometry) continue;
    library?.uv(geometry, 'foliage');
    const material = library?.material('foliage', colors[palette]) ?? new THREE.MeshStandardMaterial({ color: colors[palette], roughness: .9 });
    material.userData.homeMaterialRole = 'foliage';
    const mesh = new THREE.Mesh(geometry, material); mesh.name = `${name}-leaves-${palette}`;
    mesh.castShadow = mesh.receiveShadow = true; mesh.userData.homeMaterialRole = 'foliage';
    let owner: THREE.Object3D | null = parent;
    while (owner && !owner.userData.homeMaterialOwnerId) owner = owner.parent;
    const ownerId = library?.ownerId ?? owner?.userData.homeMaterialOwnerId;
    if (ownerId) {
      mesh.userData.homeMaterialOwnerId = ownerId;
      material.userData.homeMaterialOwnerId = ownerId;
    }
    group.add(mesh);
  }
  return group;
}

/** A padded seam-to-seam pillow; its world bounds remain the requested size. */
export function homePillowGeometry(width: number, height: number, depth: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(2, 2, 2, 4, 4, 4), position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    const sphere = new THREE.Vector3(x * Math.sqrt(1 - y * y / 2 - z * z / 2 + y * y * z * z / 3),
      y * Math.sqrt(1 - z * z / 2 - x * x / 2 + z * z * x * x / 3),
      z * Math.sqrt(1 - x * x / 2 - y * y / 2 + x * x * y * y / 3));
    const puff = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), .65);
    position.setXYZ(i, puff(sphere.x) * width / 2, puff(sphere.y) * height / 2, puff(sphere.z) * depth / 2);
  }
  geometry.computeVertexNormals(); geometry.userData.homeDetail = 'padded-pillow'; return geometry;
}

/** Rounded plan corners and a bowed sidewall, with the full sitting plane kept flat. */
export function homeSeatCushionGeometry(width: number, height: number, depth: number): THREE.BufferGeometry {
  const points: number[] = [], indices: number[] = [], corner = Math.min(.075, width * .08), count = 16;
  const rings = [{ y: -height / 2, inset: .018 }, { y: -height * .25, inset: 0 },
    { y: height * .16, inset: 0 }, { y: height / 2, inset: .018 }];
  for (const ring of rings) for (let c = 0; c < 4; c++) for (let step = 0; step < 4; step++) {
    const angle = c * Math.PI / 2 + step / 3 * Math.PI / 2;
    const cx = (c === 0 || c === 3 ? 1 : -1) * (width / 2 - corner - ring.inset);
    const cz = (c < 2 ? 1 : -1) * (depth / 2 - corner - ring.inset);
    points.push(cx + Math.cos(angle) * corner, ring.y, cz + Math.sin(angle) * corner);
  }
  for (let ring = 0; ring < rings.length - 1; ring++) for (let i = 0; i < count; i++) {
    const a = ring * count + i, b = ring * count + (i + 1) % count, c = a + count, d = b + count;
    indices.push(a, b, c, b, d, c);
  }
  const bottom = points.length / 3; points.push(0, -height / 2, 0, 0, height / 2, 0);
  for (let i = 0; i < count; i++) {
    indices.push(bottom, (i + 1) % count, i);
    indices.push(bottom + 1, 3 * count + i, 3 * count + (i + 1) % count);
  }
  for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.userData.homeDetail = 'bowed-seat-cushion'; return geometry;
}

export function homeQuiltGeometry(width: number, height: number, depth: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth, 6, 1, 3), position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    if (y > 0) position.setY(i, y + Math.sin((x / width + .5) * Math.PI * 6) * Math.sin((z / depth + .5) * Math.PI) * .009);
  }
  geometry.computeVertexNormals(); geometry.userData.homeDetail = 'folded-quilt'; return geometry;
}

/** Saved items keep their historical local origin. The environment owns shared materials. */
export function buildRealisticHomeItem(kind: 'tree' | 'bench' | 'shade', season: string | null, library?: HomeMaterialLibrary): THREE.Group {
  const root = new THREE.Group(); root.name = `home-realistic-item-${kind}`;
  const ownerId = library?.ownerId ?? THREE.MathUtils.generateUUID();
  root.userData.homeMaterialOwnerId = ownerId;
  root.userData.homeMaterialOwnership = library ? 'environment-shared' : 'item-owned';
  root.userData.homeDetail = 'realistic-saved-item';
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  function material(role: HomeMaterialRole, color: string) {
    if (library) return library.material(role, color);
    const key = `${role}:${color}`;
    let value = materials.get(key);
    if (!value) {
      value = new THREE.MeshStandardMaterial({ color, roughness: role === 'metal' ? .4 : .88, metalness: role === 'metal' ? .5 : 0 });
      value.userData.homeMaterialRole = role; value.userData.homeMaterialOwnerId = ownerId; materials.set(key, value);
    }
    return value;
  }
  function add(parent: THREE.Object3D, name: string, shape: THREE.BufferGeometry, role: HomeMaterialRole, color: string, x = 0, y = 0, z = 0) {
    library?.uv(shape, role);
    const value = new THREE.Mesh(shape, material(role, color)); value.name = name; value.position.set(x, y, z);
    value.castShadow = value.receiveShadow = true; value.userData.homeMaterialRole = role;
    value.userData.homeMaterialOwnerId = ownerId; parent.add(value); return value;
  }
  function rod(parent: THREE.Object3D, name: string, a: THREE.Vector3, b: THREE.Vector3, radius: number) {
    const direction = b.clone().sub(a), center = a.clone().add(b).multiplyScalar(.5);
    const value = add(parent, name, new THREE.CylinderGeometry(radius * .72, radius, direction.length(), 7), 'wood', '#76573c', center.x, center.y, center.z);
    value.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()); return value;
  }
  if (kind === 'tree') {
    const trunk = rod(root, 'home-item-tree-trunk', new THREE.Vector3(0, 0, 0), new THREE.Vector3(.035, 1.26, 0), .095);
    trunk.userData.homeNavObstacle = true;
    const branches = new THREE.Group(); branches.name = 'home-item-tree-low-branches'; branches.userData.homeNavObstacle = true; root.add(branches);
    for (let i = 0; i < 5; i++) {
      const angle = i * 2.4;
      rod(branches, `home-item-tree-branch-${i}`, new THREE.Vector3(.02, .74 + i * .075, 0), new THREE.Vector3(Math.sin(angle) * .39, 1.34 + i * .07, Math.cos(angle) * .34), .025);
    }
    const colors = season === 'autumn' ? ['#a98040', '#b8974e'] : season === 'winter' ? ['#879580', '#6f806d'] : ['#6e8956', '#849861'];
    const leaves: HomeLeaf[] = [];
    const count = season === 'winter' ? 14 : 26;
    for (let i = 0; i < count; i++) {
      const angle = i * 2.4, radius = .22 + (i % 3) * .12;
      leaves.push({ x: Math.sin(angle) * radius, y: 1.22 + (i % 5) * .105, z: Math.cos(angle) * radius * .84,
        length: .38 + (i % 3) * .055, width: .24 + (i % 2) * .055, rx: Math.cos(angle) * .9, ry: angle, rz: Math.sin(angle) * .85 });
    }
    const crown = homeLeafCluster(root, 'home-item-tree-low-crown', leaves, colors, library, true);
    if (!library) crown.traverse(object => {
      if (object instanceof THREE.Mesh) {
        const values = Array.isArray(object.material) ? object.material : [object.material];
        values.forEach(value => { value.userData.homeMaterialOwnerId = ownerId; });
      }
    });
  } else if (kind === 'bench') {
    root.userData.homeNavObstacle = true;
    root.userData.homeRestKind = 'bench';
    root.userData.homeRestSeatSpace = 'local';
    root.userData.homeRestSeats = [{ id: 'bench-seat-0', x: 0, y: .605, z: 0, yaw: 0 }];
    const fragments: THREE.BufferGeometry[] = [];
    function plank(x: number, y: number, z: number, w: number, h: number, d: number, radius = .015) {
      const section = new THREE.Shape(), a = d / 2, b = h / 2, r = Math.min(radius, a * .4, b * .4);
      section.moveTo(-a + r, -b); section.lineTo(a - r, -b); section.lineTo(a, -b + r);
      section.lineTo(a, b - r); section.lineTo(a - r, b); section.lineTo(-a + r, b);
      section.lineTo(-a, b - r); section.lineTo(-a, -b + r); section.closePath();
      const shape = new THREE.ExtrudeGeometry(section, { depth: w, bevelEnabled: false });
      shape.translate(0, 0, -w / 2); shape.rotateY(Math.PI / 2); shape.translate(x, y, z); fragments.push(shape);
    }
    for (const x of [-.48, .48]) {
      for (const z of [-.18, .18]) plank(x, .27, z, .075, .54, .075, .012);
      plank(x, .69, -.22, .075, .57, .075, .012);
      plank(x, .465, 0, .075, .06, .51, .01);
    }
    for (const z of [-.22, -.04, .14]) plank(0, .56, z, 1.18, .09, .14);
    for (const y of [.76, .96]) plank(0, y, -.26, 1.18, .12, .065);
    plank(0, .19, 0, .98, .055, .055, .008);
    const shape = mergeGeometries(fragments, false); fragments.forEach(value => value.dispose());
    if (shape) add(root, 'home-item-bench-woodwork', shape, 'wood', '#aa8254');
    const bolts: THREE.BufferGeometry[] = [];
    for (const x of [-.48, .48]) for (const y of [.76, .96]) {
      const bolt = new THREE.CylinderGeometry(.013, .013, .008, 6); bolt.rotateX(Math.PI / 2); bolt.translate(x, y, -.298); bolts.push(bolt);
    }
    const iron = mergeGeometries(bolts, false); bolts.forEach(value => value.dispose());
    if (iron) add(root, 'home-item-bench-fasteners', iron, 'metal', '#6d6656');
  } else {
    const pole = add(root, 'home-item-shade-pole', new THREE.CylinderGeometry(.04, .05, 1.55, 10), 'wood', '#a38054', 0, .78, 0);
    pole.userData.homeNavObstacle = true;
    const canopy = new THREE.ConeGeometry(.9, .34, 12, 3), positions = canopy.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      const y = positions.getY(i), angle = Math.atan2(positions.getZ(i), positions.getX(i));
      if (y < .16) positions.setY(i, y - Math.sin(angle * 6) ** 2 * .035 * (.17 - y));
    }
    canopy.computeVertexNormals();
    const fabric = add(root, 'home-item-shade-canopy', canopy, 'fabric', '#d5cbb2', 0, 1.62, 0);
    fabric.userData.homeNavObstacle = true;
    fabric.userData.homeDetail = 'panelled-shade';
    const ribs = new THREE.Group(); ribs.name = 'home-item-shade-ribs'; root.add(ribs);
    for (let i = 0; i < 6; i++) {
      const angle = i * Math.PI / 3;
      rod(ribs, `home-item-shade-rib-${i}`, new THREE.Vector3(0, 1.76, 0), new THREE.Vector3(Math.sin(angle) * .84, 1.46, Math.cos(angle) * .84), .012);
    }
  }
  root.updateMatrixWorld(true); return root;
}
