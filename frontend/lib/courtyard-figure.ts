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
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
  );
  board.position.y = height / 2;
  board.name = 'courtyard-standee';
  group.add(board);
  shadow(group, width);
}

function showMesh(group: THREE.Group, root: THREE.Object3D) {
  clear(group);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  root.position.sub(center);
  const height = Math.max(size.y, 0.001);
  root.scale.setScalar(1.7 / height);
  root.position.y += 0.85;
  root.name = 'courtyard-mesh';
  group.add(root);
  shadow(group, size.x * (1.7 / height));
}

export function updateCourtyardFigure(
  avatar: LivingAvatarMesh, companion: CourtyardCompanion, camera: THREE.Camera,
  now: number, motion: boolean, sceneType: string,
) {
  const figure = stateOf(avatar.root);
  const area = String(avatar.root.userData.homePresenceArea ?? avatar.root.userData.homeRegion ?? 'outdoor');
  const portrait = companion.portrait && companion.portrait.startsWith('/uploads/') ? companion.portrait : '';
  const ready = companion.courtyard_figure === 'ready';
  const courtyard = sceneType === 'home' && area === 'outdoor' && (!!portrait || ready);
  for (const part of parts(avatar)) part.visible = !courtyard;
  figure.group.visible = courtyard;
  if (!courtyard) return;
  const key = ready ? `mesh:${companion.id}` : `standee:${portrait}`;
  if (figure.key !== key) {
    figure.key = key; figure.mode = ready ? 'mesh' : 'standee';
    const token = ++figure.token;
    const tokenValue = getToken();
    if (ready && tokenValue) {
      void fetch(`/api/v1/characters/${companion.id}/courtyard-mesh`, { headers: authHeaders(tokenValue), cache: 'no-store' })
        .then(response => { if (!response.ok) throw new Error('mesh'); return response.arrayBuffer(); })
        .then(buffer => {
          if (token !== figure.token) return;
          const loader = new GLTFLoader();
          loader.parse(buffer, '', gltf => {
            if (token !== figure.token) return;
            showMesh(figure.group, gltf.scene);
          }, () => undefined);
        }).catch(() => undefined);
    } else if (portrait && tokenValue) {
      const controller = new AbortController();
      void privateImageBlob(portrait, tokenValue, controller.signal).then(async blob => {
        if (token !== figure.token) return;
        const source = await softenBackground(blob);
        if (token !== figure.token) return;
        const texture = new THREE.Texture(source);
        texture.needsUpdate = true;
        showStandee(figure.group, texture);
      }).catch(() => undefined);
    }
  }
  const place = courtyardHop(figure.hop, now, avatar.root.position.x, avatar.root.position.z);
  avatar.root.updateMatrixWorld(true);
  const landed = avatar.root.worldToLocal(new THREE.Vector3(place.x, avatar.root.position.y + place.y, place.z));
  figure.group.position.copy(landed);
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
