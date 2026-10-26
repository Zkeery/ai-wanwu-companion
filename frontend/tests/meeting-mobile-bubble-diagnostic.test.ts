import * as THREE from 'three';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createLivingWorld} from '@/lib/living-world-engine';
import {parseGathering} from '@/lib/gatherings';
import raw from './fixtures/id5-current-g50-20261025.json';
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
 {name:'mobile A overview',width:350,height:400,me:'fixture-owner-0',view:'overview' as const},
 {name:'mobile B outdoor',width:350,height:400,me:'fixture-owner-1',view:'outdoor' as const},
 {name:'desktop A overview',width:800,height:500,me:'fixture-owner-0',view:'overview' as const},
 {name:'desktop B outdoor',width:800,height:500,me:'fixture-owner-1',view:'outdoor' as const},
])('$name: after ten seconds walk, both preset speaker bubbles must be in a visible parent',({width,height,me,view})=>{
 const host=document.createElement('div'),labels=document.createElement('div');Object.defineProperties(host,{clientWidth:{value:width},clientHeight:{value:height}});document.body.append(host,labels);
 const group=parseGathering({...raw.group,me}),world=createLivingWorld(host,labels,group,vi.fn(),vi.fn(),{persistentWorld:true,realistic:true,localLeisurePreview:true,localRoomTransitions:true,localCompanionDoors:true,localReferenceVilla:true,localQuietAudio:true});worlds.push(world);world.setHouseView('exterior');world.setMotion(true);const renderer=gpu.instances.at(-1)!,scene=renderer.scene!,actor=(id:number)=>scene.children.find(o=>o.userData.characterId===id)!;
 const step=()=>{vi.setSystemTime(Date.now()+100);renderer.loop!(Date.now());};for(let frame=0;frame<100;frame++)step();
 const next=parseGathering({...raw.group,me,revision:raw.group.revision+1,companions:raw.group.companions.map(c=>c.id===5?{...c,activity:'talk',area:'outdoor',leisure:null}:c),events:[...raw.group.events,{id:'offline-mobile-talk',kind:'activity',activity:'talk',area:'outdoor',at:Date.now()/1000,characters:[2,5],origin:'offline_rules',message:'offline fixture'}]});world.update(next,5,view);
 const visible=new Set<number>(),bubbleExists=new Set<number>();let firstReady:number|null=null;const samples:unknown[]=[];
 for(let frame=0;frame<250;frame++){step();if(firstReady===null&&[2,5].every(id=>actor(id).userData.socialGathering?.ready))firstReady=frame;
  for(const id of [2,5]){const marker=[...labels.children].find(e=>e.querySelector('button')?.textContent===next.companions.find(c=>c.id===id)!.name) as HTMLElement,bubble=marker.querySelector<HTMLElement>('[data-kind="preset"]'),xy=marker.style.transform.match(/translate\(([-\d.]+)px,([-\d.]+)px\)/);if(bubble&&!bubble.hidden){bubbleExists.add(id);if(!marker.hidden&&xy&&Number(xy[1])>=0&&Number(xy[1])<=width&&Number(xy[2])>=0&&Number(xy[2])<=height)visible.add(id);}}
  if([0,100,249].includes(frame))samples.push({frame,host:{social:host.dataset.socialParticipants,journey:host.dataset.journeyActive},actors:[2,5].map(id=>({id,position:actor(id).position.toArray(),social:actor(id).userData.socialGathering})),labels:[...labels.children].map(e=>({name:e.querySelector('button')?.textContent,hidden:(e as HTMLElement).hidden,occluded:(e as HTMLElement).dataset.occluded,transform:(e as HTMLElement).style.transform,bubble:e.querySelector<HTMLElement>('.living3d-bubble')?.hidden}))});
 }
 console.info('MOBILE_BUBBLE_DIAGNOSTIC '+JSON.stringify({width,height,me,view,firstReady,bubbleExists:[...bubbleExists],visible:[...visible],samples}));expect(firstReady).not.toBeNull();expect([...visible].sort()).toEqual([2,5]);
},120000);
