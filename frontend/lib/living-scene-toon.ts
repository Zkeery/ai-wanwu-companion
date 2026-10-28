import * as THREE from 'three';
import { applySoftHomeScene } from './living-home-soft-toon';

/** Shared presentation only. No world coordinates, navigation or saved state. */
export const TOON_SCENE = {
  sky: '#e5f3df', ground: '#b5d58c', sand: '#f3dbab',
  wall: '#f6dfad', roof: '#6fa99a', wood: '#b77e4e',
  stone: '#c8c5a1', foliage: '#6f9f51', fabric: '#efbf9e',
  glass: '#addbdd', metal: '#9db8a5',
  companionScale: 1.35,
} as const;

export function applyToonScene(root: THREE.Object3D, sceneType: string): void {
  const gradient = new THREE.DataTexture(new Uint8Array([110, 110, 110, 255, 180, 180, 180, 255, 230, 230, 230, 255, 255, 255, 255, 255]), 4, 1);
  gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false; gradient.needsUpdate = true;
  const replacements = new Map<string, THREE.MeshToonMaterial>();
  const previous = new Set<THREE.Material>();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object instanceof THREE.InstancedMesh && /outside-(?:tree-leaves|low-shrubs)/.test(object.name)) {
      const previousGeometry = object.geometry;
      object.geometry = new THREE.IcosahedronGeometry(1, 0);
      previousGeometry.dispose();
    }
    // Existing games retain their generated screen and tile faces.
    if (/television-screen|mahjong.*(?:face|tile)/.test(object.name)) return;
    const convert = (old: THREE.Material) => {
      if (old instanceof THREE.MeshToonMaterial) return old;
      const role = String(old.userData.homeMaterialRole ?? object.userData.homeMaterialRole ?? '');
      const name = object.name;
      const color = /roof|ridge|eave/.test(name) ? TOON_SCENE.roof
        : /ground|lawn|grass/.test(name) || role === 'grass' ? (sceneType === 'desert' ? TOON_SCENE.sand : TOON_SCENE.ground)
        : /soil|clearing|path|paving/.test(name) ? '#e9d7af'
        : /water|pond/.test(name) ? '#91d7d5'
        : role === 'foliage' ? (name.endsWith('1') ? '#a2c982' : TOON_SCENE.foliage)
        : role === 'wood' || role === 'wood-floor' ? TOON_SCENE.wood
        : role === 'stone' ? TOON_SCENE.stone
        : role === 'roof' ? TOON_SCENE.roof
        : role === 'fabric' ? TOON_SCENE.fabric
        : role === 'glass' ? TOON_SCENE.glass
        : role === 'metal' ? TOON_SCENE.metal : TOON_SCENE.wall;
      const key = old.uuid + ':' + color;
      let material = replacements.get(key);
      if (!material) {
        material = new THREE.MeshToonMaterial({ color, gradientMap: gradient, side: old.side,
          transparent: old.transparent, opacity: old.opacity, depthWrite: old.depthWrite,
          emissive: color, emissiveIntensity: .03 });
        material.userData = { ...old.userData, sceneStyle: 'toon' };
        material.userData.homeOwnedTextures = [gradient];
        replacements.set(key, material);
      }
      previous.add(old);
      return material;
    };
    object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
  });
  previous.forEach(material => material.dispose());
  if (!replacements.size) gradient.dispose();
  root.userData.homeMaterialMode = 'toon';
  if (sceneType === 'home' && root instanceof THREE.Group) applySoftHomeScene(root);
}

/** Existing shadow draw call, with a soft alpha edge and no downloaded texture. */
export function softCompanionShadow(width: number, opacity = .2, spread = .39): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { shadowOpacity: { value: opacity } },
    vertexShader: 'varying vec2 shadowUv; void main(){shadowUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: 'uniform float shadowOpacity; varying vec2 shadowUv; void main(){float r=length(shadowUv-0.5)*2.0;float a=(1.0-smoothstep(0.1,1.0,r))*shadowOpacity;gl_FragColor=vec4(0.28,0.38,0.24,a);}',
  });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(Math.max(.3, width * spread), 24), material);
  disc.rotation.x = -Math.PI / 2; disc.position.y = .012; disc.name = 'courtyard-shadow';
  return disc;
}
