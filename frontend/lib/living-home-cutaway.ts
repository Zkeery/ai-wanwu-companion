import type { Object3D } from 'three';

const hiddenLayers = new WeakMap<Object3D, number>();

/** Presentation only: keep actors and their collision/navigation state alive on other floors. */
export function setHomeActorCutaway(root: Object3D, hidden: boolean): void {
  root.traverse(object => {
    if (hidden) {
      if (!hiddenLayers.has(object)) hiddenLayers.set(object, object.layers.mask);
      object.layers.mask = 0;
    } else {
      const previous = hiddenLayers.get(object);
      if (previous !== undefined) { object.layers.mask = previous; hiddenLayers.delete(object); }
    }
  });
}

export function homeFloorCovered(floor: unknown, upperView: boolean): boolean {
  return upperView ? floor !== 2 : floor === 2;
}
