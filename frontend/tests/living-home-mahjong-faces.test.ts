import * as THREE from 'three';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {applyHomeMahjongFace,setHomeMahjongFaceExposed} from '../lib/living-home-mahjong-faces';
import {buildHomeWorldEnvironment} from '../lib/living-home-world-meshes';
import {disposeLivingObject} from '../lib/living-world-engine';

const roots:THREE.Object3D[]=[];
const context={fillRect:vi.fn(),strokeRect:vi.fn(),fillText:vi.fn(),beginPath:vi.fn(),arc:vi.fn(),fill:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),closePath:vi.fn()};
beforeEach(()=>{vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation(()=>context as unknown as CanvasRenderingContext2D);vi.spyOn(THREE.TextureLoader.prototype,'load').mockImplementation(()=>new THREE.Texture<HTMLImageElement>());vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('mahjong faces must stay offline');}));Object.values(context).forEach(value=>{if(vi.isMockFunction(value))value.mockClear();});});
afterEach(()=>{roots.splice(0).forEach(root=>disposeLivingObject(root));expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();vi.restoreAllMocks();});
function tile(){const value=new THREE.Group();value.name='home-mahjong-tile-0';value.userData.homeMahjongTile=true;value.add(new THREE.Mesh(new THREE.BoxGeometry(.065,.06,.095),new THREE.MeshStandardMaterial({color:'#ebe5cf'})));const back=new THREE.Mesh(new THREE.BoxGeometry(.058,.005,.086),new THREE.MeshStandardMaterial({color:'#758c74'}));back.position.y=.032;value.add(back);roots.push(value);return value;}
function overlay(value:THREE.Object3D){return value.getObjectByName('home-mahjong-face-overlay') as THREE.Mesh<THREE.PlaneGeometry,THREE.MeshStandardMaterial>;}
const numerals=['一','二','三','四','五','六','七','八','九'];
const faces=[...numerals.flatMap(n=>[n+'万',n+'筒',n+'条']),'东风','南风','西风','北风','红中','发财','白板'];

describe('owned local canvas faces for all 34 mahjong tiles',()=>{
  it('renders all 34 whitelisted faces with correct canvas dimensions and actual suit graphics',()=>{
    expect(faces).toHaveLength(34);
    for(const face of faces){const value=tile();expect(applyHomeMahjongFace(value,face),face).toBe(true);expect(value.userData.mahjongFace).toBe(face);const map=overlay(value).material.map as THREE.CanvasTexture;expect(map).toBeInstanceOf(THREE.CanvasTexture);expect(map.image.width).toBe(256);expect(map.image.height).toBe(384);expect(map.colorSpace).toBe(THREE.SRGBColorSpace);}
    expect(context.arc).toHaveBeenCalled();expect(context.fillText).toHaveBeenCalledWith('萬',128,265);expect(context.fillText).toHaveBeenCalledWith('中',128,193);expect(context.fillText).toHaveBeenCalledWith('發',128,193);expect(context.lineTo).toHaveBeenCalled();
  });
  it('rejects unknown labels before creating any canvas or changing the original tile',()=>{
    const value=tile(),children=[...value.children],create=vi.spyOn(document,'createElement');
    for(const face of ['十万','零筒','一饼','东','中','一万<script>','一万 ',''])expect(applyHomeMahjongFace(value,face)).toBe(false);
    expect(create).not.toHaveBeenCalled();expect(value.children).toEqual(children);expect(value.userData.mahjongFace).toBeUndefined();
  });
  it('keeps actual existing tile geometry, materials and transforms while the face follows a lifted tile',()=>{
    const world=buildHomeWorldEnvironment('summer',{resting:1,sleeping:1},{realistic:true});roots.push(world);const value=world.getObjectByName('home-mahjong-tile-0')!;
    const original=value.children.map(object=>({object,position:object.position.toArray(),rotation:object.quaternion.toArray(),scale:object.scale.toArray(),geometry:object instanceof THREE.Mesh?object.geometry:null,material:object instanceof THREE.Mesh?object.material:null}));
    const before={position:value.position.toArray(),quaternion:value.quaternion.toArray(),scale:value.scale.toArray(),matrix:value.matrix.toArray()};expect(applyHomeMahjongFace(value,'九筒')).toBe(true);const face=overlay(value);
    expect(value.position.toArray()).toEqual(before.position);expect(value.quaternion.toArray()).toEqual(before.quaternion);expect(value.scale.toArray()).toEqual(before.scale);expect(value.matrix.toArray()).toEqual(before.matrix);
    for(const old of original){expect(old.object.position.toArray()).toEqual(old.position);expect(old.object.quaternion.toArray()).toEqual(old.rotation);expect(old.object.scale.toArray()).toEqual(old.scale);if(old.object instanceof THREE.Mesh){expect(old.object.geometry).toBe(old.geometry);expect(old.object.material).toBe(old.material);}}
    expect(face.position.y).toBeCloseTo(.0351);expect(face.geometry.parameters.width).toBeCloseTo(.0585);expect(face.geometry.parameters.height).toBeCloseTo(.0855);
    const normal=new THREE.Vector3(0,0,1).transformDirection(new THREE.Matrix4().makeRotationX(-Math.PI/2));expect(normal.y).toBeCloseTo(1);
    const arm=new THREE.Group();roots.push(arm);arm.position.set(2,1,3);arm.rotation.set(.2,.7,-.1);arm.add(value);value.position.set(.075,-.265,.095);value.rotation.set(.15,0,.12);arm.updateWorldMatrix(true,true);expect(face.parent).toBe(value);expect(face.getWorldPosition(new THREE.Vector3()).distanceTo(value.localToWorld(face.position.clone()))).toBeLessThan(1e-8);
  });
  it('reuses the same face without another canvas or resource allocation',()=>{
    const value=tile();expect(applyHomeMahjongFace(value,'发财')).toBe(true);const face=overlay(value),create=vi.spyOn(document,'createElement'),map=face.material.map;
    expect(applyHomeMahjongFace(value,'发财')).toBe(true);expect(overlay(value)).toBe(face);expect(face.material.map).toBe(map);expect(create).not.toHaveBeenCalled();expect(value.children).toHaveLength(3);
  });
  it('disposes only the replaced owned face, retaining all original materials and geometry',()=>{
    const value=tile(),original=value.children[0] as THREE.Mesh;expect(applyHomeMahjongFace(value,'三条')).toBe(true);const old=overlay(value),map=old.material.map!;const gd=vi.spyOn(old.geometry,'dispose'),md=vi.spyOn(old.material,'dispose'),td=vi.spyOn(map,'dispose'),originalG=vi.spyOn(original.geometry,'dispose'),originalM=vi.spyOn(original.material as THREE.Material,'dispose');
    expect(applyHomeMahjongFace(value,'北风')).toBe(true);expect(overlay(value)).not.toBe(old);expect(old.parent).toBeNull();expect(gd).toHaveBeenCalledTimes(1);expect(md).toHaveBeenCalledTimes(1);expect(td).toHaveBeenCalledTimes(1);expect(originalG).not.toHaveBeenCalled();expect(originalM).not.toHaveBeenCalled();expect(value.children).toHaveLength(3);
  });
  it('leaves the existing tree and face untouched if canvas 2d is unavailable or drawing fails',()=>{
    const value=tile();expect(applyHomeMahjongFace(value,'五万')).toBe(true);const children=[...value.children],face=overlay(value),dispose=vi.spyOn(face.material.map!,'dispose');
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null);expect(applyHomeMahjongFace(value,'六万')).toBe(false);expect(value.children).toEqual(children);expect(value.userData.mahjongFace).toBe('五万');
    context.fillRect.mockImplementationOnce(()=>{throw new Error('canvas blocked');});expect(applyHomeMahjongFace(value,'七万')).toBe(false);expect(value.children).toEqual(children);expect(overlay(value)).toBe(face);expect(value.userData.mahjongFace).toBe('五万');expect(dispose).not.toHaveBeenCalled();
    const empty=new THREE.Group();roots.push(empty);expect(applyHomeMahjongFace(empty,'东风')).toBe(false);expect(empty.children).toHaveLength(0);expect(empty.userData.mahjongFace).toBeUndefined();
  });
  it('keeps face resources owned per tile and allows normal scene disposal to release all of them',()=>{
    const a=tile(),b=tile();expect(applyHomeMahjongFace(a,'白板')).toBe(true);expect(applyHomeMahjongFace(b,'白板')).toBe(true);const x=overlay(a),y=overlay(b);expect(x.material.map).not.toBe(y.material.map);expect(x.geometry).not.toBe(y.geometry);const geometry=vi.spyOn(x.geometry,'dispose'),material=vi.spyOn(x.material,'dispose'),texture=vi.spyOn(x.material.map!,'dispose');disposeLivingObject(a);expect(geometry).toHaveBeenCalledTimes(1);expect(material).toHaveBeenCalledTimes(1);expect(texture).toHaveBeenCalledTimes(1);roots.splice(roots.indexOf(a),1);
  });
  it('conceals a held tile without changing its green back, transform or owned resources',()=>{
    const value=tile(),back=value.children[1] as THREE.Mesh;expect(applyHomeMahjongFace(value,'八筒')).toBe(true);
    const face=overlay(value),geometry=face.geometry,material=face.material,texture=face.material.map,children=[...value.children],position=value.position.toArray();
    setHomeMahjongFaceExposed(value,false);
    expect(face.visible).toBe(false);expect(value.userData.mahjongFaceExposed).toBe(false);expect(back.visible).toBe(true);expect((back.material as THREE.MeshStandardMaterial).color.getHexString()).toBe('758c74');
    for(const yaw of [0,Math.PI/2,Math.PI,Math.PI*1.5]){value.rotation.y=yaw;value.updateMatrixWorld(true);const publicFaces:THREE.Object3D[]=[];value.traverseVisible(o=>{if(o.userData.mahjongFaceOverlay)publicFaces.push(o);});expect(publicFaces).toHaveLength(0);}
    setHomeMahjongFaceExposed(value,true);expect(face.visible).toBe(true);expect(value.userData.mahjongFaceExposed).toBe(true);expect(value.children).toEqual(children);expect(value.position.toArray()).toEqual(position);expect(face.geometry).toBe(geometry);expect(face.material).toBe(material);expect(face.material.map).toBe(texture);
  });
  it('does not reveal a newly assigned private face until it is explicitly exposed',()=>{
    const value=tile();setHomeMahjongFaceExposed(value,false);expect(applyHomeMahjongFace(value,'一万')).toBe(true);expect(overlay(value).visible).toBe(false);
    const first=overlay(value),dispose=vi.spyOn(first.geometry,'dispose');expect(applyHomeMahjongFace(value,'九条')).toBe(true);expect(overlay(value).visible).toBe(false);expect(dispose).toHaveBeenCalledTimes(1);expect(applyHomeMahjongFace(value,'九条')).toBe(true);expect(overlay(value).visible).toBe(false);
    setHomeMahjongFaceExposed(value,true);expect(overlay(value).visible).toBe(true);expect(value.userData.mahjongFace).toBe('九条');
  });

});
