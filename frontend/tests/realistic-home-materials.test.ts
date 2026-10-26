import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createHomeMaterials, type HomeMaterialRole } from '@/lib/living-home-materials';
import { applyHomeWorldArchitectureView, buildHomeWorldEnvironment } from '@/lib/living-home-world-meshes';
import { disposeLivingObject } from '@/lib/living-world-engine';
import preservedLayout from './fixtures/farmhouse-r4-layout.json';

const loaderState = vi.hoisted(() => ({ constructed: 0 }));
vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  class ObservedTextureLoader extends actual.TextureLoader {
    constructor(...args: ConstructorParameters<typeof actual.TextureLoader>) { super(...args); loaderState.constructed++; }
  }
  return { ...actual, TextureLoader: ObservedTextureLoader };
});

type Load = {
  url: string;
  texture: THREE.Texture;
  success: () => void;
  failure: () => void;
};
const loads: Load[] = [];
const roots = new Set<THREE.Group>();

function texturesOf(root: THREE.Object3D) {
  const textures = new Set<THREE.Texture>();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const value of [...Object.values(material), ...(material.userData.homeOwnedTextures ?? [])]) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  return textures;
}

function world(realistic = true, onTextureLoaded?: () => void) {
  const result = buildHomeWorldEnvironment('summer', { resting: 10, sleeping: 10 }, { realistic, onTextureLoaded });
  roots.add(result); result.updateWorldMatrix(true, true); return result;
}

function materialOf(mesh: THREE.Mesh): THREE.MeshStandardMaterial {
  expect(Array.isArray(mesh.material)).toBe(false);
  return mesh.material as THREE.MeshStandardMaterial;
}

beforeEach(() => {
  loads.length = 0;
  loaderState.constructed = 0;
  // Only the image-loading boundary is replaced; real textures, materials,
  // geometries, UV attributes and spatial bounds stay intact.
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(function (_url, onLoad, _progress, onError) {
    const texture = new THREE.Texture<HTMLImageElement>();
    loads.push({ url: String(_url), texture, success: () => onLoad?.(texture), failure: () => onError?.(new Error('synthetic local image failure')) });
    return texture;
  });
});

afterEach(() => {
  roots.forEach(disposeLivingObject); roots.clear();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('optional local realistic home surfaces', () => {
  it('updates villa tint variants after slow loads while retaining the blue roof and releasing real textures once', () => {
    const root=buildHomeWorldEnvironment('summer',{resting:1,sleeping:1},{realistic:true,referenceVilla:true});roots.add(root);
    const grass=materialOf(root.getObjectByName('home-realistic-grass-ground') as THREE.Mesh), tint=grass.color.getHex();
    expect(grass.map).toBeNull();expect(grass.userData.homeOwnedTextures.every((texture: unknown)=>texture instanceof THREE.Texture)).toBe(true);
    const roof: THREE.MeshStandardMaterial[]=[];root.traverse(object=>{if(object instanceof THREE.Mesh){const material=materialOf(object);if(material.userData.referenceVillaOwned&&material.userData.homeMaterialRole==='roof')roof.push(material);}});
    expect(roof.length).toBeGreaterThan(0);loads.forEach(load=>load.success());
    expect(grass.map).toBe(loads.find(load=>load.url.includes('/grass_ground/')&&load.url.includes('_diff_'))!.texture);expect(grass.color.getHex()).toBe(tint);
    for(const material of roof){expect(material.map).toBeNull();expect(material.normalMap).not.toBeNull();expect(material.userData.homeDiffuseSuppressed).toBe(true);}
    const spies=loads.map(load=>vi.spyOn(load.texture,'dispose'));disposeLivingObject(root);roots.delete(root);spies.forEach(spy=>expect(spy).toHaveBeenCalledTimes(1));
  });

  it('renders original colours while slow images are pending, then recompiles only ready maps', () => {
    const library = createHomeMaterials(), material = library.material('grass', '#688346');
    const version = material.version;
    expect(material.color.getHexString()).toBe('688346');
    expect(material.map).toBeNull(); expect(material.normalMap).toBeNull(); expect(material.roughnessMap).toBeNull();
    loads[1].success();
    expect(material.normalMap).toBe(loads[1].texture); expect(material.map).toBeNull();
    expect(material.color.getHexString()).toBe('688346'); expect(material.version).toBeGreaterThan(version);
    loads[0].failure(); loads[2].success();
    expect(material.map).toBeNull(); expect(material.color.getHexString()).toBe('688346');
    expect(material.roughnessMap).toBe(loads[2].texture);
    expect(library.status).toEqual({pending:0,loaded:2,failed:1,unavailable:0});
    const second = library.material('grass', '#688346', 'second');
    expect(second.map).toBeNull(); expect(second.normalMap).toBe(loads[1].texture);
    const temporary=new THREE.Group();temporary.add(new THREE.Mesh(new THREE.BoxGeometry(),material),new THREE.Mesh(new THREE.BoxGeometry(),second));roots.add(temporary);
  });

  it('binds a successful diffuse image after a failed normal map without losing its original ownership', () => {
    const library=createHomeMaterials(), material=library.material('paving','#baaa87');
    loads[1].failure(); loads[0].success();
    expect(material.color.getHex()).toBe(0xffffff);expect(material.map).toBe(loads[0].texture);expect(material.normalMap).toBeNull();
    const temporary=new THREE.Group();temporary.add(new THREE.Mesh(new THREE.BoxGeometry(),material));roots.add(temporary);
    const spies=loads.map(load=>vi.spyOn(load.texture,'dispose'));disposeLivingObject(temporary);roots.delete(temporary);
    spies.forEach(spy=>expect(spy).toHaveBeenCalledTimes(1));
    const version=material.version;loads[2].success();expect(material.roughnessMap).toBeNull();expect(material.version).toBe(version);
  });

  it('keeps the default and explicit classic world free of all image and procedural textures', () => {
    const implicit = buildHomeWorldEnvironment('summer', { resting: 10, sleeping: 10 }); roots.add(implicit);
    const explicit = world(false);
    expect(loads).toHaveLength(0);
    expect(loaderState.constructed).toBe(0);
    expect(texturesOf(implicit).size).toBe(0);
    expect(texturesOf(explicit).size).toBe(0);
    const signature = (root: THREE.Object3D) => {
      const values: unknown[] = [];
      root.traverse(object => { if (object instanceof THREE.Mesh) values.push([object.name, object.geometry.getAttribute('position').count, object.position.toArray(), object.scale.toArray()]); });
      return values;
    };
    expect(signature(explicit)).toEqual(signature(implicit));
    expect(explicit.userData.homeMaterialMode).toBe('classic');
  });

  it('loads only the fifteen same-origin maps once per environment and exposes every allocation through a real material', () => {
    const root = world(), textures = texturesOf(root);
    expect(loads).toHaveLength(15);
    expect(loaderState.constructed).toBe(1);
    expect(new Set(loads.map(load => load.url)).size).toBe(15);
    for (const load of loads) {
      expect(load.url).toMatch(/^\/home-realistic\/polyhaven\/(wood_floor|old_stone_wall|clay_roof_tiles_02|rectangular_paving|grass_ground)\/\1_(diff|nor_gl|rough)_1k\.jpg$/);
      expect(textures.has(load.texture)).toBe(true);
      expect(load.texture.wrapS).toBe(THREE.RepeatWrapping);
      expect(load.texture.wrapT).toBe(THREE.RepeatWrapping);
      expect(load.texture.colorSpace).toBe(load.url.includes('_diff_') ? THREE.SRGBColorSpace : THREE.NoColorSpace);
    }
    const procedural = [...textures].filter(texture => texture instanceof THREE.DataTexture);
    expect(procedural).toHaveLength(2);
    expect(procedural.map(texture => texture.userData.homeProceduralSurface).sort()).toEqual(['fabric', 'plaster']);
    for (const texture of procedural) {
      expect(texture.image).toMatchObject({ width: 64, height: 64 });
      expect(texture.colorSpace).toBe(THREE.NoColorSpace);
    }
    expect(textures.size).toBe(17);
    expect(root.userData.homeTextureStatus).toEqual({ pending: 15, loaded: 0, failed: 0, unavailable: 0 });
  });

  it('reports actual image success and failure exactly once without counting procedural bumps as downloaded', () => {
    const notify = vi.fn(), root = world(true, notify), status = root.userData.homeTextureStatus;
    loads.slice(0, 14).forEach(load => load.success()); loads[14].failure();
    expect(root.userData.homeTextureStatus).toBe(status);
    expect(status).toEqual({ pending: 0, loaded: 14, failed: 1, unavailable: 0 });
    expect(notify).toHaveBeenCalledTimes(15);
    loads[0].success(); loads[14].failure(); loads[14].success();
    expect(status).toEqual({ pending: 0, loaded: 14, failed: 1, unavailable: 0 });
    expect(notify).toHaveBeenCalledTimes(15);
    expect(loads[0].texture.userData.homeTextureState).toBe('loaded');
    expect(loads[14].texture.userData.homeTextureState).toBe('failed');
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const material = materialOf(object);
      if (material.map?.userData.homeTextureState === 'loaded') expect(material.color.getHex()).toBe(0xffffff);
    });
  });

  it('uses deterministic non-DOM fallback without instantiating an image loader or claiming image success', () => {
    vi.stubGlobal('document', undefined);
    const root = world(), status = root.userData.homeTextureStatus;
    expect(loads).toHaveLength(0);
    expect(loaderState.constructed).toBe(0);
    expect(status).toEqual({ pending: 0, loaded: 0, failed: 0, unavailable: 15 });
    expect([...texturesOf(root)]).toHaveLength(2);
    expect([...texturesOf(root)].every(texture => texture instanceof THREE.DataTexture)).toBe(true);
  });

  it('shares maps within one environment while preserving wall-scope materials and independent environment ownership', () => {
    const first = world(), firstTextures = texturesOf(first), second = world(), secondTextures = texturesOf(second);
    expect(loads).toHaveLength(30);
    expect([...firstTextures].every(texture => !secondTextures.has(texture))).toBe(true);
    const library = createHomeMaterials(), a = library.material('stone', '#998877', 'wall-a'), b = library.material('stone', '#998877', 'wall-b');
    expect(a).not.toBe(b); expect(a.userData.homeOwnedTextures).toEqual(b.userData.homeOwnedTextures);
    loads.slice(-3).forEach(load => load.success());
    expect(a.map).not.toBeNull(); expect(a.map).toBe(b.map); expect(a.normalMap).toBe(b.normalMap); expect(a.roughnessMap).toBe(b.roughnessMap);
    const temporary = new THREE.Group(); temporary.add(new THREE.Mesh(new THREE.BoxGeometry(), a), new THREE.Mesh(new THREE.BoxGeometry(), b)); roots.add(temporary);
    const opposite = first.getObjectByName('home-exterior-back-upper-wall')!;
    const before = new Map<THREE.Material, number>(); opposite.traverse(object => { if (object instanceof THREE.Mesh) before.set(materialOf(object), materialOf(object).opacity); });
    const originalState = new Map<THREE.Material, { opacity: number; transparent: boolean; depthWrite: boolean }>();
    first.traverse(object => { if (object instanceof THREE.Mesh) { const material = materialOf(object); originalState.set(material, { opacity: material.userData.baseOpacity ?? material.opacity, transparent: material.userData.baseTransparent ?? material.transparent, depthWrite: material.userData.baseDepthWrite ?? material.depthWrite }); } });
    applyHomeWorldArchitectureView(first, 'interior', { x: 17, y: 18, z: 23 });
    expect([...before].every(([material, opacity]) => (material as THREE.MeshStandardMaterial).opacity === opacity)).toBe(true);
    applyHomeWorldArchitectureView(first, 'exterior', { x: 17, y: 18, z: 23 });
    first.traverse(object => { if (object instanceof THREE.Mesh) {
      const material = materialOf(object);
      expect(material.opacity).toBe(originalState.get(material)!.opacity);
      expect(material.transparent).toBe(originalState.get(material)!.transparent);
      expect(material.depthWrite).toBe(originalState.get(material)!.depthWrite);
    } });
  });

  it('uses metre-scale UVs on continuous level floors while preserving the original seat and bed contact geometry', () => {
    const classic = world(false), realistic = world();
    const floors: THREE.Mesh[] = [];
    realistic.traverse(object => { if (object instanceof THREE.Mesh && /^home-realistic-(wood|paving)-floor$/.test(object.name)) floors.push(object); });
    expect(floors).toHaveLength(3);
    for (const floor of floors) {
      expect(new THREE.Box3().setFromObject(floor).max.y).toBeCloseTo(0, 7);
      const geometry = floor.geometry, positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv');
      expect(uv.count).toBe(positions.count);
      const topU: number[] = [], topV: number[] = [];
      for (let i = 0; i < positions.count; i++) if (normals.getY(i) > .5) { topU.push(uv.getX(i)); topV.push(uv.getY(i)); }
      expect(Math.max(...topU) - Math.min(...topU)).toBeGreaterThan(4);
      expect(Math.max(...topV) - Math.min(...topV)).toBeGreaterThan(3);
      expect(materialOf(floor).userData.homeMaterialRole).toBe(floor.name.includes('wood') ? 'wood-floor' : 'paving');
    }
    const originalContacts = (root: THREE.Object3D) => {
      const values: Record<string, { bounds?: number[]; matrix: number[] }> = {};
      root.traverse(object => {
        if (/^(?:room-bed-\d+|sofa-(?:main|extra))$/.test(object.name)) values[object.name] = { matrix: object.matrixWorld.toArray() };
        if (/^(?:room-bed-\d+-mattress|sofa-(?:main|extra)-seat)$/.test(object.name)) {
          const bounds = new THREE.Box3().setFromObject(object, true);
          values[object.name] = { bounds: [...bounds.min.toArray(), ...bounds.max.toArray()], matrix: object.matrixWorld.toArray() };
        }
      }); return values;
    };
    expect(Object.keys(originalContacts(classic))).toHaveLength(24);
    expect(originalContacts(realistic)).toEqual(originalContacts(classic));
    const soft: THREE.Object3D[] = []; realistic.traverse(object => { if (['padded-pillow', 'folded-quilt'].includes(object.userData.homeDetail)) soft.push(object); });
    expect(soft.length).toBeGreaterThanOrEqual(20);
    for (const object of soft) expect(new THREE.Box3().setFromObject(object, true).isEmpty()).toBe(false);
    let compared = 0;
    for (const row of preservedLayout.cases) {
      const current = buildHomeWorldEnvironment(row.season, { resting: row.count, sleeping: row.count }, { realistic: true }); roots.add(current);
      for (const prior of row.nodes) {
        const object = current.getObjectByName(prior.name); expect(object, `${row.season}/${row.count}/${prior.name}`).toBeDefined();
        const bounds = new THREE.Box3().setFromObject(object!);
        expect(object!.matrixWorld.toArray()).toEqual(prior.matrixWorld);
        if (prior.name === 'home-mahjong-table') {
          // Chair backs were extended 18 cm outward to fit the seated bodies;
          // table/seat anchors and all other original furniture stay fixed.
          for (const axis of [0, 2]) {
            expect(bounds.min.toArray()[axis]).toBeCloseTo(prior.min[axis] - .18, 6);
            expect(bounds.max.toArray()[axis]).toBeCloseTo(prior.max[axis] + .18, 6);
          }
          expect(bounds.min.y).toBe(prior.min[1]); expect(bounds.max.y).toBe(prior.max[1]);
        } else {
          expect(bounds.min.toArray()).toEqual(prior.min); expect(bounds.max.toArray()).toEqual(prior.max);
        }
        compared++;
      }
    }
    expect(compared).toBe(244); expect(compared).toBe(preservedLayout.nodeCount);
    const library = createHomeMaterials(), geometry = new THREE.BoxGeometry(8, .1, 6).translate(2, 0, 3);
    library.uv(geometry, 'wood-floor');
    const p = geometry.getAttribute('position'), n = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv');
    for (let i = 0; i < p.count; i++) if (n.getY(i) > .5) {
      expect(uv.getX(i)).toBeCloseTo(p.getX(i) / 2, 6);
      expect(uv.getY(i)).toBeCloseTo(p.getZ(i) / 2, 6);
    }
    geometry.dispose();
  });

  it('releases shared image and procedural textures once without disposing a second world or notifying after disposal', () => {
    const notify = vi.fn(), first = world(true, notify), firstLoads = loads.slice(), second = world();
    const firstTextures = texturesOf(first), secondTextures = texturesOf(second);
    const firstSpies = [...firstTextures].map(texture => vi.spyOn(texture, 'dispose'));
    const secondSpies = [...secondTextures].map(texture => vi.spyOn(texture, 'dispose'));
    disposeLivingObject(first); roots.delete(first);
    firstSpies.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
    secondSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    firstLoads.forEach(load => load.success());
    expect(notify).not.toHaveBeenCalled();
    expect(first.userData.homeTextureStatus).toEqual({ pending: 0, loaded: 15, failed: 0, unavailable: 0 });
  });

  it('keeps role-specific physical materials and data maps distinct from diffuse image colours', () => {
    const library = createHomeMaterials();
    const roles: HomeMaterialRole[] = ['fabric', 'plaster', 'glass', 'metal', 'wood'];
    const temporary = new THREE.Group(); roots.add(temporary);
    const [fabric, plaster, glass, metal, wood] = roles.map(role => { const material = library.material(role, '#aabbcc'); temporary.add(new THREE.Mesh(new THREE.BoxGeometry(), material)); return material; });
    expect(fabric.bumpMap).not.toBe(plaster.bumpMap);
    expect(fabric.roughness).toBeGreaterThan(wood.roughness);
    expect(metal.metalness).toBeGreaterThan(.5);
    expect(glass.opacity).toBeLessThan(.4); expect(glass.transparent).toBe(true); expect(glass.depthWrite).toBe(false);
    expect(glass.userData.baseOpacity).toBe(glass.opacity);
    loads.forEach(load => load.success());
    expect(wood.normalMap).not.toBeNull(); expect(wood.roughnessMap).not.toBeNull();
    expect(wood.normalMap!.colorSpace).toBe(THREE.NoColorSpace); expect(wood.roughnessMap!.colorSpace).toBe(THREE.NoColorSpace);
  });
});
