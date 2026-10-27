import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { LivingAvatarMesh } from '@/lib/living-meshes';
import { updateCourtyardFigure } from '@/lib/courtyard-figure';

function avatar() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  const leftArm = new THREE.Group();
  const rightArm = new THREE.Group();
  const leftLeg = new THREE.Group();
  const rightLeg = new THREE.Group();
  root.add(body, leftArm, rightArm, leftLeg, rightLeg);
  body.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.7, 0.25), new THREE.MeshBasicMaterial({ color: '#efa3b8' })));
  return { root, body, leftArm, rightArm, leftLeg, rightLeg, leftKnee: new THREE.Group(), rightKnee: new THREE.Group(), eyes: new THREE.Group(), seatHeight: 0.4, bedSupportZ: -0.3, bedBodySupportZ: -0.3, sleepSupport: null, headHeight: 1.3 } as LivingAvatarMesh;
}

const camera = new THREE.PerspectiveCamera();
const companion = { id: 14, portrait: '/uploads/juanjuan.png', courtyard_figure: 'ready' as const };

describe('one companion figure for every home state', () => {
  it('hides the pink placeholder in the bedroom and keeps the same figure lying down', () => {
    const figure = avatar();
    figure.root.rotation.x = -Math.PI / 2;
    figure.root.userData.homeRegion = 'bedroom';
    updateCourtyardFigure(figure, companion, camera, 1, false, 'home');
    expect(figure.body.visible).toBe(false);
    expect(figure.leftArm.visible).toBe(false);
    const shown = figure.root.getObjectByName('courtyard-figure')!;
    expect(shown.visible).toBe(true);
    expect(shown.getObjectByName('courtyard-zzz')).toBeTruthy();
    expect(shown.rotation.x).toBe(0);
    expect(shown.rotation.y).toBe(Math.PI);
  });

  it('keeps a portrait card face up when it sleeps', () => {
    const figure = avatar();
    figure.root.rotation.x = -Math.PI / 2;
    updateCourtyardFigure(figure, { id: 14, portrait: '/uploads/juanjuan.png' }, camera, 1, false, 'home');
    expect(figure.root.getObjectByName('courtyard-figure')!.rotation.y).toBe(0);
  });

  it('uses that same figure while standing in the courtyard', () => {
    const figure = avatar();
    figure.root.userData.homeRegion = 'outdoor';
    updateCourtyardFigure(figure, companion, camera, 1, true, 'home');
    expect(figure.body.visible).toBe(false);
    expect(figure.root.getObjectByName('courtyard-figure')!.visible).toBe(true);
    expect(figure.root.getObjectByName('courtyard-zzz')?.visible ?? false).toBe(false);
  });

  it('leaves scenes without a portrait or mesh on their original body', () => {
    const figure = avatar();
    updateCourtyardFigure(figure, { id: 14 }, camera, 1, false, 'home');
    expect(figure.body.visible).toBe(true);
  });
});
