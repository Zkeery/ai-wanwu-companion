import * as THREE from 'three';
import type { HomeNavBounds } from './living-home-navigation';

/** Keep an eye-level room close-up on the room side of the physical walls. */
export function constrainRoomCamera(position: THREE.Vector3, target: THREE.Vector3, bounds: HomeNavBounds): boolean {
  const before = position.clone(), oldTarget = target.clone(), margin = .2;
  const clamp = (value: number, min: number, max: number) => THREE.MathUtils.clamp(Number.isFinite(value) ? value : (min + max) / 2, min, max);
  for (const point of [position, target]) {
    point.x = clamp(point.x, bounds.minX + margin, bounds.maxX - margin);
    point.z = clamp(point.z, bounds.minZ + margin, bounds.maxZ - margin);
    point.y = clamp(point.y, .85, 2.75);
  }
  return !before.equals(position) || !oldTarget.equals(target);
}

export function collectArchitectureOccluders(root: THREE.Object3D): THREE.Mesh[] {
  const result: THREE.Mesh[] = [];
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh) return;
    object.geometry.computeBoundingBox();
    for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) {
      const role = parent.userData.architectureRole;
      if (typeof role === 'string' && (role.startsWith('exterior-wall') || ['interior-partition', 'door', 'roof', 'courtyard-wall'].includes(role))) { result.push(object); break; }
    }
  });
  return result;
}

const worldBounds = new WeakMap<THREE.Mesh,{geometry:THREE.BufferGeometry;version:number;matrix:THREE.Matrix4;box:THREE.Box3}>();
function boundsOf(mesh:THREE.Mesh):THREE.Box3 {
  const attribute=mesh.geometry.getAttribute('position');
  const version=attribute instanceof THREE.InterleavedBufferAttribute?attribute.data.version:attribute?.version??0;
  let cached=worldBounds.get(mesh);
  if(!cached||cached.geometry!==mesh.geometry||cached.version!==version||!cached.matrix.equals(mesh.matrixWorld)){
    mesh.geometry.computeBoundingBox();
    cached={geometry:mesh.geometry,version,matrix:mesh.matrixWorld.clone(),box:mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)};
    worldBounds.set(mesh,cached);
  }
  return cached.box;
}

/** Prepare one immutable camera/architecture query per frame, shared by all labels. */
export function prepareArchitectureOcclusion(from: THREE.Vector3, meshes: readonly THREE.Mesh[]): (to: THREE.Vector3) => boolean {
  const visible = meshes.filter(mesh => {
    for (let parent: THREE.Object3D | null = mesh; parent; parent = parent.parent) if (!parent.visible || parent.userData.referenceVillaSuperseded) return false;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    return materials.some(material => material.visible && material.opacity >= .75);
  });
  for (const mesh of visible) mesh.updateWorldMatrix(true, false);
  const candidates=visible.map(mesh=>({mesh,box:boundsOf(mesh)}));
  const origin=from.clone(),ray=new THREE.Raycaster(),direction=new THREE.Vector3(),hits:THREE.Intersection[]=[];
  return to => {
    direction.copy(to).sub(origin);const distance=direction.length();if(distance<=.1)return false;
    ray.set(origin,direction.divideScalar(distance));ray.near=.05;ray.far=distance-.05;
    for(const {mesh,box} of candidates){
      if(!ray.ray.intersectsBox(box))continue;
      hits.length=0;ray.intersectObject(mesh,false,hits);
      if(hits.some(hit=>{const material=Array.isArray(mesh.material)?mesh.material[hit.face?.materialIndex??0]:mesh.material;return !!material&&material.visible&&material.opacity>=.75;}))return true;
    }
    return false;
  };
}

/** Real walls/closed doors block names; cutaways, invisible shells and glazing do not. */
export function architectureOccludes(from: THREE.Vector3, to: THREE.Vector3, meshes: readonly THREE.Mesh[]): boolean {
  return prepareArchitectureOcclusion(from,meshes)(to);
}
