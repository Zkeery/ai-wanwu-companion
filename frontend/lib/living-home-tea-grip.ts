import * as THREE from 'three';

export type HomeTeaAvatar = Readonly<{
  root: THREE.Object3D; body: THREE.Object3D; eyes: THREE.Object3D; rightArm: THREE.Object3D;
}>;
export type HomeTeaGrip = Readonly<{
  valid: boolean;
  /** Exact local transform: assign to the cup with matrixAutoUpdate=false. */
  cupLocalMatrix: THREE.Matrix4;
  cupAttachmentLocal: THREE.Vector3;
  cupLocalQuaternion: THREE.Quaternion;
  cupLocalScale: THREE.Vector3;
  mouthWorld: THREE.Vector3;
  handWorld: THREE.Vector3;
  /** The inner rim point nearest the mouth, rather than the rim centre. */
  rimWorld: THREE.Vector3;
  error: number;
  reached: boolean;
  armStretch: number;
  requiredStretch: number;
}>;

const HAND = new THREE.Vector3(.075, -.265, .045);
const REST = new THREE.Quaternion().setFromEuler(new THREE.Euler(-.55, 0, -.22));
const MAX_STRETCH = 1.5;
const UP = new THREE.Vector3(0, 1, 0);
const finiteVector = (v: THREE.Vector3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const validHeight = (height: number) => Number.isFinite(height) && height > 0 ? height : .083;
const validLift = (lift: number) => Number.isFinite(lift) ? Math.max(0, Math.min(1, lift)) : 0;
function requiredStretch(target: THREE.Vector3) {
  return Math.sqrt(Math.max(0, target.lengthSq() - HAND.x * HAND.x - HAND.z * HAND.z)) / Math.abs(HAND.y);
}
function cupAxes(root: THREE.Object3D) {
  const right = new THREE.Vector3(1, 0, 0).transformDirection(root.matrixWorld); right.y = 0;
  if (!finiteVector(right) || right.lengthSq() < 1e-10) return null;
  right.normalize();
  return { right, front: new THREE.Vector3().crossVectors(right, UP).normalize() };
}
function targetHand(mouth: THREE.Vector3, right: THREE.Vector3, front: THREE.Vector3, height: number) {
  return mouth.clone().addScaledVector(right, height * (.120 / .083))
    .addScaledVector(front, -height * (.035 / .083)).addScaledVector(UP, -height * .5);
}

/** Call from the freshly restored base body pose, once per frame, BEFORE
 * applyHomeTeaGrip. Add this delta to that base body's rotation.x; do not
 * accumulate it on the preceding frame's lean. The body itself is not mutated.
 * The returned requiredStretch is the proposed FULL-lift reach, not a charge,
 * external action or promise when feasible=false.
 */
export function recommendHomeTeaBodyLean(avatar: HomeTeaAvatar, lift: number, cupHeight = .083): Readonly<{
  bodyLeanX: number; feasible: boolean; requiredStretch: number;
}> {
  const parent = avatar.rightArm.parent, bodyParent = avatar.body.parent;
  avatar.root.updateWorldMatrix(true, true);
  const axes = cupAxes(avatar.root);
  if (!parent || !bodyParent || avatar.eyes.parent !== avatar.body || !axes || Math.abs(parent.matrixWorld.determinant()) < 1e-10)
    return { bodyLeanX: 0, feasible: false, requiredStretch: Infinity };
  const height = validHeight(cupHeight), inverse = parent.matrixWorld.clone().invert();
  const mouthLocal = avatar.eyes.position.clone().add(new THREE.Vector3(0, -.045, .018));
  const measure = (delta: number) => {
    const euler = avatar.body.rotation.clone(); euler.x += delta;
    const matrix = new THREE.Matrix4().compose(avatar.body.position, new THREE.Quaternion().setFromEuler(euler), avatar.body.scale);
    matrix.premultiply(bodyParent.matrixWorld);
    const mouth = mouthLocal.clone().applyMatrix4(matrix);
    const target = targetHand(mouth, axes.right, axes.front, height).applyMatrix4(inverse).sub(avatar.rightArm.position);
    return finiteVector(target) ? requiredStretch(target) : Infinity;
  };
  let delta = 0, required = measure(0);
  const preferredStretch = MAX_STRETCH - .01;
  if (required > preferredStretch) {
    // Prefer a small margin for normal body sway; cap at seven degrees. A
    // short arm or moved face that still cannot reach remains explicitly false.
    let best = required;
    for (let i = 1; i <= 12; i++) {
      const candidate = -i * .01, value = measure(candidate);
      if (value < best) { best = value; delta = candidate; required = value; }
      if (value <= preferredStretch) {
        // Refine the first feasible interval so body sway cannot make a
        // frame jump between discrete one-degree-ish candidate poses.
        let high = candidate + .01, low = candidate;
        for (let j = 0; j < 18; j++) {
          const mid = (high + low) * .5;
          if (measure(mid) > preferredStretch) high = mid; else low = mid;
        }
        delta = low; required = measure(delta); break;
      }
    }
  }
  return { bodyLeanX: delta * validLift(lift), feasible: required <= MAX_STRETCH, requiredStretch: required };
}

/** The sample clock owns timing. This helper only fits the existing one-segment
 * arm and its actual hand to the current face; it never moves the cup off hand.
 * A reach beyond the preview's 1.5 arm-length cap remains explicitly unfulfilled.
 */
export function applyHomeTeaGrip(avatar: HomeTeaAvatar, lift: number, cupHeight = .083): HomeTeaGrip {
  const t = validLift(lift), height = validHeight(cupHeight);
  const arm = avatar.rightArm, parent = arm.parent;
  const empty = (): HomeTeaGrip => ({ valid: false, cupLocalMatrix: new THREE.Matrix4(),
    cupAttachmentLocal: HAND.clone(), cupLocalQuaternion: new THREE.Quaternion(), cupLocalScale: new THREE.Vector3(1, 1, 1),
    mouthWorld: new THREE.Vector3(), handWorld: new THREE.Vector3(), rimWorld: new THREE.Vector3(),
    error: Infinity, reached: false, armStretch: 1, requiredStretch: Infinity });
  if (!parent || avatar.eyes.parent !== avatar.body) return empty();
  avatar.root.updateWorldMatrix(true, true);
  if (Math.abs(parent.matrixWorld.determinant()) < 1e-10) return empty();

  // The smile is built at eyes + (0,-.045,+.018) in BODY coordinates. Using
  // this transform follows each shape's real face height, sway and scene scale.
  const mouth = avatar.body.localToWorld(avatar.eyes.position.clone().add(new THREE.Vector3(0, -.045, .018)));
  const axes = cupAxes(avatar.root);
  if (!finiteVector(mouth) || !axes) return empty();
  const { right, front } = axes;
  const upright = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, UP, front));

  // The real cup's inner rim radius is .045 at .083 height. Keep its left
  // inner rim at the mouth. The palm sphere sits on the right/rear side:
  // its centre .075 right/.035 back leaves overlap between the real palm
  // radius and cup wall, rather than putting the palm inside the cup axis.
  // These offsets are physical world units; a small avatar still holds the
  // original cup, rather than a root-scaled copy.
  const radius = height * (.045 / .083);
  const palmSide = height * (.075 / .083), palmBack = height * (.035 / .083);
  const target = parent.worldToLocal(targetHand(mouth, right, front, height)).sub(arm.position);
  const distance = target.length();
  if (!finiteVector(target) || distance < 1e-9) return empty();
  const required = requiredStretch(target);
  const peakStretch = Math.max(1, Math.min(MAX_STRETCH, required));
  const peakHand = HAND.clone(); peakHand.y *= peakStretch;
  const peak = new THREE.Quaternion().setFromUnitVectors(peakHand.normalize(), target.clone().normalize());

  // Fixed low pose makes repeated paused frames idempotent. It does not blend
  // from the previous frame's IK result or retain a hidden animation clock.
  arm.quaternion.copy(REST).slerp(peak, t);
  const stretch = 1 + (peakStretch - 1) * t;
  arm.scale.set(1, stretch, 1);
  arm.updateWorldMatrix(true, true);
  const hand = arm.localToWorld(HAND.clone());
  const cupBottom = hand.clone().addScaledVector(right, -palmSide)
    .addScaledVector(front, palmBack).addScaledVector(UP, -height * .5);
  const rim = cupBottom.clone().addScaledVector(UP, height).addScaledVector(right, -radius);
  const cupWorld = new THREE.Matrix4().compose(cupBottom, upright, new THREE.Vector3(1, 1, 1));
  // Non-uniform arm stretching would shear a counter-rotated child if only
  // Euler angles were returned. The exact inverse-parent matrix cancels it.
  const local = arm.matrixWorld.clone().invert().multiply(cupWorld);
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
  local.decompose(position, quaternion, scale);
  const error = rim.distanceTo(mouth);
  return { valid: true, cupLocalMatrix: local, cupAttachmentLocal: position,
    cupLocalQuaternion: quaternion, cupLocalScale: scale,
    mouthWorld: mouth, handWorld: hand, rimWorld: rim,
    error, reached: t >= 1 - 1e-9 && error <= .005, armStretch: stretch, requiredStretch: required };
}

/** Restore before another activity, releasing a cup, or disposing the rig. */
export function resetHomeTeaGrip(avatar: Pick<HomeTeaAvatar, 'rightArm'>): void {
  avatar.rightArm.scale.set(1, 1, 1);
}
