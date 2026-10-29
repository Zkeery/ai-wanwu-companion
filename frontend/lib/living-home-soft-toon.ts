import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { SCENE_SCALE } from './living-scene-scale';
import { sceneRoundedBox, sceneFoliage } from './living-scene-shapes';
import { buildSoftCottageExterior, applySoftCottageView } from './living-home-cottage';
import { createHomeToonRamp } from './living-home-toon-style';

const PALETTE = {
  wall: ['#f6e4bf', '#f0dcaf', '#f9ebcf'], roof: ['#77b4a0', '#82bcaa', '#70aa98'],
  wood: ['#c79768', '#bf8c5c', '#d2a576'], stone: ['#d8d2b6', '#e4d7b9', '#cfc7ad'],
  grass: ['#b7d58c', '#accd82', '#c2dc9c'], foliage: ['#7eae6e', '#91bb7b', '#a2c989'],
  fabric: ['#eec6a1', '#d7dcb7', '#e9d4b0'], glass: ['#b0dad5', '#c3e3dc', '#a5d0ca'],
};
const stableIndex = (name: string) => [...name].reduce((value, ch) => (value * 31 + ch.charCodeAt(0)) >>> 0, 17) % 3;

/** Soft color gradients plus baked ambient occlusion: no full-screen AO pass or texture I/O. */
function gradientAndAO(shape: THREE.BufferGeometry): void {
  if (shape.userData.softSceneGradient) return;
  shape.computeBoundingBox(); const bounds = shape.boundingBox!;
  const position = shape.getAttribute('position'), colors: number[] = [], occlusion: number[] = [];
  const height = Math.max(.05, bounds.max.y - bounds.min.y);
  for (let i = 0; i < position.count; i++) {
    const y = (position.getY(i) - bounds.min.y) / height;
    const variation = Math.sin(position.getX(i) * .48 + position.getZ(i) * .36) * .023;
    const shade = .87 + y * .13 + variation;
    colors.push(shade, shade * (.987 + y * .013), shade * (.965 + y * .035));
    occlusion.push(.84 + THREE.MathUtils.smoothstep(y, 0, .38) * .16);
  }
  shape.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  shape.setAttribute('sceneOcclusion', new THREE.Float32BufferAttribute(occlusion, 1));
  shape.userData.softSceneGradient = true;
}

function softMaterial(color: string, ramp: THREE.DataTexture, source?: THREE.Material): THREE.MeshToonMaterial {
  const value = new THREE.MeshToonMaterial({ color, gradientMap: ramp, vertexColors: true,
    side: source?.side ?? THREE.FrontSide, transparent: source?.transparent ?? false,
    opacity: source?.opacity ?? 1, depthWrite: source?.depthWrite ?? true });
  value.userData = { ...source?.userData, sceneStyle: 'soft-toon', bakedAmbientOcclusion: true, homeOwnedTextures: [ramp, ...(source?.userData.homeOwnedTextures ?? [])] };
  value.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float sceneOcclusion; varying float vSceneOcclusion;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSceneOcclusion = sceneOcclusion;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vSceneOcclusion;')
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= vSceneOcclusion;');
  };
  value.customProgramCacheKey = () => 'soft-home-four-band-gradient-ao-v2';
  return value;
}

/** Every patch shares one mesh/material; soft local AO anchors objects to either ground level. */
export function addHomeContactAO(root: THREE.Group): void {
  root.updateWorldMatrix(true, true);
  const fragments: THREE.BufferGeometry[] = [];
  const add = (x: number, z: number, w: number, d: number, y: number) => {
    const part = new THREE.PlaneGeometry(Math.max(.25, w) + .22, Math.max(.25, d) + .22);
    part.rotateX(-Math.PI / 2); part.translate(x, y, z); fragments.push(part);
  };
  root.traverse(object => {
    if (!object.userData.homeNavObstacle || object.userData.softHomeAOAdded) return;
    let visible = true;
    for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (!parent.visible||root.name==='home-world-environment'&&(['indoor','bedroom'].includes(parent.userData.homeRegion)||/villa-indoor-stair|home-villa-upper-interior/.test(parent.name))) visible = false;
    if (!visible) return;
    const box = new THREE.Box3().setFromObject(object), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    if (!Number.isFinite(box.min.y) || box.min.y > .18 || size.x > 12 || size.z > 12) return;
    const local = root.worldToLocal(center);
    add(local.x, local.z, size.x, size.z, box.min.y < -.2 ? -.365 : .016);
    object.userData.softHomeAOAdded = true;
  });
  if (root.name === 'home-world-environment') add(0, -4.225, 12.2, 8.9, -.365);
  if (!fragments.length) return;
  const geometry = mergeGeometries(fragments, false)!; fragments.forEach(part => part.dispose());
  const material = new THREE.ShaderMaterial({ transparent: true, depthWrite: false,
    vertexShader: 'varying vec2 vAO; void main(){vAO=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: 'varying vec2 vAO;void main(){vec2 p=(vAO-.5)*2.;float a=pow(max(0.,1.-dot(p,p)),1.7)*.22;gl_FragColor=vec4(.24,.33,.22,a);}',
  });
  const mesh = new THREE.Mesh(geometry, material); mesh.name = 'home-soft-contact-ambient-occlusion';
  mesh.renderOrder = 1; root.add(mesh);
}

function gardenDetails(root: THREE.Group): void {
  const garden = new THREE.Group(); garden.name = 'home-soft-garden-details'; root.add(garden);
  const batches = new Map<string, THREE.BufferGeometry[]>();
  function add(shape: THREE.BufferGeometry, color: string, x: number, y: number, z: number) {
    shape.translate(x, y, z); const parts = batches.get(color) ?? []; parts.push(shape); batches.set(color, parts);
  }
  // Reuse the unchanged entrance route, then continue it through the lawn to the gate.
  const path = [[-2.4,.48],[-2.32,1.3],[-1.94,2.1],[-1.35,2.85],[-.63,3.55],[-.1,4.4],[.03,5.35],[0,6.35],[0,7.37]];
  path.forEach(([x,z], i) => { const shape = sceneRoundedBox(SCENE_SCALE.pathWidth, .055, .7, .15); shape.rotateY((i % 3 - 1) * .1); add(shape, i % 2 ? '#e3d7b8' : '#eee2c6', x, .018, z); });
  for (let i = 0; i < 100; i++) {
    const side = i % 2 ? 1 : -1, outside = i > 35;
    const x = side * (i > 65 ? 8.2 + (i % 7) * 1.1 : outside ? 6.55 + (i % 5) * .3 : 3.85 + (i % 4) * .28), z = i > 65 ? -7 + (i * 1.718) % 19 : .48 + (i * 1.718) % 7.1;
    const ground = outside ? -.34 : .018;
    for (let blade = 0; blade < 3; blade++) {
      const shape = new THREE.SphereGeometry(1, 5, 3); shape.scale(.028, SCENE_SCALE.grassHeight * (.75 + blade * .1), .025);
      shape.rotateZ((blade - 1) * .44); shape.rotateY(i * 2.4);
      add(shape, i % 3 ? '#8db76e' : '#a4c980', x + (blade - 1) * .052, ground + SCENE_SCALE.grassHeight * .64, z);
    }
    if (i % 2 === 0) {
      const shape = sceneFoliage(); shape.scale(.085 + i % 3 * .025, SCENE_SCALE.pebbleHeight, .065 + i % 2 * .03);
      add(shape, i % 4 ? '#d9d5bb' : '#c5c7ab', x + .19, ground + SCENE_SCALE.pebbleHeight * .6, z + .13);
    }
  }
  // Sparse round daisies replace thousands of realistic petal / leaf fragments.
  for (let i = 0; i < 36; i++) {
    const side = i % 2 ? 1 : -1, x = side * (6.48 + i % 3 * .19), z = .8 + (i * .723) % 7;
    const y = -.17 + i % 3 * .055;
    const stem = new THREE.CylinderGeometry(.013,.02,.24,5); add(stem, '#81a665', x, y-.11, z);
    for (let petal = 0; petal < 5; petal++) {
      const angle = petal * Math.PI * 2 / 5, shape = new THREE.SphereGeometry(1, 6, 4); shape.scale(.062,.025,.042); shape.rotateY(-angle);
      add(shape, i % 3 ? '#fff0c6' : '#efbbaa', x+Math.cos(angle)*.062,y,z+Math.sin(angle)*.062);
    }
    const center = new THREE.SphereGeometry(.035,6,4); add(center, '#e9c469',x,y+.017,z);
  }
  batches.forEach((parts, color) => {
    // Merged geometry needs a consistent index layout across primitive types.
    const shapes = parts.map(part => part.index ? part.toNonIndexed() : part);
    const geometry = mergeGeometries(shapes, false)!; shapes.forEach(shape => shape.dispose()); parts.forEach(shape => shape.dispose());
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({color,roughness:.9}));
    mesh.name = 'home-soft-garden-' + color.slice(1); mesh.castShadow = mesh.receiveShadow = true; garden.add(mesh);
  });
}

/** Home-only visual pilot. Saved navigation, room/door anchors and asset generation stay unchanged. */
export function applySoftHomeScene(root: THREE.Group): void {
  if (root.userData.softHomeStyle) return;
  root.userData.softHomeStyle = true;
  const environment = root.name === 'home-world-environment';
  root.updateWorldMatrix(true,true);
  root.traverse(object=>{
    if(object instanceof THREE.Group&&object.name==='home-realistic-item-bench')object.scale.y=SCENE_SCALE.seatHeight/.605;
    if(!(object instanceof THREE.Group)||!/^room-planter-|^home-farmhouse-planter-/.test(object.name))return;
    const box=new THREE.Box3().setFromObject(object,true),height=box.max.y-box.min.y;
    if(height>SCENE_SCALE.smallPropMaxHeight)object.scale.multiplyScalar(SCENE_SCALE.smallPropMaxHeight/height);
  });
  if (environment) {
    // The tall utility gatehouse hid the yard and competed with the main home.
    const hiddenNames = ['home-reference-villa-front-gatehouse', 'home-reference-villa-raised-garden-soil',
      'home-reference-villa-flower-bed-edging', 'home-reference-villa-individual-tile-ribs'];
    for (const name of hiddenNames) {
      const object = root.getObjectByName(name);
      if (object) { object.visible = false; object.userData.referenceVillaSuperseded = true; }
    }
    root.traverse(object => {
      if (/^home-entry-path-/.test(object.name) || /^home-reference-villa-flower-(?:leaves|stems|petals|centers)/.test(object.name) || object instanceof THREE.Mesh&&object.parent?.name==='courtyard-fixed-border-foliage'&&!object.name&&object.userData.homeMaterialRole==='wood') {
        object.visible = false; object.userData.referenceVillaSuperseded = true;
      }
    });
    buildSoftCottageExterior(root);
    const mahjong=root.getObjectByName('home-mahjong-table'),teaStation=root.getObjectByName('home-farmhouse-tea-table');
    const mahjongY=SCENE_SCALE.tableHeight/.795,teaY=SCENE_SCALE.tableHeight/.73;
    if(mahjong)mahjong.scale.y=mahjongY;if(teaStation)teaStation.scale.y=teaY;
    // Scale whole stations so cups/tiles remain on the tabletops, then set the seat height independently.
    for (let i=0;i<4;i++) {
      const chair=root.getObjectByName('home-mahjong-chair-'+i); if(chair)chair.scale.set(SCENE_SCALE.seatWidth/.7,SCENE_SCALE.seatHeight/(.465*mahjongY),SCENE_SCALE.seatWidth/.7);
    }
    const stool=root.getObjectByName('home-tea-stool'); if(stool)stool.scale.set(SCENE_SCALE.stoolDiameter/.42,SCENE_SCALE.seatHeight/(.465*teaY),SCENE_SCALE.stoolDiameter/.42);
    for(const name of ['home-mahjong-table','home-farmhouse-tea-table']){
      const station=root.getObjectByName(name);if(!station)continue;
      for(const key of ['homeLeisureSeats','homeLeisureWorldSeats'])for(const seat of station.userData[key]??[])if(typeof seat.y==='number')seat.y=SCENE_SCALE.seatHeight/(key==='homeLeisureSeats'?station.scale.y:1);
      if(station.userData.homeLeisureWorldTarget)station.userData.homeLeisureWorldTarget.y*=station.scale.y;
    }
    const table=root.getObjectByName('home-mahjong-table-body'); if(table)table.scale.set(SCENE_SCALE.tableWidth/1.28,1,SCENE_SCALE.tableWidth/1.28);
    const tea=root.getObjectByName('home-farmhouse-tea-table-body'); if(tea)tea.scale.set(SCENE_SCALE.tableWidth/1.08,1,SCENE_SCALE.tableWidth/1.08);
    gardenDetails(root);
  }
  const ramp=createHomeToonRamp();
  const materials=new Map<string,THREE.MeshToonMaterial>(), replaced=new Set<THREE.Material>();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || /television-screen|mahjong.*(?:face|tile)|ambient-occlusion/.test(object.name)) return;
    let superseded=false; for(let parent:THREE.Object3D|null=object;parent;parent=parent.parent)if(parent.userData.referenceVillaSuperseded||parent.name==='home-reference-villa-retained-materials')superseded=true;
    if(superseded||!object.geometry.getAttribute('position')?.count)return;
    const name=object.name, role=String(object.userData.homeMaterialRole ?? (Array.isArray(object.material)?object.material[0]:object.material).userData.homeMaterialRole ?? '');
    if(object instanceof THREE.InstancedMesh && /outside-(?:tree-leaves|low-shrubs)/.test(name)) {
      object.geometry.dispose(); object.geometry=sceneFoliage();
      if(name.endsWith('tree-leaves')){
        const poses:THREE.Matrix4[]=[];const matrix=new THREE.Matrix4(),p=new THREE.Vector3(),q=new THREE.Quaternion(),s=new THREE.Vector3();
        for(let tree=0;tree<6;tree++)for(const branch of [0,6,12]){object.getMatrixAt(tree*18+branch,matrix);matrix.decompose(p,q,s);s.multiplyScalar(1.45);poses.push(new THREE.Matrix4().compose(p,q,s));}
        poses.forEach((pose,index)=>object.setMatrixAt(index,pose));object.count=poses.length;object.instanceMatrix.needsUpdate=true;
        object.computeBoundingSphere();object.computeBoundingBox();
      }
    } else if(object.geometry.type==='IcosahedronGeometry'||role==='foliage'&&object.geometry.type==='SphereGeometry'&&(object.geometry as THREE.SphereGeometry).parameters.widthSegments<12) {
      object.geometry.computeBoundingBox();const bounds=object.geometry.boundingBox!,size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
      const worldSize=size.clone().multiply(object.getWorldScale(new THREE.Vector3()));
      object.geometry.dispose(); object.geometry=Math.max(worldSize.x,worldSize.y,worldSize.z)>1.4?new THREE.SphereGeometry(1,12,8):sceneFoliage();object.geometry.scale(size.x/2,size.y/2,size.z/2);object.geometry.translate(center.x,center.y,center.z);
    } else if(object.geometry.type==='BoxGeometry') {
      const p=(object.geometry as THREE.BoxGeometry).parameters;
      object.geometry.computeBoundingBox(); const bounds=object.geometry.boundingBox!, size=bounds.getSize(new THREE.Vector3()), center=bounds.getCenter(new THREE.Vector3());
      // Some stair parts bake their rotation/translation into the vertices. Keep those transforms.
      if(center.length()<.0001&&Math.abs(size.x-p.width)<.0001&&Math.abs(size.y-p.height)<.0001&&Math.abs(size.z-p.depth)<.0001){object.geometry.dispose();object.geometry=sceneRoundedBox(p.width,p.height,p.depth);}
    }
    // Spend extra curved segments on the nearby seats and tabletops only.
    if (/^home-(?:mahjong-table-body|farmhouse-tea-table-body|mahjong-chair-\d-seat)$/.test(name) && object.geometry.type!=='RoundedBoxGeometry') {
      object.geometry.computeBoundingBox();const bounds=object.geometry.boundingBox!,size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
      object.geometry.dispose();object.geometry=new RoundedBoxGeometry(size.x,size.y,size.z,2,Math.min(.1,size.y*.45));object.geometry.translate(center.x,center.y,center.z);
    }
    if(name==='home-realistic-grass-ground')object.scale.set(3,1,3);
    let palette:keyof typeof PALETTE = /roof|ridge|eave/.test(name)||role==='roof'?'roof'
      : /grass-ground|paving-floor/.test(name)||role==='grass'?'grass'
      : /flower-petals|flower-centers|home-soft-garden-/.test(name)?'wall'
      : role==='foliage'?'foliage':role==='wood'||role==='wood-floor'?'wood'
      :role==='stone'||role==='paving'?'stone':role==='fabric'?'fabric':role==='glass'?'glass':'wall';
    if(/balcony-railings|eave-fascia|^villa-stair-(?:tread|handrail|post)/.test(name))palette='wood';
    gradientAndAO(object.geometry);
    const convert=(old:THREE.Material)=>{
      const color=name.startsWith('home-soft-garden-')&&'color'in old?(old.color as THREE.Color).getStyle():PALETTE[palette][stableIndex(name)];
      const key=old.uuid+':'+color; let material=materials.get(key);
      if(!material){material=softMaterial(color,ramp,old);if(palette==='glass'){material.opacity=object.userData.softCottageGlass?1:.88;material.transparent=!object.userData.softCottageGlass;material.userData.baseOpacity=material.opacity;}materials.set(key,material);}
      replaced.add(old);return material;
    };
    object.material=Array.isArray(object.material)?object.material.map(convert):convert(object.material);
    object.receiveShadow=true;
  });
  replaced.forEach(material=>material.dispose());
  if(!materials.size)ramp.dispose();
  addHomeContactAO(root);
  root.userData.homeMaterialMode='soft-toon';
  root.userData.sceneScale=SCENE_SCALE;
  if(environment)applySoftCottageView(root,root.userData.architectureMode==='exterior');
}
