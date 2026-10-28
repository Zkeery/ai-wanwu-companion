import * as THREE from 'three';
import { withBasePath } from './base-path';

export type HomeMaterialRole = 'wood-floor' | 'wood' | 'stone' | 'roof' | 'paving' | 'grass' | 'fabric' | 'plaster' | 'glass' | 'metal' | 'foliage';
type AssetId = 'wood_floor' | 'old_stone_wall' | 'clay_roof_tiles_02' | 'rectangular_paving' | 'grass_ground';
type Maps = { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture };
export type HomeTextureStatus = { pending: number; loaded: number; failed: number; unavailable: number };
export type HomeMaterialLibrary = {
  toon?: boolean;
  softToon?: boolean;
  ownerId: string;
  status: HomeTextureStatus;
  material(role: HomeMaterialRole, color: THREE.ColorRepresentation, scope?: string, emissive?: boolean): THREE.MeshStandardMaterial;
  uv(geometry: THREE.BufferGeometry, role: HomeMaterialRole): void;
};

const assets: Partial<Record<HomeMaterialRole, AssetId>> = {
  'wood-floor': 'wood_floor', wood: 'wood_floor', stone: 'old_stone_wall', roof: 'clay_roof_tiles_02', paving: 'rectangular_paving', grass: 'grass_ground',
};
const repeatSize: Record<HomeMaterialRole, number> = {
  'wood-floor': 2, wood: 1.6, stone: 2.4, roof: 2, paving: 2.4, grass: 3, fabric: .18, plaster: .7, glass: 1, metal: 1, foliage: 1,
};

/** One environment owns the library, including textures not yet ready to render. */
export function createHomeMaterials(options: { onTextureLoaded?: () => void; toon?: boolean; softToon?: boolean } = {}): HomeMaterialLibrary {
  const ownerId = THREE.MathUtils.generateUUID();
  const status: HomeTextureStatus = { pending: 0, loaded: 0, failed: 0, unavailable: 0 };
  const textures = new Map<AssetId, Maps | undefined>();
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const procedural = new Map<string, THREE.DataTexture>();
  let loader: THREE.TextureLoader | undefined;

  function maps(id: AssetId): Maps | undefined {
    if (textures.has(id)) return textures.get(id);
    if (typeof document === 'undefined') {
      status.unavailable += 3;
      textures.set(id, undefined);
      return;
    }
    loader ??= new THREE.TextureLoader();
    function load(suffix: 'diff' | 'nor_gl' | 'rough') {
      const url = withBasePath(`/home-realistic/polyhaven/${id}/${id}_${suffix}_1k.jpg`);
      status.pending++;
      let settled = false;
      const request: { texture?: THREE.Texture } = {};
      function settle(ok: boolean, loaded?: THREE.Texture) {
        if (settled) return;
        settled = true;
        status.pending--; status[ok ? 'loaded' : 'failed']++;
        const value = loaded ?? request.texture;
        if (value) value.userData.homeTextureState = ok ? 'loaded' : 'failed';
        if (ok && value && !value.userData.homeTextureDisposed) for (const material of materials.values()) {
          if (!(material.userData.homeOwnedTextures as THREE.Texture[] | undefined)?.includes(value)) continue;
          const slot = suffix === 'diff' ? 'map' : suffix === 'nor_gl' ? 'normalMap' : 'roughnessMap';
          if (suffix === 'diff' && material.userData.homeDiffuseSuppressed) continue;
          material[slot] = value;
          if (suffix === 'diff' && !material.userData.homePreserveDiffuseTint) material.color.set('#ffffff');
          material.needsUpdate = true;
        }
        if (!value?.userData.homeTextureDisposed) options.onTextureLoaded?.();
      }
      const texture = loader!.load(url, value => settle(true, value), undefined, () => settle(false));
      request.texture = texture;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.colorSpace = suffix === 'diff' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      texture.anisotropy = 4;
      texture.userData.homeTextureURL = url;
      texture.userData.homeTextureState ??= settled ? 'failed' : 'loading';
      texture.addEventListener('dispose', () => { texture.userData.homeTextureDisposed = true; });
      return texture;
    }
    const value = { map: load('diff'), normalMap: load('nor_gl'), roughnessMap: load('rough') };
    textures.set(id, value);
    return value;
  }
  function bump(role: 'fabric' | 'plaster') {
    let value = procedural.get(role);
    if (!value) {
      const size = 64, pixels = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const noise = ((x * 17 + y * 31 + x * y * 7) % 19) - 9;
        const height = role === 'fabric' ? 130 + ((x % 4 < 2) !== (y % 4 < 2) ? 18 : -18) + noise : 128 + noise;
        const offset = (y * size + x) * 4;
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = height; pixels[offset + 3] = 255;
      }
      value = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
      value.wrapS = value.wrapT = THREE.RepeatWrapping; value.colorSpace = THREE.NoColorSpace; value.needsUpdate = true;
      value.userData.homeProceduralSurface = role;
      procedural.set(role, value);
    }
    return value;
  }

  return {
    toon: options.toon,
    softToon: options.softToon,
    ownerId,
    status,
    material(role, color, scope = 'shared', emissive = false) {
      const asset = options.toon ? undefined : assets[role];
      const key = `${scope}:${role}:${asset ? 'mapped' : String(color)}:${emissive}`;
      let value = materials.get(key);
      if (value) return value;
      const loaded = asset ? maps(asset) : undefined;
      value = new THREE.MeshStandardMaterial({
        color: loaded?.map.userData.homeTextureState === 'loaded' ? '#ffffff' : color,
        roughness: role === 'glass' ? .12 : role === 'metal' ? .37 : role === 'fabric' ? .96 : role === 'wood' ? .72 : .9,
        metalness: role === 'metal' ? .62 : 0,
        ...(loaded ? { map: loaded.map.userData.homeTextureState === 'loaded' ? loaded.map : null, normalMap: loaded.normalMap.userData.homeTextureState === 'loaded' ? loaded.normalMap : null, roughnessMap: loaded.roughnessMap.userData.homeTextureState === 'loaded' ? loaded.roughnessMap : null, normalScale: new THREE.Vector2(role === 'stone' ? .3 : role === 'roof' ? .38 : .22, role === 'stone' ? .3 : role === 'roof' ? .38 : .22) } : {}),
        ...(role === 'glass' ? { color: '#dce9e6', transparent: true, opacity: .28, depthWrite: false } : {}),
        ...(!options.toon && (role === 'fabric' || role === 'plaster') ? { bumpMap: bump(role), bumpScale: role === 'fabric' ? .004 : .009 } : {}),
        ...(emissive ? { emissive: color, emissiveIntensity: .28 } : {}),
      });
      // Keep pending/failed textures owned without sampling an empty GPU texture.
      if (loaded) value.userData.homeOwnedTextures = Object.values(loaded);
      value.userData.homeMaterialRole = role;
      value.userData.homeMaterialOwnerId = ownerId;
      value.userData.baseOpacity = value.opacity;
      value.userData.baseTransparent = value.transparent;
      value.userData.baseDepthWrite = value.depthWrite;
      materials.set(key, value);
      return value;
    },
    uv(geometry, role) {
      if (options.toon) return;
      const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
      if (!positions || !normals) return;
      const values = new Float32Array(positions.count * 2), size = repeatSize[role];
      for (let i = 0; i < positions.count; i++) {
        const nx = Math.abs(normals.getX(i)), ny = Math.abs(normals.getY(i)), nz = Math.abs(normals.getZ(i));
        const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
        values[i * 2] = (ny >= nx && ny >= nz ? x : nx > nz ? z : x) / size;
        values[i * 2 + 1] = (ny >= nx && ny >= nz ? z : y) / size;
      }
      geometry.setAttribute('uv', new THREE.BufferAttribute(values, 2));
      geometry.userData.homeUVRole = role;
      geometry.userData.homeUVMetresPerRepeat = size;
    },
  };
}
