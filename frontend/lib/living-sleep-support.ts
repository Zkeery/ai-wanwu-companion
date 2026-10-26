import * as THREE from 'three';

type ProfilePoint = Readonly<{ y: number; z: number }>;
type Decoration = Readonly<{ part: THREE.Object3D; awakeZ: number; profile: readonly ProfilePoint[] }>;
type Adjustment = Readonly<{ part: THREE.Object3D; awakeZ: number; asleepZ: number }>;
export type LivingSleepSupport = Readonly<{
  version: 1;
  /** Root-local Z becomes world Y after the agreed -PI/2 supine rotation. */
  bodySupportZ: number;
  adjustments: readonly Adjustment[];
  coreProfile: readonly ProfilePoint[];
  legProfile: readonly ProfilePoint[];
  decorations: readonly Decoration[];
  taperSlope: number;
}>;
export type LivingBedPose = Readonly<{
  rotationX: number;
  /** World-space offset: rootY = mattressY + rootOffsetY (already includes root scale). */
  rootOffsetY: number;
  headOffsetZ: number;
  bodyOffsetZ: number;
  /** Signed root-local hip Z: lower floating feet or lift penetrating legs onto the mattress. */
  legOffsetZ: number;
  breathing: number;
  adjustments: readonly Adjustment[];
}>;

function hull(points: ProfilePoint[]): readonly ProfilePoint[] {
  const sorted = points.sort((a, b) => a.y - b.y || a.z - b.z).filter((p, i, all) => !i || p.y !== all[i - 1].y || p.z !== all[i - 1].z);
  if (sorted.length < 3) return Object.freeze(sorted);
  const cross = (a: ProfilePoint, b: ProfilePoint, c: ProfilePoint) => (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
  const side = (values: ProfilePoint[]) => {
    const result: ProfilePoint[] = [];
    for (const p of values) { while (result.length > 1 && cross(result[result.length - 2], result[result.length - 1], p) <= 1e-12) result.pop(); result.push(p); }
    return result;
  };
  return Object.freeze([...side(sorted).slice(0, -1), ...side([...sorted].reverse()).slice(0, -1)]);
}

function preciseRootProfile(root: THREE.Object3D, part: THREE.Object3D): readonly ProfilePoint[] {
  const inverse = root.matrixWorld.clone().invert(), points: ProfilePoint[] = [], vertex = new THREE.Vector3();
  part.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute('position'); if (!position) return;
    const transform = new THREE.Matrix4().multiplyMatrices(inverse, object.matrixWorld);
    for (let i = 0; i < position.count; i++) { vertex.fromBufferAttribute(position, i).applyMatrix4(transform); points.push(Object.freeze({ y: vertex.y, z: vertex.z })); }
  });
  return hull(points);
}

/** Actual vertices, not rotated geometry AABB corners that can lift a body off its bed. */
function preciseRootBounds(root: THREE.Object3D, part: THREE.Object3D) {
  const inverse = root.matrixWorld.clone().invert(), bounds = new THREE.Box3(), vertex = new THREE.Vector3();
  part.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute('position'); if (!position) return;
    const transform = new THREE.Matrix4().multiplyMatrices(inverse, object.matrixWorld);
    for (let i = 0; i < position.count; i++) bounds.expandByPoint(vertex.fromBufferAttribute(position, i).applyMatrix4(transform));
  });
  return bounds;
}

/** Called once while constructing neutral geometry, before per-scene scaling/animation. */
export function prepareLivingSleepSupport(root: THREE.Group, body: THREE.Group): LivingSleepSupport | null {
  root.updateMatrixWorld(true);
  const supportBounds = new THREE.Box3(), coreMeshes: THREE.Mesh[] = [], corePoints: ProfilePoint[] = [];
  body.traverse(object => {
    if (object instanceof THREE.Mesh && object.userData.sleepBodySupport === true) {
      supportBounds.union(preciseRootBounds(root, object)); coreMeshes.push(object); corePoints.push(...preciseRootProfile(root, object));
    }
  });
  if (supportBounds.isEmpty() || !Number.isFinite(supportBounds.min.z)) return null;
  const bodySupportZ = supportBounds.min.z;
  const coreProfile = hull(corePoints), decorations: Decoration[] = [];
  let taperSlope = 0;
  // Fit the actual lower/upper rear generator of a single tapered load-bearing
  // cylinder. A horizontal axis would leave the narrow end visibly in the air.
  if (coreMeshes.length === 1 && coreMeshes[0].geometry instanceof THREE.CylinderGeometry) {
    const minY = Math.min(...coreProfile.map(p => p.y)), maxY = Math.max(...coreProfile.map(p => p.y));
    const lowZ = Math.min(...coreProfile.filter(p => Math.abs(p.y - minY) < 1e-6).map(p => p.z));
    const highZ = Math.min(...coreProfile.filter(p => Math.abs(p.y - maxY) < 1e-6).map(p => p.z));
    if (maxY - minY > 1e-6) taperSlope = (lowZ - highZ) / (maxY - minY);
  }
  const adjustments: { part: THREE.Object3D; awakeZ: number; asleepZ: number }[] = [];
  for (const part of body.children) {
    let bearing = false;
    part.traverse(object => { if (object.userData.sleepBodySupport === true) bearing = true; });
    if (bearing) continue;
    decorations.push(Object.freeze({ part, awakeZ: part.position.z, profile: preciseRootProfile(root, part) }));
    const bounds = preciseRootBounds(root, part);
    // Fold a rear-projecting decoration toward the torso. It must neither hold
    // the whole body in the air nor pass through the mattress after contact.
    if (!bounds.isEmpty() && bounds.min.z < bodySupportZ - 1e-6) adjustments.push({
      part, awakeZ: part.position.z, asleepZ: part.position.z + bodySupportZ - bounds.min.z + 1e-6,
    });
  }
  const legProfile = hull(root.children.filter(part => part.name === 'left-leg' || part.name === 'right-leg')
    .flatMap(part => [...preciseRootProfile(root, part)]));
  return Object.freeze({ version: 1, bodySupportZ, coreProfile, legProfile, taperSlope, decorations: Object.freeze(decorations),
    adjustments: Object.freeze(adjustments.map(value => Object.freeze(value))) });
}

/** Scale-aware supine support. Uses cached actual-vertex convex profiles, never per-frame mesh traversal. */
export function computeLivingBedPose(support: LivingSleepSupport | null, scale: Readonly<{ y: number; z: number }>, breathing = 1): LivingBedPose | null {
  if (!support || ![scale.y, scale.z, breathing].every(v => Number.isFinite(v) && v > 0)) return null;
  const rotationX = -Math.PI / 2 + Math.atan(support.taperSlope * scale.z * breathing / scale.y);
  const cosine = Math.cos(rotationX), sine = Math.sin(rotationX), liftPerZ = -sine * scale.z * breathing;
  if (liftPerZ < 1e-8) return null;
  const height = (p: ProfilePoint, dz = 0) => cosine * scale.y * p.y - sine * scale.z * (p.z + dz) * breathing;
  const longitudinal = (p: ProfilePoint, dz = 0) => sine * scale.y * p.y + cosine * scale.z * (p.z + dz) * breathing;
  const supportY = Math.min(...support.coreProfile.map(p => height(p)));
  const legY = support.legProfile.length ? Math.min(...support.legProfile.map(p => cosine * scale.y * p.y - sine * scale.z * p.z)) : supportY;
  // Legs do not inherit the torso's thickness or breathing scale. A rearward
  // (negative) offset is necessary when their actual bearing surface floats
  // above the body support plane; clamping it to zero leaves the feet in air.
  const legOffsetZ = (supportY - legY) / (-sine * scale.z);
  let headZ = Math.min(...support.coreProfile.map(p => longitudinal(p)));
  const adjustments: Adjustment[] = [];
  for (const decoration of support.decorations) {
    if (!decoration.profile.length) continue;
    const partY = Math.min(...decoration.profile.map(p => height(p)));
    const dz = Math.max(0, (supportY - partY) / liftPerZ + (partY < supportY ? 1e-6 : 0));
    adjustments.push(Object.freeze({ part: decoration.part, awakeZ: decoration.awakeZ, asleepZ: decoration.awakeZ + dz }));
    headZ = Math.min(headZ, ...decoration.profile.map(p => longitudinal(p, dz)));
  }
  return Object.freeze({ rotationX, rootOffsetY: -supportY, headOffsetZ: -headZ, bodyOffsetZ: 0, legOffsetZ,
    breathing, adjustments: Object.freeze(adjustments) });
}

/** Absolute transforms make repeated draws idempotent and wake-up exactly reversible. */
export function setLivingSleepSupport(support: LivingSleepSupport | null, asleep: boolean, pose?: LivingBedPose | null) {
  if (!support) return;
  for (const { part, awakeZ } of support.decorations) part.position.z = awakeZ;
  if (asleep) for (const { part, asleepZ } of pose?.adjustments ?? support.adjustments) part.position.z = asleepZ;
}
