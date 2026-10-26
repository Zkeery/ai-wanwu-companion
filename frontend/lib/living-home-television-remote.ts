import * as THREE from 'three';
import type { HomeTeaAvatar } from './living-home-tea-grip';
import type { HomeLeisureSeat, HomeLeisureSnapshot } from './living-home-leisure';

type Rig = HomeTeaAvatar & { leftArm: THREE.Object3D };
export type HomeTelevisionRemoteSnapshot = Readonly<{heldByActorId:number|null;buttonPressed:boolean}>;
const smooth = (v: number) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };

/** One shared, local television remote. Uses the caller's frozen elapsed clock. */
export function createHomeTelevisionRemote() {
  let remote: THREE.Group | null = null, restWorld: THREE.Object3D | null = null;
  let restParent: THREE.Object3D | null = null, disposed = false;
  const restPosition = new THREE.Vector3(), restQuaternion = new THREE.Quaternion();
  function restore() {
    if (!remote || !restParent) return;
    restParent.add(remote); remote.position.copy(restPosition); remote.quaternion.copy(restQuaternion);
    remote.scale.set(1, 1, 1); remote.matrixAutoUpdate = true; remote.updateMatrix();
    delete remote.userData.heldByActorId; remote.userData.buttonPressed = false;
  }
  function clear() {
    if (!remote) return;
    restore(); remote.removeFromParent();
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    remote.traverse(object => { if (!(object instanceof THREE.Mesh)) return; geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) { materials.add(material); const map = (material as THREE.MeshStandardMaterial).map; if (map) textures.add(map); }
    });
    geometries.forEach(value => value.dispose()); materials.forEach(value => value.dispose()); textures.forEach(value => value.dispose());
    remote = null; restWorld = restParent = null;
  }
  function create(world: THREE.Object3D, seat: HomeLeisureSeat) {
    remote = new THREE.Group(); remote.name = 'home-television-remote'; remote.userData.homeTelevisionRemote = true;
    const body = new THREE.Mesh(new THREE.BoxGeometry(.075, .024, .205), new THREE.MeshStandardMaterial({ color: '#292c2d', roughness: .7 }));
    body.name = 'home-television-remote-body'; body.castShadow = true; remote.add(body);
    let texture: THREE.CanvasTexture | null = null;
    try {
      const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 640;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#373b3e'; ctx.fillRect(0, 0, 256, 640);
        ctx.fillStyle = '#bc594c'; ctx.beginPath(); ctx.arc(58, 62, 22, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#929b9b'; ctx.beginPath(); ctx.arc(128, 222, 66, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#313639'; ctx.beginPath(); ctx.arc(128, 222, 36, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#b4baba';
        for (let row = 0; row < 4; row++) for (let column = 0; column < 3; column++) ctx.fillRect(38 + column * 67, 352 + row * 61, 43, 33);
        texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
      }
    } catch { /* A plain visible remote remains available without canvas. */ }
    const controls = new THREE.Mesh(new THREE.PlaneGeometry(.068, .19), new THREE.MeshStandardMaterial({ color: texture ? '#ffffff' : '#777e80', map: texture, roughness: .8 }));
    controls.name = 'home-television-remote-controls'; controls.rotation.x = -Math.PI / 2; controls.position.y = .0126; remote.add(controls);
    restWorld = world; restParent = world.getObjectByName('room-side-table') ?? world;
    restPosition.copy(restParent === world ? world.worldToLocal(new THREE.Vector3(seat.x + .4, seat.y, seat.z)) : new THREE.Vector3(-2.92, .713, -1.94));
    restQuaternion.identity(); restore();
  }
  return {
    update(world: THREE.Object3D | null, avatars: ReadonlyMap<number, Rig>, snapshot: HomeLeisureSnapshot, seats: readonly HomeLeisureSeat[], elapsed: number) {
      if (disposed) return;
      if (world && restWorld && restWorld !== world) clear();
      const rows = snapshot.television.powered ? snapshot.assignments.filter(row => row.activity === 'television')
        .map(row => ({ row, rig: avatars.get(row.actorId), seat: seats.find(seat => seat.id === row.seatId && seat.station === 'television') }))
        .filter(entry => entry.rig && entry.seat && !!entry.rig.root.userData.roomRestSeat && !entry.rig.root.userData.homeJourney?.active && entry.rig.root.visible)
        .sort((a, b) => a.row.seatId.localeCompare(b.row.seatId) || a.row.actorId - b.row.actorId) : [];
      const owner = rows[0];
      if (!world || !owner || !Number.isFinite(elapsed)) { restore(); return; }
      if (!remote) create(world, owner.seat!);
      const object = remote!, rig = owner.rig!, time = Math.max(0, elapsed - owner.row.startedAtElapsed), phase = time % 18;
      if (phase >= 13.5) { restore(); return; }
      const aim = smooth((phase - .5) / .7) * (1 - smooth((phase - 3.5) / .7));
      const press = phase >= 1.6 && phase < 2.1 ? Math.max(0, Math.sin((phase - 1.6) * Math.PI * 2)) : 0;
      rig.leftArm.rotation.x = -.65 - aim * .55 - press * .025; rig.leftArm.rotation.z = .2 + aim * .14;
      rig.root.updateWorldMatrix(true, true); const scale = rig.leftArm.getWorldScale(new THREE.Vector3());
      if ([scale.x, scale.y, scale.z].some(value => !Number.isFinite(value) || Math.abs(value) < 1e-8)) { restore(); return; }
      rig.leftArm.add(object); object.position.set(-.075, -.235, .075); object.rotation.set(.2 - press * .025, 0, -.12);
      object.scale.set(1 / Math.abs(scale.x), 1 / Math.abs(scale.y), 1 / Math.abs(scale.z)); object.updateMatrix();
      object.userData.heldByActorId = owner.row.actorId; object.userData.buttonPressed = press > .3;
    },
    getSnapshot(): HomeTelevisionRemoteSnapshot {
      const actorId = remote?.userData.heldByActorId;
      return Object.freeze({heldByActorId:Number.isSafeInteger(actorId)&&actorId>0?actorId:null,buttonPressed:!!remote?.userData.buttonPressed});
    },
    restore,
    reset() { if (!disposed) clear(); },
    dispose() { if (disposed) return; clear(); disposed = true; },
  };
}
