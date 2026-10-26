import * as T from 'three';
import type { LivingAvatarMesh } from './living-meshes';
import {computeLivingBedPose} from './living-sleep-support';
import type { JourneyContactPoint, JourneyPose } from './living-home-journey';

type Face = { triangle: T.Triangle; bounds: T.Box3 };
type Solid = { mesh: T.Mesh; bounds: T.Box3; faces: Face[]; support: boolean };
type ContactAvatar = LivingAvatarMesh & { baseScale: T.Vector3 };
type Rig = { root: T.Group; body: T.Object3D; arms: T.Object3D[]; legs: T.Object3D[]; knees: T.Object3D[]; parts: Map<T.Object3D, T.Object3D> };
type ContactMode = 'mahjong' | 'television' | 'sleep';
type CollisionReport = { obstacle: string; part: string; fraction: number; method: string; obstacleBounds: number[][]; bodyBounds: number[][] };
const EPSILON = 1e-6;
const SUPPORT_CONTACT = .006;

/** Thighs rest above the cushion; bent shins and feet hang beyond its front edge. */
export function mahjongContactLegPose(seatHeight: number, blend: number, seatedScaleY = 1) {
  // Lift the knees during the lateral transfer before lowering the feet in
  // front of the cushion. A linear hanging leg passes through its side edge.
  return { y: T.MathUtils.lerp(.3, seatHeight + .12, blend) + .10 * Math.sin(Math.PI * blend), z: .255 / Math.max(.1, seatedScaleY) * Math.min(1, blend / .75) };
}

function faces(mesh: T.Mesh): Face[] {
  const position = mesh.geometry.getAttribute('position'), index = mesh.geometry.index, result: Face[] = [];
  for (let i = 0; i < (index?.count ?? position.count); i += 3) {
    const triangle = new T.Triangle();
    [triangle.a, triangle.b, triangle.c].forEach((point, offset) => point.fromBufferAttribute(position, index ? index.getX(i + offset) : i + offset).applyMatrix4(mesh.matrixWorld));
    result.push({ triangle, bounds: new T.Box3().setFromPoints([triangle.a, triangle.b, triangle.c]) });
  }
  return result;
}
function meshes(root: T.Object3D, physical = false) {
  const result: T.Mesh[] = []; root.traverse(object => { if (object instanceof T.Mesh && (physical || object.visible)) result.push(object); }); return result;
}
function intersects(a: T.Box3, b: T.Box3) {
  return a.min.x < b.max.x - EPSILON && a.max.x > b.min.x + EPSILON
    && a.min.y < b.max.y - EPSILON && a.max.y > b.min.y + EPSILON
    && a.min.z < b.max.z - EPSILON && a.max.z > b.min.z + EPSILON;
}
const ray = new T.Ray(), direction = new T.Vector3(), intersection = new T.Vector3();
function edgesCross(edge: T.Triangle, face: T.Triangle) {
  for (const [a, b] of [[edge.a, edge.b], [edge.b, edge.c], [edge.c, edge.a]]) {
    const length = direction.subVectors(b, a).length(); if (length <= EPSILON) continue;
    ray.set(a, direction.multiplyScalar(1 / length));
    if (ray.intersectTriangle(face.a, face.b, face.c, false, intersection)) {
      const distance = intersection.distanceTo(a); if (distance > EPSILON && distance < length - EPSILON) return true;
    }
  }
  return false;
}
function inside(point: T.Vector3, solid: Solid) {
  if (!(point.x > solid.bounds.min.x + EPSILON && point.x < solid.bounds.max.x - EPSILON
    && point.y > solid.bounds.min.y + EPSILON && point.y < solid.bounds.max.y - EPSILON
    && point.z > solid.bounds.min.z + EPSILON && point.z < solid.bounds.max.z - EPSILON)) return false;
  // Winding remains correct when one mesh merges overlapping closed boxes.
  // Deduplicated parity rays can mistake their coincident board/post faces for
  // one crossing and incorrectly turn the empty space inside a chair into wood.
  const a = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3(), cross = new T.Vector3(); let winding = 0;
  for (const { triangle } of solid.faces) {
    a.subVectors(triangle.a, point); b.subVectors(triangle.b, point); c.subVectors(triangle.c, point);
    const x = a.length(), y = b.length(), z = c.length();
    winding += 2 * Math.atan2(a.dot(cross.crossVectors(b, c)), x * y * z + a.dot(b) * z + b.dot(c) * x + c.dot(a) * y);
  }
  return Math.abs(winding) > Math.PI * 2;
}
function crosses(a: Solid, b: Solid) {
  for (const first of a.faces) for (const second of b.faces) if (first.bounds.intersectsBox(second.bounds)
    && (edgesCross(first.triangle, second.triangle) || edgesCross(second.triangle, first.triangle))) return 'surface';
  // A small closed solid entirely inside another one has no crossing surface.
  if (a.faces.some(face => inside(face.triangle.a, b))) return 'body-inside';
  if (b.faces.some(face => inside(face.triangle.a, a))) return 'obstacle-inside';
  return null;
}

const uniqueVertexPositions = new WeakMap<T.BufferGeometry, {source:T.BufferAttribute|T.InterleavedBufferAttribute;version:number;points:T.BufferAttribute}>();
function uniquePositions(geometry:T.BufferGeometry) {
  const source=geometry.getAttribute('position'), version=source instanceof T.BufferAttribute?source.version:source.data.version;
  const known=uniqueVertexPositions.get(geometry);if(known?.source===source&&known.version===version)return known.points;
  const seen=new Set<string>(), positions:number[]=[];
  for(let i=0;i<source.count;i++){const x=source.getX(i),y=source.getY(i),z=source.getZ(i),key=x+'/'+y+'/'+z;if(!seen.has(key)){seen.add(key);positions.push(x,y,z);}}
  const points=new T.BufferAttribute(new Float64Array(positions),3);uniqueVertexPositions.set(geometry,{source,version,points});return points;
}
const boundsVertex=new T.Vector3();
function exactBounds(mesh:T.Mesh) {
  if(mesh.children.length||mesh.morphTargetInfluences?.length||(mesh as T.Mesh & {isInstancedMesh?:boolean;isSkinnedMesh?:boolean}).isInstancedMesh||(mesh as T.Mesh & {isSkinnedMesh?:boolean}).isSkinnedMesh)return new T.Box3().setFromObject(mesh,true);
  mesh.updateWorldMatrix(false,false);
  const bounds=new T.Box3(),positions=uniquePositions(mesh.geometry);
  for(let i=0;i<positions.count;i++)bounds.expandByPoint(boundsVertex.fromBufferAttribute(positions,i).applyMatrix4(mesh.matrixWorld));
  return bounds;
}

/** Exact contact-only rig sweep. Walking/peer radii remain unchanged. No GPU, network or live-rig mutation. */
export function createLivingContactCollision() {
  const cached = new WeakMap<T.Mesh, { stamp: string; faces: Face[] | null; bounds: T.Box3 }>();
  const radii = new WeakMap<T.Object3D, Partial<Record<ContactMode,number>>>();
  const checks = new WeakMap<T.Object3D, Map<string, { clear: boolean; collision: CollisionReport | null }>>();
  const rigs = new WeakMap<T.Object3D, Rig>(); let lastCollision: CollisionReport | null = null;
  function rig(avatar: ContactAvatar): Rig {
    let value = rigs.get(avatar.root); if (value) return value;
    const root = new T.Group(), body = avatar.body.clone(true), arms = [avatar.leftArm.clone(true), avatar.rightArm.clone(true)],
      legs = [avatar.leftLeg.clone(true), avatar.rightLeg.clone(true)];
    const parts = new Map<T.Object3D, T.Object3D>(), pair = (original: T.Object3D, copy: T.Object3D) => { parts.set(original, copy); original.children.forEach((child, index) => pair(child, copy.children[index])); };
    [avatar.body, avatar.leftArm, avatar.rightArm, avatar.leftLeg, avatar.rightLeg].forEach((part, index) => pair(part, [body, ...arms, ...legs][index]));
    root.add(body, ...arms, ...legs); value = { root, body, arms, legs, knees: legs.map((leg, index) => leg.getObjectByName(index ? 'right-knee' : 'left-knee')!), parts };
    rigs.set(avatar.root, value); return value;
  }
  function shape(mesh: T.Mesh) {
    const stamp = mesh.geometry.uuid + '/' + mesh.matrixWorld.elements.join(','); let value = cached.get(mesh);
    if (!value || value.stamp !== stamp) { value = { stamp, faces: null, bounds: exactBounds(mesh) }; cached.set(mesh, value); }
    return value;
  }
  function solid(mesh: T.Mesh, support: boolean): Solid {
    const value = shape(mesh); return { mesh, faces: value.faces ??= faces(mesh), bounds: value.bounds, support };
  }
  const bedPoses = new WeakMap<T.Object3D, { support: LivingAvatarMesh['sleepSupport']; y: number; z: number; poses: Map<number, ReturnType<typeof computeLivingBedPose>> }>();
  function bedPose(avatar: ContactAvatar, breathing: number) {
    let cache = bedPoses.get(avatar.root);
    if (!cache || cache.support !== avatar.sleepSupport || cache.y !== avatar.baseScale.y || cache.z !== avatar.baseScale.z) {
      cache = { support: avatar.sleepSupport, y: avatar.baseScale.y, z: avatar.baseScale.z, poses: new Map() }; bedPoses.set(avatar.root, cache);
    }
    if (cache.poses.has(breathing)) return cache.poses.get(breathing)!;
    const pose = computeLivingBedPose(avatar.sleepSupport, avatar.baseScale.clone().multiplyScalar(.9), breathing);
    if (cache.poses.size >= 128) cache.poses.delete(cache.poses.keys().next().value!);
    cache.poses.set(breathing, pose); return pose;
  }
  function poseRig(value: Rig, avatar: ContactAvatar, pose: JourneyPose, blend: number, mode:ContactMode,sleepLift=0) {
    value.root.position.set(pose.x, pose.y, pose.z); value.root.rotation.set(pose.tilt, pose.yaw, 0);
    value.root.scale.copy(avatar.baseScale).multiplyScalar(pose.scale); value.body.position.set(0, .75, 0); value.body.rotation.set(0, 0, 0); value.body.scale.set(1, 1, mode === 'sleep' ? pose.bedBreathing ?? 1 : 1);
    for (const decoration of avatar.sleepSupport?.decorations ?? []) { const part = value.parts.get(decoration.part); if (part) part.position.z = decoration.awakeZ; }
    value.arms.forEach(arm => { arm.rotation.set(-.35 * blend, 0, 0); arm.scale.set(1, 1, 1); });
    const legPose = mode==='mahjong'?mahjongContactLegPose(avatar.seatHeight, blend, avatar.baseScale.y * .9):{y:T.MathUtils.lerp(.3,avatar.seatHeight+.06,blend),z:.06*blend};
    value.legs.forEach(leg => { leg.position.y = legPose.y; leg.position.z = legPose.z; leg.rotation.set(-1.15 * blend, 0, 0); });
    value.knees.forEach(knee => knee.rotation.set(1.15 * blend, 0, 0)); if(mode==='sleep'){const bp=bedPose(avatar,pose.bedBreathing??1);value.arms.forEach(arm=>arm.rotation.set(0,0,0));const seat=pose.bedSeat??0;value.legs.forEach(leg=>{leg.position.y=T.MathUtils.lerp(.3,avatar.seatHeight+.06,seat);leg.position.z=((bp?.legOffsetZ??0)+sleepLift+(pose.bedLegLift??0))*blend+.06*seat;leg.rotation.set(-1.15*seat,0,0);});value.knees.forEach(k=>k.rotation.set(1.15*seat,0,0));for(const adjustment of bp?.adjustments??[]){const part=value.parts.get(adjustment.part);if(part)part.position.z=T.MathUtils.lerp(adjustment.awakeZ,adjustment.asleepZ,blend);}}value.root.updateMatrixWorld(true);
  }
  function radius(avatar: ContactAvatar,mode:ContactMode='mahjong') {
    const known = radii.get(avatar.root)?.[mode]; if (known !== undefined) return known;
    const value = rig(avatar), point = new T.Vector3(); let maximum = 0;
    // Rotation-safe radius of the actual neutral/bent rig throughout transfer,
    // including feet and hands. This is used only while contacting this chair;
    // standing paths retain their original .9 navigation clearance.
    for (let sample = 0; sample <= 32; sample++) {
      const blend = sample / 32;
      poseRig(value, avatar, { x: 0, y: 0, z: 0, yaw: 0, tilt: 0, scale: 1 - .1 * blend, area: 'outdoor', contact: 'rest' }, blend,mode);
      for (const mesh of [...value.legs, value.body, ...value.arms].flatMap(part => meshes(part))) {
        const positions = uniquePositions(mesh.geometry);
        for (let i = 0; i < positions.count; i++) { point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld); maximum = Math.max(maximum, Math.hypot(point.x, point.z)); }
      }
    }
    const result = maximum + .02; radii.set(avatar.root, {...radii.get(avatar.root),[mode]:result}); return result;
  }
  function obstacles(environment: T.Object3D | null, items: T.Object3D | null, supports: readonly string[], sweep: T.Box3) {
    const result: Solid[] = [];
    const add = (object: T.Object3D, supportName?: string) => {
      for (const mesh of meshes(object, true)) {
        const bounds = shape(mesh).bounds; if (!bounds.intersectsBox(sweep)) continue;
        result.push(solid(mesh, !!supportName && (mesh.name === supportName + '-seat'||mesh.name === supportName + '-mattress')));
      }
    };
    for (const root of [environment, items]) {
      if (!root) continue; root.updateWorldMatrix(true, true);
      const visit = (object: T.Object3D, role?: string) => {
        const nextRole = typeof object.userData.architectureRole === 'string' ? object.userData.architectureRole : role;
        if (object.userData.homeNavObstacle === true) { add(object, supports.includes(object.name) ? object.name : undefined); return; }
        if (object instanceof T.Mesh && (nextRole?.startsWith('exterior-wall') || nextRole === 'interior-partition' || nextRole === 'door' || nextRole === 'courtyard-wall')) { add(object); return; }
        object.children.forEach(child => visit(child, nextRole));
      }; visit(root);
    }
    return result;
  }
  function isClear(avatar: ContactAvatar, environment: T.Object3D | null, items: T.Object3D | null,
    from: JourneyPose, to: JourneyPose, fromBlend: number, toBlend: number, supports: readonly string[], liftArc = false,mode:ContactMode='mahjong',sleepLift=0) {
    lastCollision = null;
    const value = rig(avatar), sweep = new T.Box3().setFromPoints([new T.Vector3(from.x, from.y, from.z), new T.Vector3(to.x, to.y, to.z)]).expandByScalar(2),
      solids = obstacles(environment, items, supports, sweep), yaw = Math.atan2(Math.sin(to.yaw - from.yaw), Math.cos(to.yaw - from.yaw));
    const key = JSON.stringify([from, to, fromBlend, toBlend, supports, liftArc,mode,sleepLift, solids.map(solid => [solid.mesh.uuid, solid.mesh.geometry.uuid, ...solid.mesh.matrixWorld.elements])]);
    let results = checks.get(avatar.root); if (!results) { results = new Map(); checks.set(avatar.root, results); }
    const known = results.get(key); if (known) { lastCollision = known.collision; return known.clear; }
    const remember = (clear: boolean) => { if (results!.size >= 256) results!.delete(results!.keys().next().value!); results!.set(key, { clear, collision: lastCollision }); return clear; };
    const count = Math.max(1, Math.ceil(Math.max(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) / .025, Math.abs(yaw) / .04, Math.abs(to.tilt - from.tilt) / .04, Math.abs((to.bedSeat ?? 0) - (from.bedSeat ?? 0)) / .04, Math.abs((to.bedBreathing ?? 1) - (from.bedBreathing ?? 1)) / .02, Math.abs((to.bedLegLift ?? 0) - (from.bedLegLift ?? 0)) / .02, Math.abs(toBlend - fromBlend) / .04)));
    for (let sample = 0; sample <= count; sample++) {
      const fraction = sample / count, blend = T.MathUtils.lerp(fromBlend, toBlend, fraction), poseScale = T.MathUtils.lerp(from.scale, to.scale, fraction);
      poseRig(value, avatar, { ...from, x: T.MathUtils.lerp(from.x, to.x, fraction), y: T.MathUtils.lerp(from.y, to.y, fraction) + (liftArc ? .18 * Math.sin(Math.PI * fraction) : 0), z: T.MathUtils.lerp(from.z, to.z, fraction),
        tilt: T.MathUtils.lerp(from.tilt, to.tilt, fraction), yaw: from.yaw + yaw * fraction, scale: poseScale, bedSeat: T.MathUtils.lerp(from.bedSeat ?? 0, to.bedSeat ?? 0, fraction), bedBreathing: T.MathUtils.lerp(from.bedBreathing ?? 1, to.bedBreathing ?? 1, fraction), bedLegLift: T.MathUtils.lerp(from.bedLegLift ?? 0, to.bedLegLift ?? 0, fraction) }, blend,mode,sleepLift);
      for (const part of [value.body, ...value.arms, ...value.legs]) for (const mesh of meshes(part)) {
        const bounds = exactBounds(mesh), nearby = solids.filter(obstacle => intersects(bounds, obstacle.bounds)); if (!nearby.length) continue;
        const body = solid(mesh, false);
        for (const obstacle of nearby) {
          if (obstacle.support && bounds.min.y >= obstacle.bounds.max.y - SUPPORT_CONTACT) continue;
          const crossing = crosses(body, obstacle);
          if (crossing) { lastCollision = { obstacle: obstacle.mesh.name || obstacle.mesh.parent?.name || 'physical-solid', part: part.name, fraction, method: crossing,
            obstacleBounds: [obstacle.bounds.min.toArray(), obstacle.bounds.max.toArray()], bodyBounds: [bounds.min.toArray(), bounds.max.toArray()] }; return remember(false); }
        }
      }
    }
    return remember(true);
  }
  function sleepContactFit(avatar: ContactAvatar, environment: T.Object3D | null, items: T.Object3D | null, pose: JourneyPose, supports: readonly string[]) {
    const unchanged = { offset: 0, legLift: 0 };
    if (isClear(avatar, environment, items, pose, pose, 1, 1, supports, false, 'sleep') || !lastCollision || !/-pillow-\d+$/.test(lastCollision.obstacle)) return unchanged;
    const bed = supports.map(name => environment?.getObjectByName(name)).find(Boolean), mattress = bed?.getObjectByName(bed.name + '-mattress');
    if (!mattress) return unchanged;
    const bounds = new T.Box3().setFromObject(mattress, true), value = rig(avatar);
    for (let step = 1; step <= 25; step++) {
      const offset = step * .02 + .01; let candidate = { ...pose, z: pose.z + offset, bedLegLift: 0 }, clear = false;
      for (let level = 0; level <= 8; level++) {
        candidate = { ...candidate, bedLegLift: level * .02 };
        if (isClear(avatar, environment, items, candidate, candidate, 1, 1, supports, false, 'sleep')) { clear = true; break; }
        if (!lastCollision || !/-foot-quilt$/.test(lastCollision.obstacle) || !/^(left|right)-leg$/.test(lastCollision.part)) break;
      }
      if (!clear) continue;
      if (candidate.bedLegLift > 0) {
        let low = candidate.bedLegLift - .02, high = candidate.bedLegLift;
        for (let iteration = 0; iteration < 10; iteration++) {
          const lift = (low + high) / 2, probe = { ...candidate, bedLegLift: lift };
          if (isClear(avatar, environment, items, probe, probe, 1, 1, supports, false, 'sleep')) high = lift; else low = lift;
        }
        candidate.bedLegLift = high + .0003;
      }
      poseRig(value, avatar, candidate, 1, 'sleep');
      const bearing = [...value.legs.flatMap(part => meshes(part)), ...meshes(value.body).filter(mesh => mesh.userData.sleepBodySupport === true)];
      if (bearing.every(mesh => { const b = exactBounds(mesh); return b.min.x >= bounds.min.x && b.max.x <= bounds.max.x && b.min.z >= bounds.min.z && b.max.z <= bounds.max.z; })) return { offset, legLift: candidate.bedLegLift };
    }
    return unchanged;
  }
  function sleepPath(avatar: ContactAvatar, environment: T.Object3D | null, from: JourneyPose, to: JourneyPose, fromBlend: number, toBlend: number, supports: readonly string[]): readonly JourneyContactPoint[] {
    const waking = from.contact === 'sleep', lying = waking ? from : to, standing = waking ? to : from;
    const bed = supports.map(name => environment?.getObjectByName(name)).find(Boolean), mattress = bed?.getObjectByName(bed.name + '-mattress');
    if (!mattress) return [];
    mattress.updateWorldMatrix(true, false);
    const value = rig(avatar), vertex = new T.Vector3();
    bed!.updateWorldMatrix(true, true);
    const surfaces = meshes(bed!, true).map(mesh => solid(mesh, false)), down = new T.Ray(new T.Vector3(), new T.Vector3(0, -1, 0)), hit = new T.Vector3();
    const supportY = (pose: JourneyPose, blend: number) => {
      poseRig(value, avatar, { ...pose, y: 0 }, blend, 'sleep'); let y = -Infinity;
      for (const mesh of [...value.legs, value.body, ...value.arms].flatMap(part => meshes(part))) {
        const positions = uniquePositions(mesh.geometry);
        for (let index = 0; index < positions.count; index++) {
          vertex.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld);
          y = Math.max(y, -vertex.y);
          down.origin.set(vertex.x, 10, vertex.z);
          for (const surface of surfaces) if (vertex.y + y < surface.bounds.max.y && vertex.x >= surface.bounds.min.x && vertex.x <= surface.bounds.max.x && vertex.z >= surface.bounds.min.z && vertex.z <= surface.bounds.max.z) {
            for (const face of surface.faces) if (vertex.x >= face.bounds.min.x && vertex.x <= face.bounds.max.x && vertex.z >= face.bounds.min.z && vertex.z <= face.bounds.max.z
              && down.intersectTriangle(face.triangle.a, face.triangle.b, face.triangle.c, false, hit)) y = Math.max(y, hit.y - vertex.y);
          }
        }
      }
      // Rounded triangles can cross the quilt edge before a vertex projects
      // inside it. Resolve that remaining face contact with the same exact rig
      // sweep used for the final transfer, without exempting any bed solid.
      let low = y + .002, high = low;
      if (isClear(avatar, bed!, null, { ...pose, y: low }, { ...pose, y: low }, blend, blend, supports, false, 'sleep')) return low;
      let clear = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        const report = lastCollision; if (!report) break;
        high += Math.max(.002, report.obstacleBounds[1][1] - report.bodyBounds[0][1] + .002);
        if (isClear(avatar, bed!, null, { ...pose, y: high }, { ...pose, y: high }, blend, blend, supports, false, 'sleep')) { clear = true; break; }
      }
      if (!clear) return high;
      // The bounding-box lift above only brackets the solution. The actual
      // supporting surface, rather than the whole part's lowest corner,
      // determines the final height next to rounded quilt/bed edges.
      for (let iteration = 0; iteration < 10; iteration++) {
        const middle = (low + high) / 2, candidate = { ...pose, y: middle };
        if (isClear(avatar, bed!, null, candidate, candidate, blend, blend, supports, false, 'sleep')) high = middle; else low = middle;
      }
      return high + .0003;
    };
    // Each intermediate pose bears on the actual mattress, quilt or floor.
    // Sit up with bent knees, scoot to the original bed edge, put the feet on
    // the floor, then straighten the knees. The body never slides out upright
    // at mattress height and the furniture stays a physical obstacle.
    const path: JourneyContactPoint[] = [{ pose: { ...lying, contact: 'sleep' }, blend: waking ? fromBlend : toBlend }], initialBlend = path[0].blend;
    for (let index = 1; index <= 32; index++) {
      const t = index / 32, blend = initialBlend * (1 - t), pose = { ...lying, tilt: T.MathUtils.lerp(lying.tilt, 0, t), scale: T.MathUtils.lerp(lying.scale, standing.scale, t), bedSeat: T.MathUtils.lerp(lying.bedSeat ?? 0, 1, t), bedBreathing: T.MathUtils.lerp(lying.bedBreathing ?? 1, 1, t), contact: 'sleep' as const };
      path.push({ pose: { ...pose, y: supportY(pose, blend) }, blend });
    }
    // Face the selected long side while seated. Reversing this supported path
    // boards from the side: sit on the edge, turn with the legs on the bed,
    // then recline. Never rotate a supine body through the mattress.
    const upright=path.at(-1)!,sideways=Math.abs(standing.x-lying.x)>Math.abs(standing.z-lying.z);
    const sideYaw=sideways?Math.atan2(standing.x-lying.x,standing.z-lying.z):upright.pose.yaw;
    const turn=Math.atan2(Math.sin(sideYaw-upright.pose.yaw),Math.cos(sideYaw-upright.pose.yaw));
    if(Math.abs(turn)>EPSILON)for(let index=1;index<=32;index++){
      const pose={...upright.pose,yaw:upright.pose.yaw+turn*index/32};
      path.push({pose:{...pose,y:supportY(pose,0)},blend:0});
    }
    const sitting = path.at(-1)!;
    poseRig(value, avatar, { ...sitting.pose, x: 0, y: 0, z: 0 }, 0, 'sleep');
    const footprint = new T.Box3().setFromObject(value.root, true), bedBounds = new T.Box3().setFromObject(bed!, true);
    const overlaps = (t: number) => {
      const x = T.MathUtils.lerp(lying.x, standing.x, t), z = T.MathUtils.lerp(lying.z, standing.z, t);
      return x + footprint.min.x < bedBounds.max.x + .015 && x + footprint.max.x > bedBounds.min.x - .015
        && z + footprint.min.z < bedBounds.max.z + .015 && z + footprint.max.z > bedBounds.min.z - .015;
    };
    let edge = 1; for (let index = 1; index <= 128; index++) if (!overlaps(index / 128)) { edge = index / 128; break; }
    for (let index = 1; index <= 128; index++) {
      const t = edge * index / 128, pose = { ...sitting.pose, x: T.MathUtils.lerp(lying.x, standing.x, t), z: T.MathUtils.lerp(lying.z, standing.z, t) };
      path.push({ pose: { ...pose, y: supportY(pose, 0) }, blend: 0 });
    }
    const outside = path.at(-1)!;
    for (let index = 1; index <= 32; index++) {
      const pose = { ...outside.pose, bedSeat: 1 - index / 32 };
      path.push({ pose: { ...pose, y: supportY(pose, 0) }, blend: 0 });
    }
    path.push({ pose: { ...standing, yaw: waking ? standing.yaw : sideYaw, contact: 'sleep', bedSeat: 0 }, blend: waking ? toBlend : fromBlend });
    // Dense support sampling is for geometric planning, not one animation
    // frame per sample. Merge only chords that stay within 1mm of that path
    // and whose complete real rig sweep is clear; retain every other corner.
    const vector = (point: JourneyContactPoint) => [point.pose.x, point.pose.y, point.pose.z, point.pose.yaw * .65, point.pose.tilt * .65, point.pose.scale, point.blend * .5, (point.pose.bedSeat ?? 0) * .5, point.pose.bedBreathing ?? 1, point.pose.bedLegLift ?? 0];
    const compress = (points: readonly JourneyContactPoint[]) => {
      const compact: JourneyContactPoint[] = [points[0]];
    for (let start = 0; start < points.length - 1;) {
      const a = vector(points[start]); let end = start + 1;
      for (let candidate = end + 1; candidate < points.length; candidate++) {
        const b = vector(points[candidate]), direction = b.map((value, index) => value - a[index]), squared = direction.reduce((sum, value) => sum + value * value, 0);
        const near = points.slice(start + 1, candidate).every(point => {
          const v = vector(point).map((value, index) => value - a[index]), t = squared > EPSILON * EPSILON ? v.reduce((sum, value, index) => sum + value * direction[index], 0) / squared : 0;
          return t >= 0 && t <= 1 && Math.hypot(...v.map((value, index) => value - direction[index] * t)) <= .001;
        });
        if (!near) break;
        end = candidate;
      }
      while (end > start + 1 && !isClear(avatar, bed!, null, points[start].pose, points[end].pose, points[start].blend, points[end].blend, supports, false, 'sleep')) end--;
      compact.push(points[end]); start = end;
    }
      return compact;
    };
    const compact = compress(path);
    const refined: JourneyContactPoint[] = [compact[0]];
    const refine = (from: JourneyContactPoint, to: JourneyContactPoint, depth: number): boolean => {
      if (isClear(avatar, bed!, null, from.pose, to.pose, from.blend, to.blend, supports, false, 'sleep')) { refined.push(to); return true; }
      if (depth >= 12) return false;
      const mix = (a: number, b: number) => (a + b) / 2, blend = mix(from.blend, to.blend), pose: JourneyPose = { ...from.pose,
        x: mix(from.pose.x, to.pose.x), y: mix(from.pose.y, to.pose.y), z: mix(from.pose.z, to.pose.z), yaw: mix(from.pose.yaw, to.pose.yaw), tilt: mix(from.pose.tilt, to.pose.tilt), scale: mix(from.pose.scale, to.pose.scale),
        bedSeat: mix(from.pose.bedSeat ?? 0, to.pose.bedSeat ?? 0), bedBreathing: mix(from.pose.bedBreathing ?? 1, to.pose.bedBreathing ?? 1), bedLegLift: mix(from.pose.bedLegLift ?? 0, to.pose.bedLegLift ?? 0) };
      const middle = { pose: { ...pose, y: supportY(pose, blend) }, blend };
      return refine(from, middle, depth + 1) && refine(middle, to, depth + 1);
    };
    // Even an unmerged neighbouring support pair can cut a curved edge. Every
    // leaf segment must pass; an unresolved segment remains blocked by the
    // controller's normal guard, never accepted at a recursion limit.
    for (let index = 1; index < compact.length; index++) if (!refine(compact[index - 1], compact[index], 0)) return waking ? compact : compact.reverse();
    const finalPath = compress(refined);
    return waking ? finalPath : finalPath.reverse();
  }
  return { isClear, radius, sleepContactFit, sleepPath, getLastCollision: () => lastCollision };
}
