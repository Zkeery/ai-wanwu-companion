import * as THREE from 'three';
import type { Avatar3D } from './shared-living-3d';
import { prepareLivingSleepSupport, type LivingSleepSupport } from './living-sleep-support';

export type LivingAvatarMesh = {
  root: THREE.Group;
  body: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  leftKnee: THREE.Group;
  rightKnee: THREE.Group;
  seatHeight: number;
  bedSupportZ: number;
  bedBodySupportZ: number;
  sleepSupport: LivingSleepSupport | null;
  headHeight: number;
  eyes: THREE.Group;
};

const BODY_Y = 0.75;

/**
 * Original, procedural, volumetric character modelling. No image planes,
 * textures, downloaded assets, model services or internal animation loop.
 * Front is +Z; the floor is Y=0. Caller owns animation and traversal/disposal
 * of geometries/materials (several meshes intentionally share resources).
 */
export function buildAvatar(spec: Avatar3D): LivingAvatarMesh {
  const root = new THREE.Group();
  const body = new THREE.Group();
  const leftArm = new THREE.Group();
  const rightArm = new THREE.Group();
  const leftLeg = new THREE.Group();
  const rightLeg = new THREE.Group();
  const leftKnee = new THREE.Group();
  const rightKnee = new THREE.Group();
  const eyes = new THREE.Group();
  const result: LivingAvatarMesh = { root, body, leftArm, rightArm, leftLeg, rightLeg, leftKnee, rightKnee, eyes, seatHeight: 0.4, bedSupportZ: -.3, bedBodySupportZ: -.3, sleepSupport: null, headHeight: 1.3 };
  root.name = `living-avatar-${spec.kind}`;
  root.userData.modelling = 'original-procedural-volumetric';
  for (const [hip, knee, side] of [[leftLeg, leftKnee, -1], [rightLeg, rightKnee, 1]] as const) {
    hip.name = side < 0 ? 'left-leg' : 'right-leg';
    hip.position.set(side * 0.14, 0.30, 0);
    knee.name = side < 0 ? 'left-knee' : 'right-knee';
    knee.position.set(0, -0.13, 0);
    hip.add(knee);
  }

  // An unsupported appearance stays absent; never invent a replacement pet.
  if (spec.kind === 'unavailable') return result;

  body.name = 'body';
  body.position.y = BODY_Y;
  root.add(body, leftArm, rightArm, leftLeg, rightLeg);
  const seed = spec.seed >>> 0;
  const variation = ((seed % 101) / 100 - 0.5) * 0.08;
  const material = (color: THREE.ColorRepresentation, roughness = 0.78) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
  const main = material(spec.body);
  const accent = material(spec.accent);
  const detail = material(spec.detail);
  const cream = material('#fff9e8');
  const dark = material('#302a39', 0.65);
  const leaf = material('#5d9a60');
  const paleLeaf = material('#a6c778');
  const blush = material('#e99b9e');

  // Reuse low-poly smooth volumes within this avatar. The caller should dedupe
  // resource identities when disposing; geometry is never shared across calls.
  const sphere = new THREE.SphereGeometry(1, 14, 10);
  const smallSphere = new THREE.SphereGeometry(1, 10, 7);
  const add = (
    parent: THREE.Object3D, geometry: THREE.BufferGeometry,
    mat: THREE.Material, x: number, y: number, z: number,
    sx = 1, sy = 1, sz = 1,
  ) => {
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const solid = (
    geometry: THREE.BufferGeometry, mat: THREE.Material,
    x: number, y: number, z: number, sx = 1, sy = 1, sz = 1,
  ) => add(body, geometry, mat, x, y - BODY_Y, z, sx, sy, sz);
  const orb = (
    mat: THREE.Material, x: number, y: number, z: number,
    sx: number, sy = sx, sz = sx,
  ) => solid(sphere, mat, x, y, z, sx, sy, sz);
  const ring = (radius: number, tube: number, mat: THREE.Material, y: number) => {
    const mesh = solid(new THREE.TorusGeometry(radius, tube, 6, 20), mat, 0, y, 0);
    mesh.rotation.x = Math.PI / 2;
    return mesh;
  };
  const loadBearing = (mesh: THREE.Mesh) => { mesh.userData.sleepBodySupport = true; return mesh; };
  const makeLeaf = (x: number, y: number, z: number, angle: number, size = 1) => {
    const mesh = orb(leaf, x, y, z, 0.075 * size, 0.20 * size, 0.045 * size);
    mesh.rotation.z = angle;
    mesh.rotation.y = x < 0 ? -0.35 : 0.35;
    return mesh;
  };

  // Independent shoulder and hip pivots permit natural walking/waving without
  // deforming the object identity. Neutral toes are above, never below, Y=0.
  const garment = spec.kind === 'garment';
  const armMat = garment ? cream : accent;
  for (const [arm, side] of [[leftArm, -1], [rightArm, 1]] as const) {
    arm.name = side < 0 ? 'left-arm' : 'right-arm';
    arm.position.set(side * (garment ? 0.36 : 0.34), 0.79, 0.015);
    const upper = add(arm, new THREE.CapsuleGeometry(0.055, 0.19, 3, 8), armMat,
      side * 0.045, -0.13, 0.025);
    upper.rotation.z = side * 0.24;
    add(arm, smallSphere, garment ? cream : main,
      side * 0.075, -0.265, 0.045, 0.072, 0.065, 0.065);
    if (garment) {
      const sleeve = add(arm, new THREE.CapsuleGeometry(0.09, 0.10, 3, 8), main,
        side * 0.015, -0.055, 0);
      sleeve.rotation.z = side * 0.35;
      add(arm, smallSphere, accent, side * 0.045, -0.145, 0.017, 0.084, 0.025, 0.08);
    }
  }
  for (const [leg, knee] of [[leftLeg, leftKnee], [rightLeg, rightKnee]] as const) {
    // A real knee lets the hip bend forward while the shin hangs down. In the
    // neutral pose the same toes still meet Y=0, retaining the walking pivot.
    add(leg, new THREE.CapsuleGeometry(0.06, 0.015, 3, 8), accent, 0, -0.0675, 0);
    add(knee, new THREE.CapsuleGeometry(0.055, 0.025, 3, 8), accent, 0, -0.04, 0);
    add(knee, sphere, detail, 0, -0.095, 0.055, 0.105, 0.075, 0.14);
  }

  let faceY = 0.83;
  let faceZ = 0.30;
  let faceWidth = 1;

  switch (spec.kind) {
    case 'cup': {
      // Taper, visible rim/lid and a true curved handle distinguish a cup from
      // a generic round figure even when viewed from the rear or the side.
      loadBearing(solid(new THREE.CylinderGeometry(0.29, 0.22, 0.70, 20), main, 0, 0.79, 0));
      ring(0.289, 0.025, accent, 1.15);
      solid(new THREE.CylinderGeometry(0.305, 0.30, 0.045, 20), cream, 0, 1.19, 0);
      solid(new THREE.CylinderGeometry(0.26, 0.285, 0.055, 20), cream, 0, 1.235, 0);
      const sip = orb(detail, 0.10, 1.268, 0.08, 0.045, 0.008, 0.025);
      sip.castShadow = false;
      const handle = solid(new THREE.TorusGeometry(0.16, 0.042, 6, 14, Math.PI * 1.4),
        accent, 0.30, 0.85, 0);
      handle.rotation.z = -Math.PI * 0.7;
      // Raised decorative leaves are volumes, not an image wrapped on the cup.
      const cupLeaf = orb(accent, -0.17, 0.60, 0.185, 0.055, 0.10, 0.025);
      cupLeaf.rotation.z = -0.5;
      faceZ = 0.276;
      break;
    }
    case 'bouquet': {
      loadBearing(solid(new THREE.CylinderGeometry(0.33, 0.13, 0.62, 14), main, 0, 0.69, 0));
      const wrap = solid(new THREE.ConeGeometry(0.35, 0.48, 4), cream, 0, 0.78, -0.025);
      wrap.rotation.z = Math.PI;
      wrap.rotation.y = Math.PI / 4;
      orb(accent, 0, 0.51, 0.17, 0.075, 0.045, 0.045);
      for (const side of [-1, 1]) {
        const bow = orb(accent, side * 0.09, 0.52, 0.16, 0.09, 0.045, 0.035);
        bow.rotation.z = side * -0.3;
      }
      const flowers = [
        [-0.21, 1.13, 0.03], [0.20, 1.15, 0.02],
        [0, 1.31, -0.015], [-0.06, 1.06, 0.19], [0.13, 1.03, -0.17],
      ];
      flowers.forEach(([x, y, z], index) => {
        const petals = index % 2 ? accent : detail;
        for (let i = 0; i < 5; i += 1) {
          const angle = (i / 5) * Math.PI * 2 + variation;
          const petal = solid(smallSphere, petals, x + Math.cos(angle) * 0.085,
            y + Math.sin(angle) * 0.085, z, 0.087, 0.072, 0.065);
          petal.rotation.z = angle;
        }
        solid(smallSphere, cream, x, y, z + 0.05, 0.055, 0.055, 0.045);
      });
      makeLeaf(-0.30, 1.02, -0.03, -0.8, 0.8);
      makeLeaf(0.31, 1.02, -0.04, 0.8, 0.8);
      makeLeaf(-0.09, 1.17, -0.14, -0.35, 0.7);
      faceY = 0.76;
      faceZ = 0.29;
      faceWidth = 0.85;
      break;
    }
    case 'plant': {
      loadBearing(solid(new THREE.CylinderGeometry(0.30, 0.225, 0.46, 16), main, 0, 0.60, 0));
      ring(0.294, 0.025, accent, 0.83);
      solid(new THREE.CylinderGeometry(0.265, 0.265, 0.025, 16), detail, 0, 0.827, 0);
      solid(new THREE.CylinderGeometry(0.035, 0.045, 0.43, 8), leaf, 0, 1.01, 0);
      for (let i = 0; i < 7; i += 1) {
        const angle = (i / 7) * Math.PI * 2 + variation;
        const x = Math.cos(angle) * 0.16;
        const z = Math.sin(angle) * 0.13;
        const blade = orb(i % 2 ? leaf : paleLeaf, x, 1.12 + (i % 3) * 0.045, z,
          0.095, 0.25, 0.055);
        blade.rotation.z = -Math.cos(angle) * 0.55;
        blade.rotation.x = Math.sin(angle) * 0.50;
      }
      faceY = 0.63;
      faceZ = 0.29;
      faceWidth = 0.85;
      break;
    }
    case 'fruit': {
      loadBearing(orb(main, 0, 0.82, 0, 0.39, 0.43, 0.34));
      const fruitLobe = loadBearing(orb(main, 0.17, 0.94, -0.015, 0.23, 0.26, 0.29));
      fruitLobe.rotation.z = -0.18;
      solid(new THREE.CylinderGeometry(0.025, 0.035, 0.14, 7), detail, 0, 1.29, 0);
      const topLeaf = orb(leaf, 0.12, 1.36, 0, 0.16, 0.065, 0.06);
      topLeaf.rotation.z = 0.3;
      orb(accent, -0.20, 1.03, 0.255, 0.04, 0.08, 0.015).rotation.z = -0.45;
      faceY = 0.86;
      faceZ = 0.334;
      faceWidth = 1.05;
      break;
    }
    case 'garment': {
      // Extrusion gives the shirt front, back and side faces actual thickness.
      const outline = new THREE.Shape();
      outline.moveTo(-0.27, -0.31);
      outline.lineTo(0.27, -0.31);
      outline.lineTo(0.29, 0.20);
      outline.lineTo(0.16, 0.33);
      outline.lineTo(-0.16, 0.33);
      outline.lineTo(-0.29, 0.20);
      outline.closePath();
      const torso = loadBearing(solid(new THREE.ExtrudeGeometry(outline, {
        depth: 0.29, steps: 1, bevelEnabled: true,
        bevelThickness: 0.035, bevelSize: 0.035, bevelSegments: 2,
        curveSegments: 1,
      }), main, 0, 0.83, -0.145));
      torso.name = 'volumetric-shirt';
      for (const side of [-1, 1]) {
        const collar = new THREE.Shape();
        collar.moveTo(0, 0);
        collar.lineTo(side * 0.15, -0.015);
        collar.lineTo(side * 0.08, -0.16);
        collar.closePath();
        solid(new THREE.ExtrudeGeometry(collar, {
          depth: 0.035, bevelEnabled: true,
          bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 1,
        }), cream, side * 0.015, 1.16, 0.17);
      }
      for (const y of [0.73, 0.60, 0.47]) {
        orb(detail, 0, y, 0.19, 0.018, 0.018, 0.012);
      }
      // A pocket is a rounded solid block on the shirt, with an accent seam.
      solid(new THREE.BoxGeometry(0.105, 0.095, 0.018), accent, 0.16, 0.76, 0.19);
      solid(new THREE.BoxGeometry(0.105, 0.012, 0.025), detail, 0.16, 0.805, 0.20);
      faceY = 0.95;
      faceZ = 0.19;
      faceWidth = 0.85;
      break;
    }
    case 'creature': {
      loadBearing(orb(main, 0, 0.82, 0, 0.35, 0.43, 0.29));
      orb(accent, 0, 0.67, 0.245, 0.205, 0.24, 0.055);
      for (const side of [-1, 1]) {
        const ear = orb(main, side * 0.23, 1.21, -0.015, 0.10, 0.22, 0.09);
        ear.rotation.z = side * -0.20;
        const inside = orb(accent, side * 0.23, 1.23, 0.055, 0.052, 0.14, 0.025);
        inside.rotation.z = side * -0.20;
      }
      const tail = orb(detail, 0.29, 0.61, -0.20, 0.11, 0.11, 0.20);
      tail.rotation.y = 0.4;
      faceY = 0.97;
      faceZ = 0.276;
      break;
    }
  }

  eyes.name = 'eyes';
  eyes.position.set(0, faceY - BODY_Y, faceZ);
  eyes.scale.x = faceWidth;
  body.add(eyes);
  for (const side of [-1, 1]) {
    add(eyes, smallSphere, dark, side * 0.095, 0.015, 0.012, 0.036, 0.049, 0.023);
    const glint = add(eyes, smallSphere, cream, side * 0.095 - 0.009, 0.032, 0.034,
      0.010, 0.013, 0.006);
    glint.castShadow = false;
    orb(blush, side * 0.16 * faceWidth, faceY - 0.035, faceZ + 0.001,
      0.038, 0.019, 0.012).castShadow = false;
  }
  const smile = solid(new THREE.TorusGeometry(0.052, 0.009, 5, 10, Math.PI),
    dark, 0, faceY - 0.045, faceZ + 0.018);
  smile.rotation.z = Math.PI;
  smile.castShadow = false;
  // The support point belongs to the body, not its dangling legs. Compute it
  // before applying the shared avatar scale so callers can align any kind to
  // the same sofa seat without guessing from the character's total height.
  const bodyBounds = new THREE.Box3().setFromObject(body);
  if (Number.isFinite(bodyBounds.min.y)) result.seatHeight = Math.max(0, bodyBounds.min.y);
  if (Number.isFinite(bodyBounds.min.z)) result.bedSupportZ = bodyBounds.min.z;
  if (Number.isFinite(bodyBounds.max.y)) result.headHeight = bodyBounds.max.y;
  result.sleepSupport = prepareLivingSleepSupport(root, body);
  if (result.sleepSupport) result.bedBodySupportZ = result.sleepSupport.bodySupportZ;
  // Keep different object proportions while giving everyone a common scene
  // scale. Animate children rather than replacing this initial root scale.
  const bounds = new THREE.Box3().setFromObject(root);
  const height = bounds.max.y - bounds.min.y;
  if (Number.isFinite(height) && height > 0) root.scale.setScalar(1.45 / height);
  return result;
}
