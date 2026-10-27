import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { LivingAvatarMesh } from './living-meshes';
import { privateImageBlob } from './private-images';
import { getToken } from './auth';
import { authHeaders } from './auth';
import { appFetch as fetch } from './base-path';

export type CourtyardCompanion = { id: number; portrait?: string; courtyard_figure?: 'pending' | 'ready' | 'failed' };
type Hop = { x: number; z: number; fromX: number; fromZ: number; toX: number; toZ: number; started: number; active: boolean; pending: number };

const HOP_DISTANCE = 0.42;
const HOP_SECONDS = 0.36;
const parts = (avatar: LivingAvatarMesh) => [avatar.body, avatar.leftArm, avatar.rightArm, avatar.leftLeg, avatar.rightLeg];

export function courtyardHop(hop: Hop, now: number, x: number, z: number): { x: number; y: number; z: number; active: boolean } {
  const moved = Math.hypot(x - hop.x, z - hop.z);
  hop.x = x; hop.z = z;
  if (!hop.active && moved >= 0.012) hop.pending += moved;
  if (!hop.active && hop.pending >= HOP_DISTANCE) {
    hop.active = true; hop.started = now; hop.pending = 0;
    hop.fromX = hop.toX; hop.fromZ = hop.toZ; hop.toX = x; hop.toZ = z;
  }
  if (!hop.active) return { x: hop.toX, y: 0, z: hop.toZ, active: false };
  const t = Math.min(1, (now - hop.started) / HOP_SECONDS);
  if (t >= 1) hop.active = false;
  return {
    x: hop.fromX + (hop.toX - hop.fromX) * t,
    y: Math.sin(Math.PI * t) * 0.16,
    z: hop.fromZ + (hop.toZ - hop.fromZ) * t,
    active: t < 1,
  };
}

function stateOf(root: THREE.Object3D) {
  const current = root.userData.courtyardFigure as {
    group: THREE.Group; mode: string; key: string; token: number; hop: Hop; yaw: number;
  } | undefined;
  if (current) return current;
  const group = new THREE.Group();
  group.name = 'courtyard-figure';
  root.add(group);
  const created = {
    group, mode: '', key: '', token: 0, yaw: root.rotation.y,
    hop: { x: root.position.x, z: root.position.z, fromX: root.position.x, fromZ: root.position.z, toX: root.position.x, toZ: root.position.z, started: 0, active: false, pending: 0 },
  };
  root.userData.courtyardFigure = created;
  return created;
}

function clear(group: THREE.Group) {
  for (const child of [...group.children]) {
    child.traverse(object => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          const map = 'map' in material ? material.map : null;
          if (map instanceof THREE.Texture) map.dispose();
          material.dispose();
        }
      }
    });
    group.remove(child);
  }
}

function shadow(parent: THREE.Object3D, width: number) {
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(Math.max(0.28, width * 0.34), 28),
    new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.18, depthWrite: false }),
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.012;
  disc.name = 'courtyard-shadow';
  parent.add(disc);
}

async function softenBackground(blob: Blob): Promise<HTMLCanvasElement | ImageBitmap> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) return bitmap;
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = image.data;
  const sample = (x: number, y: number) => {
    const index = (y * canvas.width + x) * 4;
    return [pixels[index], pixels[index + 1], pixels[index + 2]] as const;
  };
  const corners = [sample(1, 1), sample(canvas.width - 2, 1), sample(1, canvas.height - 2), sample(canvas.width - 2, canvas.height - 2)];
  const average = corners.reduce((sum, color) => [sum[0] + color[0], sum[1] + color[1], sum[2] + color[2]], [0, 0, 0]).map(value => value / 4);
  const similar = corners.every(color => Math.hypot(color[0] - average[0], color[1] - average[1], color[2] - average[2]) < 36);
  if (!similar) return canvas;
  for (let index = 0; index < pixels.length; index += 4) {
    const distance = Math.hypot(pixels[index] - average[0], pixels[index + 1] - average[1], pixels[index + 2] - average[2]);
    if (distance < 42) pixels[index + 3] = 0;
    else if (distance < 68) pixels[index + 3] = Math.round((distance - 42) / 26 * 255);
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function showStandee(group: THREE.Group, texture: THREE.Texture) {
  clear(group);
  texture.colorSpace = THREE.SRGBColorSpace;
  const image = texture.image as { width?: number; height?: number };
  const aspect = image?.width && image?.height ? image.width / image.height : 0.72;
  const height = 1.72;
  const width = Math.min(1.15, height * aspect);
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.04, side: THREE.DoubleSide, depthWrite: false }),
  );
  board.position.y = height / 2;
  board.name = 'courtyard-standee';
  group.add(board);
  shadow(group, width);
}

function sleepMark() {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 64;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = 'rgba(255,253,247,0.94)';
    context.beginPath();
    if (typeof context.roundRect === 'function') context.roundRect(4, 4, 120, 56, 18);
    else context.rect(4, 4, 120, 56);
    context.fill();
    context.fillStyle = '#5c4a58';
    context.font = '700 36px sans-serif';
    context.fillText('Zzz', 28, 44);
  }
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(0.5, 0.25, 1);
  sprite.position.set(0.22, 1.15, 0.42);
  sprite.name = 'courtyard-zzz';
  return sprite;
}

function showMesh(group: THREE.Group, root: THREE.Object3D) {
  clear(group);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const height = Math.max(size.y, 0.001);
  const scale = 1.7 / height;
  root.scale.setScalar(scale);
  root.position.copy(center).multiplyScalar(-scale);
  root.position.y += 0.85;
  root.name = 'courtyard-mesh';
  reveal(root);
  group.add(root);
  shadow(group, size.x * (1.7 / height));
}

function reveal(root: THREE.Object3D) {
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!('color' in material) || !('emissive' in material) || !('emissiveMap' in material)) continue;
      const colored = material.color.r + material.color.g + material.color.b;
      if (colored < 0.05 && material.emissiveMap) {
        material.color.set('#ffffff');
        material.map = material.emissiveMap;
        material.emissive.set('#ffffff');
        material.emissiveIntensity = 1;
        material.needsUpdate = true;
      }
    }
  });
}

export function updateCourtyardFigure(
  avatar: LivingAvatarMesh, companion: CourtyardCompanion, camera: THREE.Camera,
  now: number, motion: boolean, sceneType: string,
) {
  const figure = stateOf(avatar.root);
  const portrait = companion.portrait && companion.portrait.startsWith('/uploads/') ? companion.portrait : '';
  const ready = companion.courtyard_figure === 'ready';
  const sameFigure = sceneType === 'home' && (!!portrait || ready);
  for (const part of parts(avatar)) part.visible = !sameFigure;
  figure.group.visible = sameFigure;
  if (!sameFigure) return;
  const key = ready ? `mesh:${companion.id}` : `standee:${portrait}`;
  const showPortrait = (token: number, tokenValue: string) => {
    const controller = new AbortController();
    void privateImageBlob(portrait, tokenValue, controller.signal).then(async blob => {
      if (token !== figure.token) return;
      const source = await softenBackground(blob);
      if (token !== figure.token) return;
      const texture = new THREE.Texture(source);
      texture.needsUpdate = true;
      if (figure.group.getObjectByName('courtyard-mesh')) return;
      figure.mode = 'standee';
      showStandee(figure.group, texture);
    }).catch(() => undefined);
  };
  if (figure.key !== key) {
    figure.key = key; figure.mode = ready ? 'mesh' : 'standee';
    const token = ++figure.token;
    const tokenValue = getToken();
    if (portrait && tokenValue) showPortrait(token, tokenValue);
    if (ready && tokenValue) {
      void fetch(`/api/v1/characters/${companion.id}/courtyard-mesh`, { headers: authHeaders(tokenValue) })
        .then(response => { if (!response.ok) throw new Error('mesh'); return response.arrayBuffer(); })
        .then(buffer => new Promise<void>((resolve, reject) => {
          if (token !== figure.token) return resolve();
          new GLTFLoader().parse(buffer, '', gltf => {
            if (token !== figure.token) return resolve();
            figure.mode = 'mesh';
            showMesh(figure.group, gltf.scene);
            resolve();
          }, () => reject(new Error('mesh')));
        })).catch(() => { if (token === figure.token && portrait && tokenValue) showPortrait(token, tokenValue); });
    }
  }
  const lying = Math.abs(avatar.root.rotation.x) > 0.35;
  const mark = figure.group.getObjectByName('courtyard-zzz');
  if (lying) {
    if (!mark) figure.group.add(sleepMark());
    else mark.visible = true;
  } else if (mark) mark.visible = false;
  const groundShadow = figure.group.getObjectByName('courtyard-shadow');
  if (groundShadow) groundShadow.visible = !lying;
  if (lying) {
    const prone = figure.mode === 'mesh';
    figure.group.position.set(0, 0, 0);
    figure.group.rotation.set(0, prone ? Math.PI : 0, 0);
    figure.group.scale.set(1, 1, 1);
    const zzz = figure.group.getObjectByName('courtyard-zzz');
    if (zzz) zzz.position.set(prone ? -0.22 : 0.22, 1.15, prone ? -0.42 : 0.42);
    const mattress = avatar.root.userData.sleepMattressY;
    const body = figure.group.getObjectByName('courtyard-mesh') ?? figure.group.getObjectByName('courtyard-standee');
    if (body && typeof mattress === 'number' && Number.isFinite(mattress)) {
      figure.group.updateWorldMatrix(true, true);
      const bounds = new THREE.Box3().setFromObject(body);
      if (Number.isFinite(bounds.min.y)) {
        const surface = avatar.root.parent
          ? avatar.root.parent.localToWorld(new THREE.Vector3(0, mattress, 0)).y
          : mattress;
        const from = figure.group.getWorldPosition(new THREE.Vector3());
        const to = from.clone().add(new THREE.Vector3(0, surface + 0.02 - bounds.min.y, 0));
        figure.group.position.add(avatar.root.worldToLocal(to).sub(avatar.root.worldToLocal(from)));
      }
    }
    return;
  }
  const place = courtyardHop(figure.hop, now, avatar.root.position.x, avatar.root.position.z);
  figure.group.position.set(0, place.y, 0);
  const world = avatar.root.getWorldPosition(new THREE.Vector3());
  const facingCamera = Math.atan2(camera.position.x - world.x, camera.position.z - world.z);
  const desired = figure.mode === 'standee' ? facingCamera : avatar.root.rotation.y;
  const delta = Math.atan2(Math.sin(desired - figure.yaw), Math.cos(desired - figure.yaw));
  figure.yaw += Math.max(-0.08, Math.min(0.08, delta));
  const idle = !place.active && motion;
  figure.group.rotation.set(0, figure.yaw - avatar.root.rotation.y, idle ? Math.sin(now * 0.8 + companion.id) * 0.045 : 0);
  const breath = idle ? 1 + Math.sin(now * 1.7 + companion.id) * 0.018 : 1;
  const squash = place.active ? 1 - Math.sin(Math.PI * Math.min(1, (now - figure.hop.started) / HOP_SECONDS)) * 0.05 : breath;
  figure.group.scale.set(place.active ? 1.03 : 1, squash, place.active ? 1.03 : 1);
}
