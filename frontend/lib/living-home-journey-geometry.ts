import * as THREE from 'three';
import type { LivingAvatarMesh } from './living-meshes';
import type { HomeNavigationObstacle } from './living-home-navigation';
import type { HomeWorldDoorId } from './living-home-world-meshes';

const JOURNEY_OPEN_ANGLE = -95 * Math.PI / 180;
const OBSTACLE_PADDING = .002;
type Slab = [number, number, number, number, number, number, number?];
const finiteBox = (b: THREE.Box3) => !b.isEmpty() && [...b.min.toArray(), ...b.max.toArray()].every(Number.isFinite);
function architecturalRole(object: THREE.Object3D) {
  for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) {
    if (typeof parent.userData.architectureRole === 'string') return parent.userData.architectureRole as string;
  }
}
function solidSlabs(value: unknown): Slab[] | null {
  if (!Array.isArray(value) || !value.every(piece => Array.isArray(piece) && (piece.length === 6 || piece.length === 7)
    && piece.every(Number.isFinite) && piece.slice(3, 6).every(n => n > 0))) return null;
  return value as Slab[];
}

/** The same rendered solids, split before AABB projection. A doorway is never a parent-group box. */
export function collectHomeJourneyObstacles(environment: THREE.Object3D | null, items: THREE.Object3D | null): HomeNavigationObstacle[] {
  const result: HomeNavigationObstacle[] = [];
  const add = (box: THREE.Box3, source: string) => {
    if (!finiteBox(box) || box.max.y < .05 || box.min.y > 1.6) return;
    // This named 5.4 cm stone threshold is a real, climbable step. The journey raises the feet over it.
    // Keep every other low solid; do not turn an unknown obstacle into a walkable floor.
    if (source === 'home-main-entry-stone-surround:slab-3' && box.min.y >= -1e-6 && box.max.y <= .06) return;
    result.push({ minX: box.min.x - OBSTACLE_PADDING, maxX: box.max.x + OBSTACLE_PADDING,
      minZ: box.min.z - OBSTACLE_PADDING, maxZ: box.max.z + OBSTACLE_PADDING, source });
  };
  for (const root of [environment, items]) {
    if (!root) continue; root.updateWorldMatrix(true, true);
    const visit = (object: THREE.Object3D) => {
      if (object.userData.homeNavObstacle === true) { add(new THREE.Box3().setFromObject(object, true), object.name || object.uuid); return; }
      const role = architecturalRole(object);
      if (object instanceof THREE.Mesh && (role?.startsWith('exterior-wall') || role === 'interior-partition' || role === 'door' || role === 'courtyard-wall')) {
        const pieces = solidSlabs(object.userData.homeJourneySlabs);
        if (pieces) pieces.forEach(([x, y, z, width, height, depth, yaw = 0], index) => {
          const local = new THREE.Matrix4().makeRotationY(yaw); local.setPosition(x, y, z);
          const transform = new THREE.Matrix4().multiplyMatrices(object.matrixWorld, local);
          const box = new THREE.Box3(new THREE.Vector3(-width / 2, -height / 2, -depth / 2), new THREE.Vector3(width / 2, height / 2, depth / 2)).applyMatrix4(transform);
          add(box, (object.name || object.uuid) + ':slab-' + index);
        });
        else add(new THREE.Box3().setFromObject(object, true), object.name || object.uuid);
      }
      object.children.forEach(visit);
    };
    visit(root);
  }
  return result;
}

/** Local journey opt-in only: existing production/default 68 degree door behaviour is unchanged. */
export function setHomeJourneyDoorOpenness(environment: THREE.Object3D, id: HomeWorldDoorId, openness: number): void {
  const door = environment.getObjectByName(id), leaf = door?.getObjectByName(id + '-leaf');
  if (!door || !leaf) return;
  const value = Number.isNaN(openness) ? 0 : Math.max(0, Math.min(1, openness));
  leaf.rotation.y = value === 0 ? 0 : value * JOURNEY_OPEN_ANGLE;
  door.userData.homeDoorOpenness = value;
  door.userData.homeDoorOpenAngle = JOURNEY_OPEN_ANGLE;
  leaf.userData.openAngle = 95;
  leaf.updateWorldMatrix(true, true);
}

/** Door-only, forward gait: neutral arms/lean, full leg swing. This never changes the .9 peer disk. */
export function homeJourneyPortalClearance(avatar: LivingAvatarMesh): { x: number; z: number; height: number } {
  const posed = [avatar.body, avatar.leftArm, avatar.rightArm, avatar.leftLeg, avatar.rightLeg, avatar.leftKnee, avatar.rightKnee];
  const before = posed.map(node => ({ node, position: node.position.clone(), quaternion: node.quaternion.clone(),
    scale: node.scale.clone(), matrix: node.matrix.clone(), auto: node.matrixAutoUpdate }));
  const bounds = new THREE.Box3();
  try {
    posed.forEach(node => { node.matrixAutoUpdate = true; node.rotation.set(0, 0, 0); node.scale.set(1, 1, 1); });
    avatar.body.position.set(0, .75, 0);
    for (const leg of [avatar.leftLeg, avatar.rightLeg]) { leg.position.y = .3; leg.position.z = 0; }
    const bodyRoots = [avatar.body, avatar.leftArm, avatar.rightArm, avatar.leftLeg, avatar.rightLeg];
    for (let step = 0; step <= 120; step++) {
      const stride = Math.sin(step / 120 * Math.PI * 2) * .42;
      avatar.leftLeg.rotation.x = stride; avatar.rightLeg.rotation.x = -stride;
      avatar.root.updateWorldMatrix(true, true);
      const inverse = avatar.root.matrixWorld.clone().invert(), scale = new THREE.Matrix4().makeScale(avatar.root.scale.x, avatar.root.scale.y, avatar.root.scale.z);
      for (const root of bodyRoots) root.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const vertices = object.geometry.getAttribute('position'); if (!vertices) return;
        const matrix = new THREE.Matrix4().multiplyMatrices(scale, new THREE.Matrix4().multiplyMatrices(inverse, object.matrixWorld));
        for (let i = 0; i < vertices.count; i++) bounds.expandByPoint(new THREE.Vector3().fromBufferAttribute(vertices, i).applyMatrix4(matrix));
      });
    }
    if (!finiteBox(bounds)) return { x: Infinity, z: Infinity, height: Infinity };
    return { x: Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)) + .02,
      z: Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z)) + .02,
      height: bounds.max.y - Math.min(0, bounds.min.y) + .02 };
  } finally {
    before.forEach(({ node, position, quaternion, scale, matrix, auto }) => {
      node.position.copy(position); node.quaternion.copy(quaternion); node.scale.copy(scale); node.matrix.copy(matrix); node.matrixAutoUpdate = auto;
    });
    avatar.root.updateWorldMatrix(true, true);
  }
}
