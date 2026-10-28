import * as THREE from 'three';
import { SCENE_SCALE } from './living-scene-scale';

/** 44 triangles: shared bevel planes with smooth normals, same outer dimensions and contacts. */
export function sceneRoundedBox(width: number, height: number, depth: number, radius = SCENE_SCALE.bevel): THREE.BufferGeometry {
  const half = [width / 2, height / 2, depth / 2], r = Math.min(radius, Math.min(...half) * .9), inner = half.map(value => value - r);
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
  const point = (axis: number, a: number, b: number, c: number) => { const value = [0,0,0]; value[axis]=a;value[(axis+1)%3]=b;value[(axis+2)%3]=c;return new THREE.Vector3(...value as [number,number,number]); };
  function polygon(vertices: THREE.Vector3[]) {
    const normal = vertices[1].clone().sub(vertices[0]).cross(vertices[2].clone().sub(vertices[0]));
    const center = vertices.reduce((sum, value) => sum.add(value), new THREE.Vector3());
    if (normal.dot(center) < 0) vertices.reverse();
    for (let i=1;i<vertices.length-1;i++) for (const p of [vertices[0],vertices[i],vertices[i+1]]) {
      positions.push(p.x,p.y,p.z);
      const n = new THREE.Vector3(p.x-Math.sign(p.x)*Math.min(Math.abs(p.x),inner[0]),p.y-Math.sign(p.y)*Math.min(Math.abs(p.y),inner[1]),p.z-Math.sign(p.z)*Math.min(Math.abs(p.z),inner[2])).normalize();
      normals.push(n.x,n.y,n.z);uvs.push(p.x/width+.5,p.y/height+.5);
    }
  }
  for(let axis=0;axis<3;axis++) {
    const b=(axis+1)%3,c=(axis+2)%3;
    for(const side of [-1,1])polygon([[-1,-1],[1,-1],[1,1],[-1,1]].map(([sb,sc])=>point(axis,side*half[axis],sb*inner[b],sc*inner[c])));
    for(const sb of [-1,1])for(const sc of [-1,1])polygon([
      point(axis,-inner[axis],sb*half[b],sc*inner[c]),point(axis,inner[axis],sb*half[b],sc*inner[c]),
      point(axis,inner[axis],sb*inner[b],sc*half[c]),point(axis,-inner[axis],sb*inner[b],sc*half[c]),
    ]);
  }
  for(const sx of [-1,1])for(const sy of [-1,1])for(const sz of [-1,1])polygon([
    new THREE.Vector3(sx*half[0],sy*inner[1],sz*inner[2]),new THREE.Vector3(sx*inner[0],sy*half[1],sz*inner[2]),new THREE.Vector3(sx*inner[0],sy*inner[1],sz*half[2]),
  ]);
  const shape = new THREE.BufferGeometry();
  shape.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  shape.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
  shape.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
  shape.userData.softSceneBevel = true;
  return shape;
}

/** Smooth low-cost foliage, with a bounded triangle count and no faceted silhouette. */
export function sceneFoliage(): THREE.BufferGeometry {
  return new THREE.SphereGeometry(1, 8, 6);
}
