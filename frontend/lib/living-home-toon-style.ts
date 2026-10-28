import * as THREE from 'three';

/** The desktop home and its existing companion use the same warm four-band light response. */
export function createHomeToonRamp(): THREE.DataTexture {
  const ramp = new THREE.DataTexture(new Uint8Array([140,140,140,255,185,185,185,255,225,225,225,255,255,255,255,255]), 4, 1);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.generateMipmaps = false; ramp.needsUpdate = true;
  return ramp;
}
