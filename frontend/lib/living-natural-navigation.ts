import * as THREE from 'three';
import type { HomeNavBounds, HomeNavigationObstacle } from './living-home-navigation';

const BOUNDS = Object.freeze({ minX: -7, maxX: 7, minZ: -5.8, maxZ: 5.8 });
const SCENE_BOUNDS = Object.freeze({ forest: BOUNDS, desert: BOUNDS });
const MARGIN = .002;

/** Keep the saved natural-world anchors and a body's clearance inside the floor. */
export function naturalNavigationBounds(sceneType: 'forest' | 'desert'): HomeNavBounds {
  return SCENE_BOUNDS[sceneType];
}

/** Physical markers include low water and remain solid when hidden or transparent. */
export function collectNaturalNavigationObstacles(environment: THREE.Object3D | null, items: THREE.Object3D | null): HomeNavigationObstacle[] {
  const candidates = new Set<THREE.Object3D>();
  for (const root of new Set([environment, items])) {
    if (!root) continue;
    root.updateWorldMatrix(true, true);
    root.traverse(object => { if (object.userData.naturalNavObstacle === true) candidates.add(object); });
  }
  const result: HomeNavigationObstacle[] = [];
  for (const object of candidates) {
    let covered = false;
    for (let parent = object.parent; parent; parent = parent.parent) if (candidates.has(parent)) { covered = true; break; }
    if (covered) continue;
    const box = new THREE.Box3().setFromObject(object, true);
    if (box.isEmpty() || ![box.min.x, box.max.x, box.min.y, box.max.y, box.min.z, box.max.z].every(Number.isFinite)) continue;
    result.push(Object.freeze({ minX: box.min.x - MARGIN, maxX: box.max.x + MARGIN,
      minZ: box.min.z - MARGIN, maxZ: box.max.z + MARGIN, source: typeof object.userData.naturalLeisureSupportId==='string'?object.userData.naturalLeisureSupportId:object.name || object.uuid }));
  }
  return Object.freeze(result) as HomeNavigationObstacle[];
}
