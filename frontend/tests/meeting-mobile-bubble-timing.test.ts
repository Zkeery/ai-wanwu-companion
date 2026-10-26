import * as THREE from 'three';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createLivingWorld} from '@/lib/living-world-engine';
import {parseGathering} from '@/lib/gatherings';
import current from './fixtures/id5-current-g50-20261025.json';
import {parseFloor} from '@/lib/villa-floor-sync';
const socialCounter=vi.hoisted(()=>({calls:0}));
vi.mock('@/lib/living-social-gathering',async original=>{const actual=await original<typeof import('@/lib/living-social-gathering')>();return{...actual,planSocialGathering:(...args:Parameters<typeof actual.planSocialGathering>)=>{socialCounter.calls++;return actual.planSocialGathering(...args);}}});
const gpu=vi.hoisted(()=>({instances:[] as Array<{scene:THREE.Scene|null;loop:((time:number)=>void)|null}>}));
vi.mock('three',async original=>{const actual=await original<typeof import('three')>();class OfflineRenderer{
 domElement=document.createElement('canvas');shadowMap={enabled:false,type:0};outputColorSpace='';toneMapping=0;toneMappingExposure=1;scene:THREE.Scene|null=null;loop:((time:number)=>void)|null=null;
 setPixelRatio=vi.fn();setSize=vi.fn();setClearColor=vi.fn();dispose=vi.fn();forceContextLoss=vi.fn();setAnimationLoop=vi.fn((loop:((time:number)=>void)|null)=>{this.loop=loop;});
 render=vi.fn((scene:THREE.Scene,camera:THREE.Camera)=>{scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);this.scene=scene;});constructor(){gpu.instances.push(this);}}
 return {...actual,WebGLRenderer:OfflineRenderer};});
const worlds:Array<ReturnType<typeof createLivingWorld>>=[];
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(1_000_000);gpu.instances=[];socialCounter.calls=0;vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});for(const key of ['fetch','Audio','AudioContext'])vi.stubGlobal(key,vi.fn(()=>{throw new Error('OFFLINE_ONLY');}));vi.spyOn(THREE.TextureLoader.prototype,'load').mockImplementation(()=>new THREE.Texture<HTMLImageElement>());vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);});
afterEach(()=>{worlds.splice(0).forEach(w=>w.dispose());expect(fetch).not.toHaveBeenCalled();expect(Audio).not.toHaveBeenCalled();expect(AudioContext).not.toHaveBeenCalled();document.body.replaceChildren();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
it.each([
 {name:'desktop 30fps without sound',width:800,height:500,interval:34,duration:30_000,playing:true,freezeReady:false,skew:0,expected:true},
 {name:'phone 30fps without sound',width:360,height:360,interval:34,duration:30_000,playing:true,freezeReady:false,skew:0,expected:true},
 {name:'phone 2fps without sound',width:360,height:360,interval:500,duration:60_000,playing:true,freezeReady:false,skew:0,expected:true},
 {name:'phone 1fps without sound',width:360,height:360,interval:1000,duration:60_000,playing:true,freezeReady:false,skew:0,expected:true},
 {name:'documents paused/reduced-motion gate from start',width:360,height:360,interval:1000,duration:60_000,playing:false,freezeReady:false,skew:0,expected:false},
 {name:'documents paused/reduced-motion gate after arrival',width:360,height:360,interval:1000,duration:30_000,playing:false,freezeReady:true,skew:0,expected:false},
 {name:'documents future event clock gate while bodies are ready',width:360,height:360,interval:34,duration:30_000,playing:true,freezeReady:false,skew:60,expected:false},
])('$name',({name,width,height,interval,duration,playing,freezeReady,skew,expected})=>{
 const source={...structuredClone(current.group),me:'fixture-owner-1',companions:current.group.companions.map(c=>c.id===5?{...c,activity:'talk',area:'outdoor',leisure:null}:c),events:[{id:'synthetic-talk-event',message:'合成公共相聚记录',kind:'activity',activity:'talk',area:'outdoor',characters:[2,5],at:Date.now()/1000+skew,origin:'offline_rules'}]},group=parseGathering(source),original=JSON.stringify(group),host=document.createElement('div'),labels=document.createElement('div');Object.defineProperties(host,{clientWidth:{value:width},clientHeight:{value:height}});document.body.append(host,labels);
 const request=vi.fn(),world=createLivingWorld(host,labels,group,vi.fn(),vi.fn(),{persistentWorld:true,realistic:true,localLeisurePreview:true,localRoomTransitions:true,localCompanionDoors:true,localReferenceVilla:true,localNaturalWorld:true,localNaturalLeisure:true,localQuietAudio:true,onLeisureRequest:request});worlds.push(world);world.setHouseView('exterior');world.update(group,5,'outdoor');expect(world.applyServerFloor(parseFloor(current.floor))).toBe(true);const renderer=gpu.instances.at(-1)!,scene=renderer.scene!,actor=(id:number)=>scene.children.find(o=>o.userData.characterId===id)!;
 if(freezeReady){world.setMotion(true);for(let i=0;i<100;i++){vi.setSystemTime(Date.now()+100);renderer.loop!(Date.now());}expect([2,5].every(id=>actor(id).userData.socialGathering?.ready)).toBe(true);}
 world.setMotion(playing);const started=Date.now(),seen=new Set<number>(),seenInside=new Set<number>(),samples:unknown[]=[];let readyAt:number|null=null;
 for(let i=0;i<Math.ceil(duration/interval);i++){
  vi.setSystemTime(Date.now()+interval);if(playing)renderer.loop!(Date.now());else world.update(group,5,'outdoor');
  if(readyAt===null&&[2,5].every(id=>actor(id).userData.socialGathering?.ready))readyAt=Date.now()-started;
  const records=[2,5].map(id=>{const c=group.companions.find(c=>c.id===id)!,marker=[...labels.children].find(e=>e.querySelector('button')?.textContent===c.name) as HTMLElement|undefined,bubble=marker?.querySelector<HTMLElement>('[data-kind="preset"]'),visible=!!bubble&&!bubble.hidden&&!marker?.hidden&&marker?.dataset.occluded!=='true',match=marker?.style.transform.match(/translate\(([-\d.]+)px,([-\d.]+)px\)/),x=match?Number(match[1]):null,y=match?Number(match[2]):null,inside=x!==null&&y!==null&&x>=0&&x<=width&&y>=0&&y<=height;if(visible)seen.add(id);if(visible&&inside)seenInside.add(id);return{id,position:actor(id).position.toArray(),social:actor(id).userData.socialGathering,journey:actor(id).userData.homeJourney,markerHidden:marker?.hidden,bubbleHidden:bubble?.hidden,occluded:marker?.dataset.occluded,visible,anchor:{x,y,inside},text:bubble?.textContent??null};});
  if([0,Math.ceil(12_000/interval),Math.ceil(duration/interval)-1].includes(i))samples.push({elapsed:Date.now()-started,records});
 }
 console.info('MOBILE_SOCIAL_BUBBLE_METRICS '+JSON.stringify({name,width,height,interval,duration,playing,freezeReady,skew,readyAt,seen:[...seen],seenInside:[...seenInside],planCalls:socialCounter.calls,samples}));expect(JSON.stringify(group)).toBe(original);expect(request).not.toHaveBeenCalled();if(expected){expect([...seen].sort(),'conversation must be readable without enabling sound').toEqual([2,5]);expect([...seenInside].sort(),'speaker markers must lie within the scene viewport').toEqual([2,5]);}else{if(playing||freezeReady)expect(readyAt).not.toBeNull();expect(seen.size).toBe(0);}
},120_000);
