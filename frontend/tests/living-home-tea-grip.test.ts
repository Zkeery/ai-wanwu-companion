import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAvatar } from '../lib/living-meshes';
import { applyHomeTeaGrip, recommendHomeTeaBodyLean, resetHomeTeaGrip } from '../lib/living-home-tea-grip';

const kinds = ['cup', 'bouquet', 'plant', 'fruit', 'garment', 'creature'] as const;
const roots: THREE.Group[] = [];
function rig(kind: typeof kinds[number], seed = 123) {
  const a = buildAvatar({ version: 1, kind, seed, body: '#d9dfd1', accent: '#a6be9c', detail: '#6a6259', source: 'procedural_existing_features' });
  roots.push(a.root); a.root.scale.multiplyScalar(.9); return a;
}
function attach(a: ReturnType<typeof rig>, pose: ReturnType<typeof applyHomeTeaGrip>) {
  const cup = new THREE.Group(); cup.matrixAutoUpdate = false; cup.matrix.copy(pose.cupLocalMatrix);
  a.rightArm.add(cup); a.root.updateMatrixWorld(true); return cup;
}
afterEach(() => {
  for (const root of roots.splice(0)) root.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose(); } });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('real rig tea grip', () => {
  it.each(kinds)('%s fits the real smile instead of a fixed mouth-height band and reports capped reach honestly', kind => {
    const a = rig(kind), pose = applyHomeTeaGrip(a, 1);
    const mouth = a.body.localToWorld(a.eyes.position.clone().add(new THREE.Vector3(0, -.045, .018)));
    expect(pose.valid).toBe(true); expect(pose.mouthWorld.distanceTo(mouth)).toBeLessThan(1e-10);
    expect(pose.armStretch).toBeLessThanOrEqual(1.5);
    expect(pose.reached).toBe(pose.error <= .005);
    if (pose.requiredStretch <= 1.5 && pose.requiredStretch >= 1) expect(pose.error).toBeLessThan(1e-7);
    else if (pose.requiredStretch > 1.5) expect(pose.error).toBeGreaterThan(0);
  });

  it.each(kinds)('%s uses a bounded real body lean where necessary, recomputes the smile, and reaches with no more than 1.5 stretch', kind => {
    const a = rig(kind), before = a.body.rotation.clone(), lean = recommendHomeTeaBodyLean(a, 1);
    expect(a.body.rotation.toArray()).toEqual(before.toArray());
    expect(Math.abs(lean.bodyLeanX)).toBeLessThanOrEqual(.12); expect(lean.feasible).toBe(true);
    a.body.rotation.x += lean.bodyLeanX;
    const pose = applyHomeTeaGrip(a, 1);
    expect(pose.requiredStretch).toBeLessThanOrEqual(1.5);
    expect(pose.armStretch).toBeLessThanOrEqual(1.5); expect(pose.error).toBeLessThan(1e-7);
    expect(pose.reached).toBe(true);
    if (kind === 'plant') expect(lean.bodyLeanX).toBeLessThan(0); else expect(lean.bodyLeanX).toBe(0);
  });

  it('the actual cup remains gripped by the actual hand, upright and 83mm high under a stretched and rotated parent', () => {
    const a = rig('cup'); a.root.position.set(4, .8, -2); a.root.rotation.y = 1.14; a.body.rotation.z = .025;
    const pose = applyHomeTeaGrip(a, 1), cup = attach(a, pose);
    const hand = a.rightArm.localToWorld(new THREE.Vector3(.075, -.265, .045));
    const grip = new THREE.Vector3(.075, .0415, -.035).applyMatrix4(cup.matrixWorld);
    expect(hand.distanceTo(grip)).toBeLessThan(1e-8);
    const bottom = new THREE.Vector3().applyMatrix4(cup.matrixWorld);
    const top = new THREE.Vector3(0, .083, 0).applyMatrix4(cup.matrixWorld);
    expect(top.distanceTo(bottom)).toBeCloseTo(.083, 10);
    expect(top.clone().sub(bottom).normalize().distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-8);
    const innerRim = new THREE.Vector3(-.045, .083, 0).applyMatrix4(cup.matrixWorld);
    expect(innerRim.distanceTo(pose.rimWorld)).toBeLessThan(1e-8);
    expect(innerRim.distanceTo(pose.mouthWorld)).toBeLessThan(.005);
  });

  it('zero lift and reset restore unit arm scale; paused/repeated frames do not compound IK', () => {
    const a = rig('creature'); const p1 = applyHomeTeaGrip(a, .57), q1 = a.rightArm.quaternion.clone();
    const p2 = applyHomeTeaGrip(a, .57);
    expect(p1.cupLocalMatrix.elements).toEqual(p2.cupLocalMatrix.elements);
    expect(a.rightArm.quaternion.equals(q1)).toBe(true);
    applyHomeTeaGrip(a, 1); expect(a.rightArm.scale.y).toBeGreaterThan(1);
    applyHomeTeaGrip(a, 0); expect(a.rightArm.scale.toArray()).toEqual([1, 1, 1]);
    applyHomeTeaGrip(a, 1); resetHomeTeaGrip(a); expect(a.rightArm.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('a small continuous body sway produces a continuous lean recommendation without step snapping', () => {
    const a = rig('plant'); let last: number | null = null;
    for (let i = 0; i <= 200; i++) {
      a.body.rotation.z = -.03 + i * .0003;
      const lean = recommendHomeTeaBodyLean(a, 1);
      if (last !== null) expect(Math.abs(lean.bodyLeanX - last)).toBeLessThan(.001);
      last = lean.bodyLeanX;
    }
  });

  it('follows moved/scaled/swaying body geometry without changing body, root or shoulders', () => {
    const a = rig('garment'); a.root.scale.multiplyScalar(.8); a.root.rotation.y = -.6; a.root.position.set(-3, 1, 2);
    a.body.rotation.set(.04, -.03, -.02); a.body.scale.set(1, 1.03, 1);
    a.root.updateWorldMatrix(true, true);
    const root = a.root.matrix.clone(), body = a.body.matrix.clone(), shoulder = a.rightArm.position.clone();
    const p = applyHomeTeaGrip(a, 1);
    expect(p.valid).toBe(true); expect(p.error).toBeLessThan(.005);
    expect(a.rightArm.position.equals(shoulder)).toBe(true);
    a.root.updateMatrix(); a.body.updateMatrix();
    expect(a.root.matrix.elements).toEqual(root.elements); expect(a.body.matrix.elements).toEqual(body.elements);
  });

  it('never teleports a cup away from the hand when a distant face is unreachable', () => {
    const a = rig('plant'); a.body.position.z += 2;
    const lean = recommendHomeTeaBodyLean(a, 1); expect(lean.feasible).toBe(false);
    a.body.rotation.x += lean.bodyLeanX;
    const p = applyHomeTeaGrip(a, 1), cup = attach(a, p);
    expect(p.reached).toBe(false); expect(p.error).toBeGreaterThan(1);
    expect(p.armStretch).toBe(1.5);
    expect(new THREE.Vector3(.075, .0415, -.035).applyMatrix4(cup.matrixWorld).distanceTo(p.handWorld)).toBeLessThan(1e-8);
  });

  it('rejects disconnected or singular rigs and clamps invalid lift values without external work', () => {
    const a = rig('cup');
    vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock'); });
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('random'); });
    vi.stubGlobal('fetch', () => { throw new Error('network'); });
    for (const value of [-1, NaN, Infinity]) expect(applyHomeTeaGrip(a, value).armStretch).toBe(1);
    a.root.scale.setScalar(0); expect(applyHomeTeaGrip(a, 1).valid).toBe(false);
    a.root.remove(a.rightArm); expect(applyHomeTeaGrip(a, 1).valid).toBe(false);
  });
});
