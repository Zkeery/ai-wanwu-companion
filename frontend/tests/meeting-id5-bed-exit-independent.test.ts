import * as THREE from 'three';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import current from './fixtures/id5-current-g58-20261025.json';
import type {LivingAvatarMesh} from '@/lib/living-meshes';
import {createLivingWorld} from '@/lib/living-world-engine';
import {parseGathering} from '@/lib/gatherings';

const gpu = vi.hoisted(() => ({instances: [] as Array<{scene: THREE.Scene | null; loop: ((time: number) => void) | null}>}));
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class OfflineRenderer {
    domElement = document.createElement('canvas'); shadowMap = {enabled: false, type: 0}; outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 1;
    scene: THREE.Scene | null = null; loop: ((time: number) => void) | null = null;
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn();
    setAnimationLoop = vi.fn((loop: ((time: number) => void) | null) => { this.loop = loop; });
    render = vi.fn((scene: THREE.Scene, camera: THREE.Camera) => {scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); this.scene = scene;});
    constructor() {gpu.instances.push(this);}
  }
  return {...actual, WebGLRenderer: OfflineRenderer};
});
const captured = vi.hoisted(() => ({avatars: [] as Array<LivingAvatarMesh & {baseScale: THREE.Vector3}>}));
vi.mock('@/lib/living-meshes', async original => {
  const actual = await original<typeof import('@/lib/living-meshes')>();
  return {...actual, buildAvatar: (...args: Parameters<typeof actual.buildAvatar>) => {
    const avatar = actual.buildAvatar(...args); captured.avatars.push({...avatar, baseScale: avatar.root.scale.clone()}); return avatar;
  }};
});
const worlds: Array<ReturnType<typeof createLivingWorld>> = [];
beforeEach(() => {
  captured.avatars = []; gpu.instances = []; vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {}});
  for (const key of ['fetch', 'Audio', 'AudioContext']) vi.stubGlobal(key, vi.fn(() => {throw new Error('OFFLINE_ONLY');}));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  worlds.splice(0).forEach(world => world.dispose());
  expect(fetch).not.toHaveBeenCalled(); expect(Audio).not.toHaveBeenCalled(); expect(AudioContext).not.toHaveBeenCalled();
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

/** Independent measurement of rendered vertices, without collision/support helpers. */
function vertices(parts: readonly THREE.Object3D[]) {
  const result: THREE.Vector3[] = [];
  for (const part of parts) part.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute('position');
    for (let index = 0; index < position.count; index++) result.push(new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld));
  });
  return result;
}

/** Closed-mesh parity plus real surface distance avoids treating rounded-box air corners as mattress. */
function physicalSolid(mesh: THREE.Mesh) {
  const positions = mesh.geometry.getAttribute('position'), indices = mesh.geometry.index, faces: THREE.Triangle[] = [];
  for (let index = 0; index < (indices?.count ?? positions.count); index += 3) {
    const points = [0, 1, 2].map(offset => new THREE.Vector3().fromBufferAttribute(positions, indices ? indices.getX(index + offset) : index + offset).applyMatrix4(mesh.matrixWorld));
    faces.push(new THREE.Triangle(points[0], points[1], points[2]));
  }
  const bounds = new THREE.Box3().setFromObject(mesh, true).expandByScalar(-.006), ray = new THREE.Ray(), hit = new THREE.Vector3(), closest = new THREE.Vector3();
  const center = bounds.getCenter(new THREE.Vector3()), points = vertices([mesh]), unique = new Map<string, THREE.Plane>();
  for (const face of faces) {
    const plane = new THREE.Plane().setFromCoplanarPoints(face.a, face.b, face.c);
    if (plane.normal.lengthSq() < .5) continue;
    if (plane.distanceToPoint(center) > 0) plane.negate();
    const key = [...plane.normal.toArray(), plane.constant].map(value => value.toFixed(7)).join('/'); unique.set(key, plane);
  }
  const planes = [...unique.values()], convex = planes.length >= 4 && planes.every(plane => points.every(point => plane.distanceToPoint(point) <= 1e-6));
  const direction = new THREE.Vector3(1, .173205080756, .271828182845).normalize();
  return {bounds, convex, planeCount: planes.length, faceCount: faces.length, penetrates(point: THREE.Vector3) {
    if (!bounds.containsPoint(point)) return false;
    if (convex) return planes.every(plane => plane.distanceToPoint(point) < -.006);
    ray.set(point, direction); const crossings: number[] = []; let distance = Infinity;
    for (const face of faces) {
      distance = Math.min(distance, face.closestPointToPoint(point, closest).distanceTo(point));
      if (ray.intersectTriangle(face.a, face.b, face.c, false, hit)) {
        const value = hit.distanceTo(point); if (value > 1e-7 && !crossings.some(previous => Math.abs(previous - value) < 1e-7)) crossings.push(value);
      }
    }
    return crossings.length % 2 === 1 && distance > .006;
  }};
}

/** Exact vertical ray/triangle intersections indexed in XZ; independent of production support code. */
function supportingBedGap(bed: THREE.Object3D) {
  type Face = {a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3; denominator: number};
  const cells = new Map<string, Face[]>(), size = .2;
  bed.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const positions = object.geometry.getAttribute('position'), indices = object.geometry.index;
    for (let index = 0; index < (indices?.count ?? positions.count); index += 3) {
      const [a, b, c] = [0, 1, 2].map(offset => new THREE.Vector3().fromBufferAttribute(positions, indices ? indices.getX(index + offset) : index + offset).applyMatrix4(object.matrixWorld));
      const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      if (Math.abs(denominator) < 1e-12) continue;
      const face = {a, b, c, denominator};
      for (let x = Math.floor(Math.min(a.x, b.x, c.x) / size); x <= Math.floor(Math.max(a.x, b.x, c.x) / size); x++)
        for (let z = Math.floor(Math.min(a.z, b.z, c.z) / size); z <= Math.floor(Math.max(a.z, b.z, c.z) / size); z++) {
          const key = x + '/' + z, faces = cells.get(key) ?? []; faces.push(face); cells.set(key, faces);
        }
    }
  });
  return (point: THREE.Vector3) => {
    let gap = Infinity;
    for (const {a, b, c, denominator} of cells.get(Math.floor(point.x / size) + '/' + Math.floor(point.z / size)) ?? []) {
      const u = ((b.z - c.z) * (point.x - c.x) + (c.x - b.x) * (point.z - c.z)) / denominator;
      const v = ((c.z - a.z) * (point.x - c.x) + (a.x - c.x) * (point.z - c.z)) / denominator, w = 1 - u - v;
      if (u < -1e-8 || v < -1e-8 || w < -1e-8) continue;
      const distance = point.y - u * a.y - v * b.y - w * c.y;
      if (distance >= -.006) gap = Math.min(gap, Math.max(0, distance));
    }
    return gap;
  };
}

it.each([[100, 1000], [1000 / 60, 1000], [100, 10_000], [1000 / 60, 10_000]])('real id5 rendered bed exit stays clear at %s ms frames after %s ms sleep', (frameMs, warmupMs) => {
  const source = {...structuredClone(current.group), me: 'fixture-owner-1', companions: current.group.companions.map(companion => companion.id === 5
    ? {...companion, activity: 'sleep', area: 'bedroom', x: .35, y: .65, leisure: null} : companion)};
  const initial = parseGathering(source), sourceItems = JSON.stringify(initial.items), host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, {clientWidth: {value: 390}, clientHeight: {value: 845}}); document.body.append(host, labels);
  const requested = vi.fn(), world = createLivingWorld(host, labels, initial, vi.fn(), vi.fn(), {persistentWorld: true, realistic: true,
    localLeisurePreview: true, localRoomTransitions: true, localCompanionDoors: true, localReferenceVilla: true,
    localNaturalWorld: true, localNaturalLeisure: true, localQuietAudio: true, onLeisureRequest: requested});
  worlds.push(world); world.setHouseView('interior'); world.update(initial, 5, 'bedroom'); world.setMotion(true);
  const renderer = gpu.instances.at(-1)!, scene = renderer.scene!, avatar = captured.avatars.find(value => value.root.userData.characterId === 5)!, actor = avatar.root;
  let simulationNow = Date.now();
  const step = () => {simulationNow += frameMs; vi.setSystemTime(Math.round(simulationNow)); renderer.loop!(Date.now());};
  const warmupStartedAt = Date.now();
  for (let index = 0; index < Math.ceil(warmupMs / frameMs); index++) step();
  const actualWarmupMs = Date.now() - warmupStartedAt;
  expect(actor.userData.sleepingBed).toBeTruthy();
  const initialSleepFit = {offset: actor.userData.sleepContactOffset ?? 0, legLift: actor.userData.sleepLegLift ?? 0};
  expect(initialSleepFit).toEqual({offset: 0, legLift: 0});
  const bed = scene.getObjectByName('room-bed-0')!, mattress = bed.getObjectByName('room-bed-0-mattress')!, base = bed.children.find(object => object instanceof THREE.Mesh && Math.abs(object.position.y - .35) < 1e-6)!;
  const mattressSolid = physicalSolid(mattress as THREE.Mesh), woodSolid = physicalSolid(base as THREE.Mesh);
  const bedGap = supportingBedGap(bed);
  const mattressBounds = new THREE.Box3().setFromObject(mattress, true), referenceRay = new THREE.Raycaster();
  expect(mattressSolid.penetrates(mattressBounds.getCenter(new THREE.Vector3())), 'physical mattress center is a negative collision control').toBe(true);
  expect(woodSolid.penetrates(new THREE.Box3().setFromObject(base, true).getCenter(new THREE.Vector3())), 'physical wooden base center is a negative collision control').toBe(true);
  const nearTop = mattressBounds.getCenter(new THREE.Vector3()); nearTop.y = mattressBounds.max.y - .003;
  expect(mattressSolid.penetrates(nearTop), 'declared 6mm contact tolerance stays explicit').toBe(false);
  for (const [x, z] of [[.5, .5], [.5, .2], [.5, .8], [.2, .5], [.8, .5]]) {
    const point = new THREE.Vector3(THREE.MathUtils.lerp(mattressBounds.min.x, mattressBounds.max.x, x), 3, THREE.MathUtils.lerp(mattressBounds.min.z, mattressBounds.max.z, z));
    referenceRay.set(point, new THREE.Vector3(0, -1, 0));
    expect(bedGap(point), 'indexed physical support projection agrees with independent Three raycast').toBeCloseTo(referenceRay.intersectObject(bed, true)[0].distance, 7);
  }
  const obstacleSnapshot = () => {
    const result: unknown[] = [];
    scene.traverse(object => {if ((object.userData.homeNavObstacle && !/door/.test(object.name) && !object.userData.localMotion) || object.name === 'villa-indoor-stair') result.push([object.name, object.matrixWorld.elements.slice()]);});
    return JSON.stringify(result);
  };
  const originalObstacles = obstacleSnapshot(), bearing: THREE.Object3D[] = []; avatar.body.traverse(object => {if (object.userData.sleepBodySupport) bearing.push(object);});
  const parts = [avatar.body, avatar.leftArm, avatar.rightArm, avatar.leftLeg, avatar.rightLeg];
  const feet = [avatar.leftKnee, avatar.rightKnee].map(knee => knee.children.find(object => object instanceof THREE.Mesh && object.geometry instanceof THREE.SphereGeometry)!);
  const hands = [avatar.leftArm, avatar.rightArm].map(arm => arm.children.find(object => object instanceof THREE.Mesh && Math.abs(object.position.y + .265) < 1e-6)!);
  expect(hands.every(hand => hand instanceof THREE.Mesh)).toBe(true);
  let previousVertices = vertices(parts), previousPosition = actor.position.clone();
  expect(previousVertices.filter(point => mattressSolid.penetrates(point) || woodSolid.penetrates(point))).toHaveLength(0);
  const next = parseGathering({...source, revision: source.revision + 1, companions: source.companions.map(companion => companion.id === 5
    ? {...companion, activity: 'observe', area: 'outdoor', x: .65, y: .55, leisure: null} : companion), events: []});
  const nextCopy = JSON.stringify(next); world.update(next, 5, 'bedroom'); const exitStartedAt = Date.now();
  let firstSolid: unknown = null, firstGroundIssue: unknown = null, minScale = Infinity, maxScale = 0, maxJump = 0, arrivedAt: number | null = null, arrivedElapsedMs: number | null = null, undockEndedElapsedMs: number | null = null; let sawUndock = false;
  const ray = new THREE.Ray(), direction = new THREE.Vector3(), hit = new THREE.Vector3();
  let maximumSupportGap = 0, maximumFootTorsoSupportGap = 0, maximumHandFootTorsoSupportGap = 0, unsupportedTransferMs = 0, unsupportedHorizontalDistance = 0, firstUnsupported: unknown = null;
  const transferSamples: unknown[] = []; let supportStamp = '', priorSupportGap = 0, priorFootTorsoGap = 0, priorHandFootTorsoGap = 0;
  for (let frame = 0; frame < Math.ceil(80_000 / frameMs); frame++) {
    const beforeTime = Date.now(); step(); const actualFrameMs = Date.now() - beforeTime, actual = vertices(parts), feetVertices = vertices(feet), journey = actor.userData.homeJourney;
    const scale = actor.scale.x / avatar.baseScale.x; minScale = Math.min(minScale, scale); maxScale = Math.max(maxScale, scale);
    maxJump = Math.max(maxJump, actor.position.distanceTo(previousPosition));
    for (let index = 0; index < actual.length && firstSolid === null; index++) {
      for (const [kind, solid] of [['mattress', mattressSolid], ['wood', woodSolid]] as const) {
        if (solid.penetrates(actual[index])) {firstSolid = {frame, kind, method: 'vertex_inside', point: actual[index].toArray()}; break;}
        const length = direction.subVectors(actual[index], previousVertices[index]).length();
        if (length <= 1e-8) continue;
        ray.set(previousVertices[index], direction.multiplyScalar(1 / length));
        if (ray.intersectBox(solid.bounds, hit) && hit.distanceTo(previousVertices[index]) < length - 1e-6) {
          const start = hit.distanceTo(previousVertices[index]);
          for (let distance = start; distance < length; distance += .006) {
            const sample = previousVertices[index].clone().addScaledVector(direction, distance);
            if (solid.penetrates(sample)) {firstSolid = {frame, kind, method: 'render_vertex_sweep', point: sample.toArray()}; break;}
          }
        }
      }
    }
    const lowestFoot = Math.min(...feetVertices.map(point => point.y));
    if (journey?.phase === 'undock') {
      sawUndock = true;
      let supportGap = priorSupportGap, footTorsoGap = priorFootTorsoGap, handFootTorsoGap = priorHandFootTorsoGap;
      const stamp = JSON.stringify([actor.matrixWorld.elements, journey.contactBlend, journey.pose.bedSeat, journey.pose.bedBreathing, journey.pose.bedLegLift]);
      if (stamp !== supportStamp) {
      supportGap = Math.max(0, lowestFoot);
      const samples = [...feet.map(foot => vertices([foot]).sort((a, b) => a.y - b.y).slice(0, 8)), ...bearing.map(part => vertices([part]).sort((a, b) => a.y - b.y).slice(0, 12))].flat();
      for (const point of samples) {
        supportGap = Math.min(supportGap, bedGap(point));
      }
      footTorsoGap = supportGap;
      for (const hand of hands) for (const point of vertices([hand]).sort((a, b) => a.y - b.y).slice(0, 8)) supportGap = Math.min(supportGap, bedGap(point));
      handFootTorsoGap = supportGap;
      for (const point of actual) supportGap = Math.min(supportGap, bedGap(point));
      supportStamp = stamp; priorSupportGap = supportGap; priorFootTorsoGap = footTorsoGap; priorHandFootTorsoGap = handFootTorsoGap;
      }
      maximumSupportGap = Math.max(maximumSupportGap, supportGap); maximumFootTorsoSupportGap = Math.max(maximumFootTorsoSupportGap, footTorsoGap); maximumHandFootTorsoSupportGap = Math.max(maximumHandFootTorsoSupportGap, handFootTorsoGap);
      transferSamples.push({frame, elapsedMs: Date.now() - exitStartedAt, root: actor.position.toArray(), lowestFoot, lowestRendered: Math.min(...actual.map(point => point.y)), supportGap, footTorsoGap, handFootTorsoGap, lowestHand: Math.min(...vertices(hands).map(point => point.y)), blend: journey.contactBlend, tilt: actor.rotation.x});
      if (supportGap > .03) {
        unsupportedTransferMs += actualFrameMs; unsupportedHorizontalDistance += Math.hypot(actor.position.x - previousPosition.x, actor.position.z - previousPosition.z);
        firstUnsupported ??= {frame, supportGap, position: actor.position.toArray(), blend: journey.contactBlend};
      }
    }
    if (firstGroundIssue === null && (journey?.phase === 'undock' || (!journey?.active && actor.userData.homeRegion === 'outdoor')) && (Math.min(...actual.map(point => point.y)) < -.006 || (!journey?.pose.contact && Math.abs(actor.rotation.x) < 1e-6 && lowestFoot > .006)))
      firstGroundIssue = {frame, lowestFoot, position: actor.position.toArray(), phase: journey?.phase};
    if (sawUndock && journey?.phase !== 'undock' && undockEndedElapsedMs === null) undockEndedElapsedMs = Date.now() - exitStartedAt;
    if (arrivedAt === null && actor.userData.homeRegion === 'outdoor' && !journey?.active) {arrivedAt = frame; arrivedElapsedMs = Date.now() - exitStartedAt;}
    previousVertices = actual; previousPosition = actor.position.clone();
    if (arrivedAt !== null && frame >= arrivedAt + 10) break;
  }
  const metrics = {frameMs, warmupMs, actualWarmupMs, initialSleepFit, firstSolid, firstGroundIssue, minScale, maxScale, maxJump, arrivedAt, arrivedElapsedMs, undockEndedElapsedMs,
    maximumSupportGap, maximumFootTorsoSupportGap, maximumHandFootTorsoSupportGap, unsupportedTransferMs, unsupportedHorizontalDistance, firstUnsupported, transferSamples, solidProbe: {mattress: {convex: mattressSolid.convex, planes: mattressSolid.planeCount, faces: mattressSolid.faceCount}, wood: {convex: woodSolid.convex, planes: woodSolid.planeCount, faces: woodSolid.faceCount}}, finalContactCollision: actor.userData.contactCollision, rendererCount: gpu.instances.length, obstacleTransformsPreserved: obstacleSnapshot() === originalObstacles};
  console.info('INDEPENDENT_BED_EXIT_METRICS ' + JSON.stringify(metrics));
  if (process.env.BED_EXIT_METRICS_DIR) {
    mkdirSync(process.env.BED_EXIT_METRICS_DIR, {recursive: true});
    writeFileSync(join(process.env.BED_EXIT_METRICS_DIR, `warmup-${warmupMs}-frame-${Math.round(frameMs * 1000)}us.json`), JSON.stringify(metrics, null, 2) + '\n');
  }
  expect(firstSolid, 'rendered volume and swept vertices stay outside actual mattress/wood solids beyond the declared 6mm contact tolerance').toBeNull();
  expect(firstGroundIssue, 'bed-transfer geometry stays above ground and final standing feet meet the floor').toBeNull(); expect(arrivedAt, 'the physical journey must finish in the courtyard').not.toBeNull();
  expect(minScale).toBeGreaterThanOrEqual(.9 - 1e-6); expect(maxScale).toBeLessThanOrEqual(1 + 1e-6); expect(maxJump).toBeLessThan(.3);
  expect(JSON.stringify(next)).toBe(nextCopy); expect(JSON.stringify(next.items)).toBe(sourceItems); expect(requested).not.toHaveBeenCalled();
  expect(obstacleSnapshot()).toBe(originalObstacles); expect(gpu.instances).toHaveLength(1);
}, 120_000);
