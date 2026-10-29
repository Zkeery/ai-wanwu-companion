import { planSocialGathering, socialGroupReady, socialGatheringTurn, type SocialPlan } from './living-social-gathering';
import { applyToonScene, TOON_SCENE } from './living-scene-toon';
import { HOME_CARTOON_CAMERA, SCENE_SCALE } from './living-scene-scale';
import { applySoftCottageView } from './living-home-cottage';
import { constrainRoomCamera, collectArchitectureOccluders, prepareArchitectureOcclusion } from './living-room-visibility';
import { supportVillaStairFeet } from './living-villa-stair-mesh';
import { VILLA_STAIR_BOTTOM } from './living-villa-stair-visit';
import type {FloorSnapshot} from './villa-floor-sync';
import {createVillaFloorLife,type VillaActivity} from './living-villa-floor-life';
import {buildVillaLifePlan,villaLifeFurniture} from './living-villa-life-plan';
import { applyVillaUpperView, setVillaUpperDoor, stepVillaUpperDoor, VILLA_UPPER_CAMERA } from './living-villa-upper-floor';
import type { PublicSharedMahjongSnapshot } from './shared-mahjong';
import { sharedMahjongAnimation } from './living-shared-mahjong';
import { persistentLivingScope, planLivingLeisure, type LivingLeisureRequest } from './living-persistent-world';
import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createWorldTapTracker } from './living-world-tap';
import { createLivingWorldFrameClock } from './living-world-frame-clock';
import { layoutLivingLabels, type LivingLabelAnchor } from './living-world-label-layout';
import { companionPosition, gatheringCompanionArea, type Gathering } from './gatherings';
import { parseAvatar3D, sampleLivingPose, worldAnchor } from './shared-living-3d';
import { collectHomeNavigationObstacles, homeNavigationBounds, homeAvatarNavigationClearance, type HomeNavigationObstacle } from './living-home-navigation';
import { createLivingNavigation, sampleLivingNavigation, advanceLivingNavigationPhase, allocateLivingNavigationAnchors, type LivingNavigationRoute, type LivingNavigation } from './living-navigation';
import { createLivingPedestrianTraffic, type LivingPedestrianActor } from './living-pedestrian-traffic';
import { createLivingWalkAnimation } from './living-walk-animation';
import { createPairedHomeCourtesyPlanner, validatePairedHomeCourtesy, type PairedCourtesyPlan } from './living-home-courtesy-plan';
import { createHomeJourneyController, HOME_JOURNEY_PORTALS, VILLA_JOURNEY_PORTALS, type JourneyPose, type JourneyTarget } from './living-home-journey';
import { homePresenceSnapshotKey, type HomePresenceSnapshot } from './living-home-presence';
import { createHomeDoorAutonomy } from './living-home-door-autonomy';
import { collectHomeJourneyObstacles, setHomeJourneyDoorOpenness, homeJourneyPortalClearance } from './living-home-journey-geometry';
import { buildAvatar } from './living-meshes';
import { updateCourtyardFigure } from './courtyard-figure';
import { homeFloorCovered, setHomeActorCutaway } from './living-home-cutaway';
import { setLivingSleepSupport, computeLivingBedPose } from './living-sleep-support';
import { buildRealisticHomeItem } from './living-home-realistic-details';
import { type RoomRestSeat } from './living-room-seats';
import { homeSofaSeats, homeSleepingBeds } from './living-home-layout';
import { homeWorldCamera, homeWorldPoint, type HomeWorldView } from './living-home-world';
import { applyHomeWorldArchitectureView, buildHomeWorldEnvironment, setHomeWorldDoorOpenness, type HomeWorldDoorId } from './living-home-world-meshes';
import { livingBubble, isLivingConversationCaptionValid, type LivingBubbleReceipts } from './living-world-bubbles';
import { createHomeLeisureController, type HomeLeisureActivity, type HomeLeisureSnapshot, type HomeLeisureResult, type HomeLeisureSeat } from './living-home-leisure';
import { collectHomeLeisureSeats, createHomeTeaCupBinding } from './living-home-leisure-scene';
import { createLivingContactCollision, mahjongContactLegPose } from './living-contact-collision';
import { sampleHomeLeisurePose } from './living-home-leisure-pose';
import { createHomeActivityEffects } from './living-home-activity-effects';
import { createHomeAudio } from './living-home-audio';
import { createHomeLocalSpeech, type HomeLocalSpeechSnapshot } from './living-home-local-speech';
import { createHomeClipSpeech } from './living-home-clip-speech';
import { createHomeMahjongCalls } from './living-home-mahjong-calls';
import { applyHomeMahjongFace, setHomeMahjongFaceExposed } from './living-home-mahjong-faces';
import { createHomeMahjongGame, type HomeMahjongGamePreset, type HomeMahjongGameSnapshot } from './living-home-mahjong-game';
import { createHomeMahjongGameView } from './living-home-mahjong-game-view';
import { createHomeTelevisionChannels } from './living-home-television-channels';
import { createHomeTelevisionPrograms } from './living-home-television-program';
import { sampleHomeAmbience } from './living-home-ambience';
import { buildForestEnvironment, buildForestItem } from './living-forest-world';
import { buildDesertEnvironment, buildDesertItem } from './living-desert-world';
import { naturalNavigationBounds, collectNaturalNavigationObstacles } from './living-natural-navigation';
import { naturalHousePlan, applyNaturalHouseView, setNaturalHouseDoorOpenness } from './living-natural-house';
import { naturalHouseAssignments } from './living-natural-occupancy';
import { collectNaturalLeisureSeats } from './living-natural-leisure-scene';
import type { HomeMaterialLibrary } from './living-home-materials';

type WorldRestSeat = ReturnType<typeof homeSofaSeats>[number] & { yaw?: number; approach?: {x:number;z:number}; support?: readonly string[] };
type WorldSleepingBed = ReturnType<typeof homeSleepingBeds>[number] & { approach?: {x:number;z:number}; support?: readonly string[] };
type Avatar = ReturnType<typeof buildAvatar> & { signature: string; label: HTMLSpanElement; nameLabel: HTMLButtonElement; bubble: HTMLSpanElement; bubbleText: HTMLSpanElement; ring: T.Mesh; baseScale: T.Vector3 };
export type CourtyardFootprint = { left: number; top: number; ndcX: number; ndcY: number };

/** Preserve the old card's horizontal centre and portrait foot, without changing saved coordinates. */
export function courtyardFootprint(g: Gathering, id: number, width: number, height: number, offset = { x: 0, z: 0 }): CourtyardFootprint | null {
  const position = companionPosition(g, id);
  if (!position || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const cardWidth = Math.min(width * .15, width <= 760 ? 90 : 96);
  const left = T.MathUtils.clamp(parseFloat(position.left) / 100 + cardWidth / width * .5 + (Number.isFinite(offset.x) ? offset.x : 0) * .0975, .1, .92);
  const top = T.MathUtils.clamp(parseFloat(position.top) / 100 + Math.max(0, cardWidth - 6) / height + (Number.isFinite(offset.z) ? offset.z : 0) * .105, .42, .9);
  return { left, top, ndcX: left * 2 - 1, ndcY: 1 - top * 2 };
}

/** Place the body support point on the illustrated cushion, not the feet on the floor. */
export function roomSeatRoot(seat: RoomRestSeat, camera: T.Camera, scale: T.Vector3, supportY: number) {
  const footprint = { left: seat.left, top: seat.top, ndcX: seat.left * 2 - 1, ndcY: 1 - seat.top * 2 };
  const point = courtyardGroundPoint(footprint, camera);
  return point && Number.isFinite(supportY) ? point.sub(new T.Vector3(0, supportY * scale.y, 0)) : null;
}

/** A fixed camera keeps a flat courtyard photograph and its screen anchors aligned. */
export function fitCourtyardCamera(camera: T.OrthographicCamera, width: number, height: number) {
  const w = Number.isFinite(width) && width > 0 ? width : 1, h = Number.isFinite(height) && height > 0 ? height : 1;
  camera.left = -4 * w / h; camera.right = 4 * w / h; camera.top = 4; camera.bottom = -4;
  camera.position.set(0, 8, 12); camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
}

export function courtyardGroundPoint(footprint: CourtyardFootprint, camera: T.Camera): T.Vector3 | null {
  if (![footprint.ndcX, footprint.ndcY].every(Number.isFinite)) return null;
  const ray = new T.Raycaster(); ray.setFromCamera(new T.Vector2(footprint.ndcX, footprint.ndcY), camera);
  const point = ray.ray.intersectPlane(new T.Plane(new T.Vector3(0, 1, 0), 0), new T.Vector3());
  return point && [point.x, point.y, point.z].every(Number.isFinite) ? point : null;
}
export function disposeLivingObject(root: T.Object3D): void;
export function disposeLivingObject(root: T.Object3D, retainedRoots: readonly T.Object3D[]): void;
export function disposeLivingObject(root: T.Object3D, retained: unknown = []) {
  const retainedRoots: T.Object3D[] = Array.isArray(retained) ? retained.filter(o => o instanceof T.Object3D) : [];
  const materialTextures = (material: T.Material): T.Texture[] => [
    ...Object.values(material),
    ...(Array.isArray(material.userData.homeOwnedTextures) ? material.userData.homeOwnedTextures : []),
  ].filter((value): value is T.Texture => value instanceof T.Texture);
  const keptGeometry = new Set<T.BufferGeometry>(), keptMaterial = new Set<T.Material>(), keptTexture = new Set<T.Texture>();
  for (const other of retainedRoots) other.traverse(o => { if (o instanceof T.Mesh) { keptGeometry.add(o.geometry); for (const m of Array.isArray(o.material) ? o.material : [o.material]) { keptMaterial.add(m); for (const value of materialTextures(m)) keptTexture.add(value); } } });
  const geometries = new Set<T.BufferGeometry>(), materials = new Set<T.Material>(), textures = new Set<T.Texture>();
  root.traverse(o => { if (o instanceof T.Mesh) { geometries.add(o.geometry); for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m); } });
  for (const value of materials) for (const entry of materialTextures(value)) textures.add(entry);
  textures.forEach(texture => { if (!keptTexture.has(texture)) texture.dispose(); }); geometries.forEach(g => { if (!keptGeometry.has(g)) g.dispose(); }); materials.forEach(m => { if (!keptMaterial.has(m)) m.dispose(); });
  root.removeFromParent();
}
function material(color: string, roughness = .82) { return new T.MeshStandardMaterial({ color, roughness, metalness: 0 }); }
function mesh(parent: T.Object3D, geometry: T.BufferGeometry, color: string, x: number, y: number, z: number) {
  const m = new T.Mesh(geometry, material(color)); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
}
function box(p: T.Object3D, color: string, x: number, y: number, z: number, w: number, h: number, d: number) { return mesh(p, new T.BoxGeometry(w, h, d), color, x, y, z); }
function sphere(p: T.Object3D, color: string, x: number, y: number, z: number, r: number) { return mesh(p, new T.SphereGeometry(r, 12, 10), color, x, y, z); }
function tree(p: T.Object3D, x: number, z: number, color: string, scale = 1) {
  const g = new T.Group(); p.add(g); g.position.set(x, 0, z); g.scale.setScalar(scale);
  const trunk=mesh(g, new T.CylinderGeometry(.11, .18, 1.35, 9), '#99735b', 0, .6, 0);trunk.name='saved-tree-trunk';trunk.userData.homeNavObstacle=true;
  sphere(g, color, 0, 1.55, 0, .67); sphere(g, color, -.38, 1.35, .1, .44); sphere(g, color, .36, 1.4, -.1, .45);
  g.traverse(o=>{if(o instanceof T.Mesh){o.updateWorldMatrix(true,false);const b=new T.Box3().setFromObject(o,true);if(b.min.y<1.6)o.userData.homeNavObstacle=true;}});
  return g;
}
function itemMesh(kind: string, season: string | null) {
  const g = new T.Group(), leaves = season === 'autumn' ? '#dbac5d' : season === 'winter' ? '#b6cfb6' : '#72a66f';
  if (kind === 'tree') tree(g, 0, 0, leaves, .85);
  else if (kind === 'bench') {
    for (const x of [-.48, .48]) { box(g, '#6d6654', x, .28, 0, .09, .56, .55); box(g, '#6d6654', x, .69, -.22, .07, .57, .07); }
    for (const z of [-.22, -.04, .14]) box(g, '#b99673', 0, .56, z, 1.18, .09, .14);
    for (const y of [.76, .96]) box(g, '#b99673', 0, y, -.26, 1.18, .12, .07);
  } else if (kind === 'shade') {
    mesh(g, new T.CylinderGeometry(.04, .05, 1.55, 8), '#aa8662', 0, .78, 0);
    mesh(g, new T.ConeGeometry(.9, .34, 8), '#e4bc7c', 0, 1.62, 0);
  } else if (kind === 'cushion') { const m = sphere(g, '#dcaeb0', 0, .12, 0, .45); m.scale.set(1, .3, .8); }
  else if (kind === 'flower') {
    for (let i = 0; i < 5; i++) { const x = Math.sin(i * 2.4) * .25, z = Math.cos(i * 2.4) * .25; mesh(g, new T.CylinderGeometry(.018, .023, .45, 5), '#77a277', x, .23, z); for (let k = 0; k < 5; k++) sphere(g, '#e7a4bb', x + Math.sin(k * 1.26) * .1, .48, z + Math.cos(k * 1.26) * .1, .085); sphere(g, '#f4d986', x, .51, z, .06); }
  } else if (kind === 'mushroom') {
    mesh(g, new T.CylinderGeometry(.12, .16, .45, 10), '#f0e4cc', 0, .24, 0); const cap = sphere(g, '#c8786e', 0, .51, 0, .34); cap.scale.y = .55;
  } else if (kind === 'pond') { const water = mesh(g, new T.CylinderGeometry(.8, .8, .06, 32), '#7dbfca', 0, .025, 0); water.scale.z = .65; }
  else if (kind === 'campfire') { for (let i = 0; i < 3; i++) { const log = mesh(g, new T.CylinderGeometry(.07, .07, .8, 8), '#9a7557', 0, .1, 0); log.rotation.set(Math.PI / 2, i * 2.09, 0); } mesh(g, new T.ConeGeometry(.25, .62, 7), '#edb76c', 0, .35, 0); }
  else if (kind === 'fireflies') { for (let i = 0; i < 6; i++) sphere(g, '#f7d889', Math.sin(i * 2) * .5, .4 + (i % 3) * .2, Math.cos(i * 2) * .5, .035); }
  g.name='saved-item-'+kind;
  if(['bench','cushion','flower','mushroom','pond','campfire'].includes(kind))g.userData.homeNavObstacle=true;
  if(kind==='shade')g.children[0].userData.homeNavObstacle=true;
  return g;
}
function environment(sceneType: string, season: string | null) {
  const g = new T.Group(), green = season === 'autumn' ? '#c4a15b' : season === 'winter' ? '#bdcbb2' : '#7aa178';
  mesh(g, new T.CylinderGeometry(6.6, 6.25, .32, 64), '#aec0a2', 0, -.24, 0);
  const ground = mesh(g, new T.CylinderGeometry(6.4, 6.4, .1, 64), sceneType === 'desert' ? '#e9cda0' : season === 'winter' ? '#e3e5d9' : '#c2c9aa', 0, -.055, 0); ground.receiveShadow = true;
  if (sceneType === 'home') {
    const paving = box(g, '#e4d6bc', 0, -.008, 0, 9.4, .03, 6.8); paving.receiveShadow = true;
    for (let x = -4; x <= 4; x += 1) for (let z = -3; z <= 3; z += 1) {
      const tile = box(g, (x + z) % 3 ? '#dfd0b8' : '#e8dbc6', x, .013, z, .96, .025, .96); tile.castShadow = false;
    }
    box(g, '#d5c0a1', -2.5, 1.0, -4.4, 3, 2.0, 1.8);
    const roof = mesh(g, new T.ConeGeometry(2.35, 1.15, 4), '#9e7b6c', -2.5, 2.52, -4.4); roof.rotation.y = Math.PI / 4;
    box(g, '#8b8e6e', -2.7, .8, -3.47, .7, 1.6, .09);
    box(g, '#abc9bd', -1.6, 1.25, -3.45, .55, .6, .11);
    box(g, '#f0dfb9', -1.6, 1.25, -3.36, .03, .61, .02); box(g, '#f0dfb9', -1.6, 1.25, -3.36, .57, .03, .02);
    for (let i = 0; i < 9; i++) box(g, i % 2 ? '#d8cbb0' : '#cbbb9f', 1 + i * .5, .28, -4.1, .46, .56, .27);
    tree(g, -5, -1.7, green, 1.3); tree(g, 4.8, -3.1, green, 1.1); tree(g, -4.7, 3.0, green, .75);
  } else if (sceneType === 'forest') {
    for (const [x, z, s] of [[-5, -2, 1.25], [-3, -4.1, 1.2], [0, -5, 1.3], [4, -3.6, 1.2], [5.5, 0, .9], [-5, 2.3, .8]]) tree(g, x, z, green, s);
    const tent = mesh(g, new T.ConeGeometry(1.3, 1.4, 4), '#cfaa86', -3.2, .67, -3); tent.rotation.y = Math.PI / 4; tent.scale.z = 1.25;
    box(g, '#826f5e', -3.2, .4, -1.9, .6, .8, .05);
  } else {
    for (const [x, z] of [[-4.5, -2.8], [4.5, -2]]) {
      const trunk = mesh(g, new T.CylinderGeometry(.1, .17, 2.0, 9), '#ae916a', x, .95, z); trunk.rotation.z = .08;
      for (let k = 0; k < 6; k++) { const leaf = sphere(g, '#94ac78', x + Math.cos(k) * .38, 2.0, z + Math.sin(k) * .38, .6); leaf.scale.set(1, .13, .3); leaf.rotation.y = -k; }
    }
    const pool = mesh(g, new T.CylinderGeometry(1, 1.05, .06, 32), '#8ec5c5', -3.5, .015, .6); pool.scale.z = .65;
    for (let i = 0; i < 4; i++) { const dune = sphere(g, '#e5c897', i * 2.4 - 4, .1, -4.6, 1.1); dune.scale.y = .22; }
  }
  return g;
}

export function createLivingWorld(host: HTMLElement, labelLayer: HTMLElement, initial: Gathering, select: (id: number) => void, onDoorChange?: (id: HomeWorldDoorId, open: boolean, source?: 'manual'|'companion') => void, options?: { strictLeisureContacts?: boolean; cartoonScene?: boolean; persistentWorld?: boolean; onLeisureRequest?: (request: LivingLeisureRequest) => void; realistic?: boolean; localLeisurePreview?: boolean; localRoomTransitions?: boolean; localCompanionDoors?: boolean; localReferenceVilla?: boolean; localNaturalWorld?:boolean;localNaturalLeisure?:boolean; localSpeechClips?:Readonly<Record<string,string>>; localQuietAudio?:boolean; localMahjongGame?:boolean; localMahjongRules?:'basic'|'sichuan'; localMahjongPreset?:HomeMahjongGamePreset; localMahjongRandom?:()=>number; onLocalMahjongChange?:(state:HomeMahjongGameSnapshot|null)=>void; onSpeechChange?:(state:HomeLocalSpeechSnapshot)=>void; localFloorStorage?:boolean;onFloorSaveChange?:(status:'saved'|'restored'|'unavailable'|'rejected')=>void; onFloorLifeChange?:(visits:{id:number;phase:string;floor:number;activity:VillaActivity}[])=>void; onFloorVisitChange?: (visit:{id:number;phase:string;floor:number}|null)=>void; onJourneyChange?: (presence:HomePresenceSnapshot|null)=>void; initialLeisure?: readonly {activity:HomeLeisureActivity;actorIds:number[]}[]; onLeisureChange?: (state:HomeLeisureSnapshot,focus?:HomeLeisureActivity,error?:string)=>void }) {
  const renderer=new T.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power',stencil:options?.cartoonScene===true&&initial.scene_type==='home'});
  const toon = options?.cartoonScene === true;
  let softHome = toon && initial.scene_type === 'home';
  const releases:(()=>void)[]=[()=>{renderer.dispose();renderer.forceContextLoss();}];let disposed=false;
  releases.push(() => { delete host.dataset.sceneStyle; });
  function cleanup(){if(disposed)return;disposed=true;renderer.setAnimationLoop(null);for(const release of releases.reverse()){try{release()}catch{ /* Release every independent resource. */ }}}
  try {
    renderer.setPixelRatio(softHome ? window.devicePixelRatio||1 : Math.min(window.devicePixelRatio||1,1.5));renderer.shadowMap.enabled=true;renderer.shadowMap.type=softHome?T.PCFShadowMap:T.PCFSoftShadowMap;
    renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=toon ? 1.05 : options?.realistic ? .96 : 1.15;
    host.appendChild(renderer.domElement);renderer.domElement.setAttribute('role','img');renderer.domElement.tabIndex=0;
    releases.push(()=>{renderer.domElement.remove();labelLayer.replaceChildren()});
    const previousTouch=host.style.touchAction;host.style.touchAction='none';renderer.domElement.style.touchAction='none';
    releases.push(()=>{host.style.touchAction=previousTouch;for(const k of ['presentation','camera','environmentMeshes','itemMeshes','meshCharacters','sceneRevision','courtyardScale','seatedCharacters','sleepingCharacters','focusView','houseView','mainDoorOpen','roomDoorOpen','courtyardGateOpen','texturePending','textureLoaded','textureFailed','materialMode','naturalWorld','naturalObstacleCount','naturalIndoor','naturalCapacityBlocked','navigationBlocked','navigationCorrected','navigationRevision','navigationYielding','leisurePreview','televisionOn','journeyActive','journeyWaiting','houseStyle','lifeAudioEnabled','lifeAudioArea','lifeAudioVoices','lifeSpeechStatus','lifeSpeechVoice','lifeSpeechPaused','lifeSpeechTime','lifeSpeechDuration','lifeSpeechError'])delete host.dataset[k]});
    const scene=new T.Scene();releases.push(()=>disposeLivingObject(scene));
    const camera=new T.PerspectiveCamera(36,1,.1,160);
    const controls=new OrbitControls(camera,renderer.domElement);controls.enablePan=false;controls.minDistance=6;controls.maxDistance=26;controls.minPolarAngle=.25;controls.maxPolarAngle=1.42;releases.push(()=>controls.dispose());
    controls.zoomToCursor=softHome;
    const touchMedia=window.matchMedia?.('(max-width: 600px), (pointer: coarse)');
    const applyTouchMode=()=>{
      const mobile=touchMedia?.matches===true;
      controls.touches.ONE=mobile?null:T.TOUCH.ROTATE;
      controls.touches.TWO=T.TOUCH.DOLLY_ROTATE;
      renderer.setPixelRatio(softHome&&!mobile ? window.devicePixelRatio||1 : Math.min(window.devicePixelRatio||1,mobile?1.25:1.5));
      host.style.touchAction=renderer.domElement.style.touchAction=mobile?'pan-y':'none';
      host.dataset.touchMode=mobile?'scroll-and-two-finger-view':'drag-view';
    };
    applyTouchMode();touchMedia?.addEventListener?.('change',applyTouchMode);
    // A normal wheel scroll on a compact page must reach the document. Pinch
    // zoom (ctrl+wheel) and OrbitControls' two-finger touch gesture still work.
    const scrollCompactPage=(event:WheelEvent)=>{if(touchMedia?.matches&&!event.ctrlKey)event.stopImmediatePropagation();};
    renderer.domElement.addEventListener('wheel',scrollCompactPage,{capture:true,passive:true});
    releases.push(()=>renderer.domElement.removeEventListener('wheel',scrollCompactPage,true));
    releases.push(()=>{touchMedia?.removeEventListener?.('change',applyTouchMode);delete host.dataset.touchMode;});
    const fillLight=new T.HemisphereLight(options?.realistic?'#e1efff':'#fff4d8',options?.realistic?'#766e5a':'#8b9d8f',options?.realistic ? .75 : 2.2);scene.add(fillLight);
    const light=new T.DirectionalLight(options?.realistic?'#fff3dc':'#fff1d4',options?.realistic?3.1:3.2);light.position.set(-4,9,6);light.castShadow=true;light.shadow.mapSize.set(1024,1024);light.shadow.camera.left=-9;light.shadow.camera.right=9;light.shadow.camera.top=9;light.shadow.camera.bottom=-9;light.shadow.normalBias=.04;scene.add(light);releases.push(()=>light.shadow.dispose());
    let gathering=initial,focused:number|null=null,motion=false,environmentKey='',itemKey='',cameraKey='';
    const frameClock=createLivingWorldFrameClock();let suppressOrbitDraw=false,drawing=false;
    let animatedEnvironmentNodes:T.Object3D[]=[];
    function updateControls(){suppressOrbitDraw=true;try{controls.update();}finally{suppressOrbitDraw=false;}}
    let replayAt:number|null=null,fitFactor=1,updating=false;
    let bubbleReceipts:LivingBubbleReceipts|undefined;
    let view:HomeWorldView='overview',decoration:T.Group|null=null,items:T.Group|null=null;
    let architectureOccluders:T.Mesh[]=[];
    const inPresentationScope=(g:Gathering)=>g.id.startsWith('synthetic-')||persistentLivingScope(g,options?.persistentWorld);
    const isPersistent=()=>persistentLivingScope(gathering,options?.persistentWorld);
    let upperFloorView=false;
    let socialPlan:SocialPlan=new Map(),socialPlanKey='',socialPlanPending=false,socialPlanOriginsKey='';
    const socialSightCache=new Map<string,{geometry:string;clear:boolean}>();
    const floorGoalCache=new Map<number,{key:string;point:{x:number;z:number}}>();
    let upperReturnCamera:{position:T.Vector3;target:T.Vector3;view:HomeWorldView;min:number;max:number;fov:number}|null=null;
    let houseView:'interior'|'exterior'=options?.localLeisurePreview||options?.realistic&&options?.localNaturalWorld&&options?.localRoomTransitions&&options?.localCompanionDoors&&inPresentationScope(initial)&&(initial.scene_type==='forest'||initial.scene_type==='desert')?'exterior':'interior';
    const doorIds:HomeWorldDoorId[]=['home-main-entry-door','home-room-connection-door','home-courtyard-gate'];
    const initiallyNaturalIndoor=!!options?.realistic&&!!options?.localNaturalWorld&&!!options?.localRoomTransitions&&!!options?.localCompanionDoors&&inPresentationScope(initial)&&(initial.scene_type==='forest'||initial.scene_type==='desert');
    const initiallyAutonomous=!!options?.realistic&&!!options?.localRoomTransitions&&!!options?.localCompanionDoors&&(!!options?.localLeisurePreview&&initial.scene_type==='home'||initiallyNaturalIndoor)&&inPresentationScope(initial);
    const doors:Record<HomeWorldDoorId,{open:boolean;progress:number}>={'home-main-entry-door':{open:!(options?.localLeisurePreview||initiallyNaturalIndoor),progress:options?.localLeisurePreview||initiallyNaturalIndoor?0:1},'home-room-connection-door':{open:!initiallyAutonomous,progress:initiallyAutonomous?0:1},'home-courtyard-gate':{open:true,progress:1}};
    let doorFrame=Date.now()/1000,leisureElapsed=0,leisureLast=Date.now()/1000,naturalPoseEpoch=leisureLast;
    const canPreviewLeisure=()=>!!options?.realistic&&!!options?.localLeisurePreview&&gathering.scene_type==='home'&&inPresentationScope(gathering);
    const canNaturalWorld=()=>!!options?.realistic&&!!options?.localNaturalWorld&&inPresentationScope(gathering)&&(gathering.scene_type==='forest'||gathering.scene_type==='desert');
    const navigationWorldPoint=(area:'indoor'|'bedroom'|'outdoor',point:{x:number;y:number;z:number})=>canNaturalWorld()?point:homeWorldPoint(area,point);
    const naturalIndoorFor=(g:Gathering)=>!!options?.realistic&&!!options?.localNaturalWorld&&!!options?.localRoomTransitions&&!!options?.localCompanionDoors&&inPresentationScope(g)&&(g.scene_type==='forest'||g.scene_type==='desert');
    const canNaturalIndoor=()=>naturalIndoorFor(gathering);
    const canNaturalLeisure=()=>canNaturalIndoor()&&!!options?.localLeisurePreview&&!!options?.localNaturalLeisure;
    const canLocalLeisure=()=>canPreviewLeisure()||canNaturalLeisure();
    const housePlan=()=>canNaturalIndoor()?naturalHousePlan(gathering.scene_type as 'forest'|'desert'):null;
    const journeyPortals=()=>canReferenceVilla()?VILLA_JOURNEY_PORTALS:housePlan()?.portals??HOME_JOURNEY_PORTALS;
    const areaFor=(c:Gathering['companions'][number])=>{if(!canNaturalIndoor())return canNaturalWorld()?'outdoor':gatheringCompanionArea(gathering,c);const slots=naturalHouseAssignments(gathering);return slots.seats.some(s=>s.characterId===c.id)?'indoor':slots.beds.some(s=>s.characterId===c.id)?'bedroom':'outdoor';};
    const boundsFor=(area:'indoor'|'bedroom'|'outdoor')=>housePlan()?.bounds[area]??(canNaturalWorld()?naturalNavigationBounds(gathering.scene_type as 'forest'|'desert'):homeNavigationBounds(area));
    const areaObstacles=(area:string,obstacles:readonly HomeNavigationObstacle[])=>{const plan=housePlan();if(!plan||area!=='outdoor')return [...obstacles];const a=plan.bounds.indoor,b=plan.bounds.bedroom;const swings=doorSweepBoxes('home-main-entry-door').map((box,index)=>({minX:box.min.x,maxX:box.max.x,minZ:box.min.z,maxZ:box.max.z,source:'natural-entry-door-swing-'+index}));return [...obstacles,...swings,{minX:Math.min(a.minX,b.minX),maxX:Math.max(a.maxX,b.maxX),minZ:Math.min(a.minZ,b.minZ),maxZ:Math.max(a.maxZ,b.maxZ),source:'natural-house-outdoor-boundary'}];};
    // Idle companions leave real approach and contact clearances free; participant paths still use physical geometry.
    const naturalLeisureClearways=(area:string):HomeNavigationObstacle[]=>canNaturalLeisure()&&area==='outdoor'?leisureSeatList.filter(s=>s.available!==false).map(s=>{const p=s.approach??s,laneHalfWidth=1.8;return{minX:Math.min(s.x,p.x)-laneHalfWidth,maxX:Math.max(s.x,p.x)+laneHalfWidth,minZ:Math.min(s.z,p.z)-laneHalfWidth,maxZ:Math.max(s.z,p.z)+laneHalfWidth,source:'natural-leisure-clearway-'+s.id};}):[];
    // Keep idle arrivals on the open strip in front of the house, away from the east-side approach corridor.
    const naturalFloorAnchor=(area:string,p:{x:number;y:number;z:number})=>canNaturalLeisure()&&area==='outdoor'?{...p,z:Math.min(p.z,-2.5)}:p;
    const canJourney=()=>(canPreviewLeisure()||canNaturalIndoor())&&!!options?.localRoomTransitions;
    const canCompanionDoors=()=>canJourney()&&!!options?.localCompanionDoors;
    const canReferenceVilla=()=>canPreviewLeisure()&&canJourney()&&!!options?.localReferenceVilla;
    const canQuietAudio=()=>canPreviewLeisure()&&!!options?.localQuietAudio;
    const canPlayMahjong=()=>canPreviewLeisure()&&!isPersistent()&&!!options?.localMahjongGame;
    const companionDoors=createHomeDoorAutonomy();releases.push(()=>companionDoors.reset());
    const doorSweepCache=new Map<HomeWorldDoorId,{leaf:T.Object3D;boxes:T.Box3[]}>();releases.push(()=>doorSweepCache.clear());
    let journeys=createHomeJourneyController(journeyPortals());const journeyArrivals=new Map<number,{x:number;z:number}>();
    const pairedCourtesyFailures=new Set<string>();
    const pairedCourtesyJobs=new Map<number,{key:string;attempt:string;iterator:ReturnType<typeof createPairedHomeCourtesyPlanner>;ready?:PairedCourtesyPlan;steps:number}>();
    type IdleYield={requester:number;requestKey:string;sourceKey:string;area:'indoor'|'bedroom'|'outdoor';target:{x:number;z:number};after?:number[]};
    const idleYields=new Map<number,IdleYield>(),idleYieldChecks=new Map<number,{stamp:string;at:number}>();let idleYieldElapsed=0;
    let presenceStamp='';
    function publishPresence(){
      if(!canJourney()){if(presenceStamp){presenceStamp='';options?.onJourneyChange?.(null);}return;}
      const presence:HomePresenceSnapshot={groupId:gathering.id,ownerId:gathering.me,actors:[...avatars].sort(([a],[b])=>a-b).flatMap(([id,a])=>{
        const area=a.root.userData.homePresenceArea??a.root.userData.homeRegion;if(!['outdoor','indoor','bedroom'].includes(area))return[];
        const journey=journeys.get(id),targetArea=a.root.userData.journeyTargetArea;
        return[{id,area,active:!!journey?.active,phase:journey?.active?(a.root.userData.homeJourney?.waitingForClearance?'blocked':journey.phase):'idle',targetArea:['outdoor','indoor','bedroom'].includes(targetArea)?targetArea:area}];
      })};
      const stamp=homePresenceSnapshotKey(presence);if(stamp!==presenceStamp){presenceStamp=stamp;options?.onJourneyChange?.(presence);}
    }
    releases.push(()=>{if(presenceStamp){presenceStamp='';options?.onJourneyChange?.(null);}});
    const pendingDoorClosures=new Set<HomeWorldDoorId>();
    const pendingDoorOpenings=new Map<HomeWorldDoorId,'manual'|'companion'>();
    releases.push(()=>{journeys.reset();journeyArrivals.clear();idleYields.clear();pairedCourtesyJobs.clear();pairedCourtesyFailures.clear();idleYieldChecks.clear();pendingDoorClosures.clear();pendingDoorOpenings.clear();});
    const leisure=createHomeLeisureController({scope:{groupId:initial.id,ownerId:initial.me,synthetic:initial.id.startsWith('synthetic-'),...(options?.persistentWorld?{persistent:persistentLivingScope(initial,true)}:{}),optIn:canLocalLeisure()},actors:[],seats:[]});
    const teaCups=createHomeTeaCupBinding(),lifeAudio=createHomeAudio(),lifeSpeech=canPreviewLeisure()&&options?.localSpeechClips?createHomeClipSpeech(options.localSpeechClips):createHomeLocalSpeech();const mahjongCalls=createHomeMahjongCalls();releases.push(()=>mahjongCalls.dispose());let speechStatusStamp='';let activityEffects:ReturnType<typeof createHomeActivityEffects>|null=null;releases.push(()=>{activityEffects?.dispose();lifeAudio.dispose();lifeSpeech.dispose();teaCups.restore();});
    const mahjongGame=createHomeMahjongGame(canPlayMahjong()?{preset:options?.localMahjongPreset,rules:options?.localMahjongRules,random:options?.localMahjongRandom}:{}),mahjongGameView=createHomeMahjongGameView(scene);let mahjongRevisionStamp='';
    let mahjongCaption:{actorId:number;text:string;until:number}|null=null;
    let sharedMahjong:PublicSharedMahjongSnapshot|null=null,sharedMahjongReceivedAt=0,sharedMahjongEventStamp='';
    releases.push(()=>{mahjongGameView.dispose();mahjongGame.dispose();for(const key of ['mahjongGameStatus','mahjongTurnActor','mahjongGameEvent','mahjongGameText','mahjongGamePhase'])delete host.dataset[key];});
    const televisionChannels=createHomeTelevisionChannels(),televisionPrograms=createHomeTelevisionPrograms();
    const televisionDataKeys=['televisionChannel','televisionProgram','televisionProgramFrame','televisionRemoteOwner','televisionRemotePressed'];
    const clearTelevisionData=()=>{for(const key of televisionDataKeys)delete host.dataset[key];};
    releases.push(()=>{televisionPrograms.dispose();televisionChannels.dispose();clearTelevisionData();});
    const audioPositions=new Map<number,{x:number;z:number}>();
    const silenceLifeAudio=()=>{lifeAudio.pause();lifeSpeech.pause();mahjongCalls.reset();mahjongCaption=null;audioPositions.clear();};
    const audioVisibility=()=>{silenceLifeAudio();if(canNaturalLeisure())leisureLast=Date.now()/1000;};document.addEventListener('visibilitychange',audioVisibility);releases.push(()=>document.removeEventListener('visibilitychange',audioVisibility));
    let leisureSeatList=collectHomeLeisureSeats(null,null,initial),leisureInputKey='',leisureSeeded=false,persistentLeisureStamp='';
    const contactSeatCache=new Map<string,boolean>();let contactSeatScope='';
    const clearMahjongContactSeat=(seat:HomeLeisureSeat,approach:{x:number;z:number})=>{
      const scope=environmentKey+'/'+itemKey+'/'+[...avatars.values()].map(a=>a.signature).join('|');
      if(scope!==contactSeatScope){contactSeatScope=scope;contactSeatCache.clear();}
      const key=seat.id+'/'+seat.x+'/'+seat.y+'/'+seat.z+'/'+seat.yaw+'/'+approach.x+'/'+approach.z;
      const known=contactSeatCache.get(key);if(known!==undefined)return known;
      const clear=avatars.size>0&&[...avatars.values()].every(a=>{
        const from:JourneyPose={...approach,y:0,yaw:seat.yaw,tilt:0,scale:1,area:seat.area,contact:null},
          to:JourneyPose={x:seat.x,y:seat.y-a.seatHeight*a.baseScale.y*.9,z:seat.z,yaw:seat.yaw,tilt:0,scale:.9,area:seat.area,contact:'rest'};
        return contactCollision.isClear(a,decoration,items,from,to,0,1,seat.support??[],true);
      });contactSeatCache.set(key,clear);return clear;
    };
    function refreshLeisure(validateMahjong=false){
      if(canLocalLeisure()&&!activityEffects)activityEffects=createHomeActivityEffects(scene);else if(!canLocalLeisure()&&activityEffects){activityEffects.dispose();activityEffects=null;lifeAudio.pause();televisionPrograms.reset();televisionChannels.reset();clearTelevisionData();}
      const before=leisure.getSnapshot(),needsMahjongContact=canLocalLeisure()&&(isPersistent()||options?.strictLeisureContacts===true)&&(validateMahjong||before.assignments.some(a=>a.activity==='mahjong')||gathering.companions.some(c=>c.leisure?.activity==='mahjong')||options?.initialLeisure?.some(a=>a.activity==='mahjong'));
      leisureSeatList=canNaturalLeisure()?collectNaturalLeisureSeats(decoration,items,gathering,before,Math.max(.9,...[...avatars.values()].map(a=>Number(a.root.userData.navigationClearance)||.9))):collectHomeLeisureSeats(decoration,items,gathering,before,Math.max(.9,...[...avatars.values()].map(a=>Number(a.root.userData.navigationClearance)||.9)),needsMahjongContact?clearMahjongContactSeat:undefined,isPersistent()||options?.strictLeisureContacts===true);
      const input={scope:{groupId:gathering.id,ownerId:gathering.me,synthetic:gathering.id.startsWith('synthetic-'),...(options?.persistentWorld?{persistent:isPersistent()}:{}),optIn:canLocalLeisure()},actors:gathering.companions.map(c=>({id:c.id,ownerId:c.owner_id,activity:c.activity,available:avatars.has(c.id)&&!floorBusy(c.id)&&(isPersistent()||c.owner_id===gathering.me)?undefined:false})),seats:leisureSeatList};
      const key=JSON.stringify(input);if(key!==leisureInputKey){leisureInputKey=key;const result=leisure.reconcile(input);if((canLocalLeisure()||before.permitted)&&((result.ok&&result.changed)||before.revision!==result.snapshot.revision))options?.onLeisureChange?.(result.snapshot);}
    }
    function syncPersistentLeisure(){
      if(!isPersistent()||!canLocalLeisure())return;
      const stamp=JSON.stringify([gathering.id,gathering.me,gathering.scene_type,gathering.companions.map(c=>[c.id,c.owner_id,c.activity,c.leisure??null]),leisureSeatList.map(s=>[s.id,s.physicalId,s.available,s.reservedByActorId])]);
      if(stamp===persistentLeisureStamp)return;
      const wanted=new Map(gathering.companions.filter(c=>c.leisure).map(c=>[c.id,c.leisure!]));
      for(const old of leisure.getSnapshot().assignments){const saved=wanted.get(old.actorId);if(!saved||saved.activity!==old.activity||saved.seat_id!==old.seatId)leisure.stop({actorId:old.actorId});}
      for(const [actorId,saved]of wanted){const seat=leisureSeatList.find(s=>s.id===saved.seat_id);if(seat?.station===saved.activity&&seat.available!==false)leisure.assign({activity:saved.activity,actorId,seatId:saved.seat_id,elapsed:leisureElapsed});}
      if([...wanted.values()].some(s=>s.activity==='television')&&!persistentLeisureStamp)leisure.setTelevisionPower(true);
      persistentLeisureStamp=stamp;options?.onLeisureChange?.(leisure.getSnapshot());
    }
    function requestPersistentLeisure(kind:HomeLeisureActivity|null,actorId?:number){
      if(disposed||!isPersistent()||!options?.onLeisureRequest)return false;
      refreshLeisure(kind==='mahjong');const candidate=kind===null?actorId:actorId??gathering.companions.find(c=>c.owner_id===gathering.me&&!floorBusy(c.id))?.id;
      if(kind!==null&&(candidate===undefined||floorBusy(candidate))){options?.onLeisureChange?.(leisure.getSnapshot(),undefined,'actor_busy');return false;}
      const request=planLivingLeisure(gathering,leisureSeatList,kind,candidate);
      if(!request){const forbidden=actorId!==undefined&&!gathering.companions.some(c=>c.id===actorId&&c.owner_id===gathering.me),blocked=kind!==null&&leisureSeatList.some(s=>s.station===kind)&&!leisureSeatList.some(s=>s.station===kind&&s.available!==false);options?.onLeisureChange?.(leisure.getSnapshot(),undefined,forbidden?'forbidden':blocked?'seat_blocked':'insufficient_seats');return false;}
      options.onLeisureRequest(request);return true;
    }
    function publishLeisure(result:HomeLeisureResult,kind?:HomeLeisureActivity){refreshLeisure();options?.onLeisureChange?.(leisure.getSnapshot(),result.ok?kind:undefined,result.ok?undefined:result.error);draw();return result.ok;}
    function floorBusy(id:number){const visit=villaVisit.snapshot(id);return !!visit&&visit.phase!=='returned';}
    function startLocalLeisure(kind:HomeLeisureActivity,actorId?:number){if(actorId!==undefined&&floorBusy(actorId)){options?.onLeisureChange?.(leisure.getSnapshot(),undefined,'actor_busy');return false;}if(isPersistent())return requestPersistentLeisure(kind,actorId);if(disposed||!canLocalLeisure()||canNaturalLeisure()&&!(['tea','bench'] as HomeLeisureActivity[]).includes(kind))return false;refreshLeisure(kind==='mahjong');return publishLeisure(actorId?leisure.assign({activity:kind,actorId,elapsed:leisureElapsed}):leisure.start(kind,{elapsed:leisureElapsed}),kind);}
    function stopLocalLeisure(actorId?:number){if(isPersistent())return requestPersistentLeisure(null,actorId);if(disposed||!canLocalLeisure())return false;const powered=leisure.getSnapshot().television.powered;const result=actorId?leisure.stop({actorId}):leisure.reset();if(!actorId)leisure.setTelevisionPower(powered);teaCups.restore();return publishLeisure(result);}
    function toggleLocalLeisure(kind:'television'|'mahjong'){
      if(disposed||!canPreviewLeisure())return false;refreshLeisure();
      if(isPersistent()&&kind==='mahjong'){const own=gathering.companions.find(c=>c.owner_id===gathering.me);return own?.leisure?.activity==='mahjong'?requestPersistentLeisure(null,own.id):requestPersistentLeisure('mahjong',own?.id);}
      return kind==='television'?publishLeisure(leisure.setTelevisionPower(!leisure.getSnapshot().television.powered)):
        leisure.getSnapshot().assignments.some(a=>a.activity==='mahjong')?publishLeisure(leisure.stop({activity:'mahjong'})):startLocalLeisure('mahjong');
    }
    async function setLifeAudio(enabled:boolean){if(disposed||!canPreviewLeisure())return false;if(!enabled){lifeAudio.setEnabled(false);lifeSpeech.off();audioPositions.clear();host.dataset.lifeAudioEnabled='false';draw();return false;}if(document.hidden)return false;const voiceOn=lifeSpeech.enable();if(canQuietAudio()){lifeAudio.setEnabled(false);host.dataset.lifeAudioEnabled=String(voiceOn);draw();return voiceOn;}const on=await lifeAudio.enable();if(!on)lifeSpeech.off();if(!disposed)host.dataset.lifeAudioEnabled=String(on);return on;}
    function canOperateDoor(id:HomeWorldDoorId){return (gathering.scene_type==='home'||canNaturalIndoor())&&(!canNaturalIndoor()||id!=='home-courtyard-gate')&&doorIds.includes(id)&&!(id==='home-room-connection-door'&&houseView==='exterior')}

    function doorSweepBoxes(id:HomeWorldDoorId){
      const leaf=decoration?.getObjectByName(id+'-leaf');if(!leaf)return [] as T.Box3[];
      let cached=doorSweepCache.get(id);
      if(cached?.leaf!==leaf){const old=leaf.rotation.y,boxes:T.Box3[]=[];
        const oldPosition=leaf.position.clone(),natural=canNaturalIndoor()&&id!=='home-courtyard-gate',progress=decoration?.getObjectByName(id)?.userData.homeDoorOpenness??0;
        try{for(let n=0;n<=18;n++){if(natural)setNaturalHouseDoorOpenness(decoration!,id,n/18);else leaf.rotation.y=-95*Math.PI/180*n/18;leaf.updateWorldMatrix(true,true);boxes.push(new T.Box3().setFromObject(leaf,true).expandByScalar(.04));}}
        finally{if(natural)setNaturalHouseDoorOpenness(decoration!,id,progress);else{leaf.rotation.y=old;leaf.position.copy(oldPosition);}leaf.updateWorldMatrix(true,true);}
        cached={leaf,boxes};doorSweepCache.set(id,cached);
      }
      return cached.boxes;
    }
    function journeyDoorOccupied(id:HomeWorldDoorId){
      if(journeys.occupiesDoor(id))return true;
      const boxes=doorSweepBoxes(id);
      return[...avatars.values()].some(a=>a.root.visible&&boxes.some(b=>{const radius=a.root.userData.navigationClearance as number;return a.root.position.x+radius>b.min.x&&a.root.position.x-radius<b.max.x&&a.root.position.z+radius>b.min.z&&a.root.position.z-radius<b.max.z;}));
    }

    function setDoorOpen(id:HomeWorldDoorId,open:boolean,source:'manual'|'companion'='manual',redraw=true){
      const allowed=source==='companion'?canCompanionDoors()&&(id==='home-main-entry-door'||id==='home-room-connection-door'):canOperateDoor(id);
      if(disposed||!allowed||typeof open!=='boolean')return;
      if(open)pendingDoorClosures.delete(id);else pendingDoorOpenings.delete(id);if(doors[id].open===open)return;
      if(source==='manual'&&(id==='home-main-entry-door'||id==='home-room-connection-door'))companionDoors.manual(id);
      if(open&&canNaturalIndoor()&&journeyDoorOccupied(id)){pendingDoorOpenings.set(id,source);return;}
      pendingDoorOpenings.delete(id);
      if(!open&&canJourney()&&journeyDoorOccupied(id)){pendingDoorClosures.add(id);return;}
      pendingDoorClosures.delete(id);doors[id].open=open;const doorAudible=houseView==='exterior'||view==='outdoor'?id!=='home-room-connection-door':view==='bedroom'?id==='home-room-connection-door':view==='indoor'?id!=='home-courtyard-gate':true;if(canPreviewLeisure()&&!canQuietAudio()&&motion&&!document.hidden&&doorAudible)lifeAudio.triggerDoor(id,open);else lifeAudio.syncDoorState(id,open);invalidateNavigation();doorFrame=Date.now()/1000;if(canCompanionDoors())onDoorChange?.(id,open,source);else onDoorChange?.(id,open);if(redraw)draw();
    }
    function updateCompanionDoors(){
      if(!canCompanionDoors()){companionDoors.reset();return;}
      const ids=['home-main-entry-door','home-room-connection-door'] as const;
      const requests=gathering.companions.flatMap(c=>{
        const frame=journeys.get(c.id),avatar=avatars.get(c.id);if(!frame?.active||!avatar)return[];
        const target=avatar.root.userData.journeyTargetArea,requested=new Set<typeof ids[number]>(),door=frame.waitingFor??avatar.root.userData.journeyPortal;
        if(ids.includes(door))requested.add(door);
        const approaching=[{portal:journeyPortals().main,needed:(frame.pose.area==='outdoor')!==(target==='outdoor')},{portal:journeyPortals().bedroom,needed:(frame.pose.area==='bedroom')!==(target==='bedroom')}];
        for(const {portal,needed}of approaching)if(needed&&Math.min(Math.hypot(frame.pose.x-portal.before.x,frame.pose.z-portal.before.z),Math.hypot(frame.pose.x-portal.after.x,frame.pose.z-portal.after.z))<=4.5)requested.add(portal.door);
        return[...requested];
      });
      const closeRequests=benchEgress.size&&[...benchEgress].some(([id,exit])=>{const a=avatars.get(id);return a?.root.userData.homeRegion==='outdoor'&&Math.hypot(a.root.position.x-exit.point.x,a.root.position.z-exit.point.z)<.01;})?['home-main-entry-door' as const]:[];
      const commands=companionDoors.step({enabled:true,moving:motion&&!document.hidden,delta:navigationDelta,requests,closeRequests,doors:ids.map(id=>({id,open:doors[id].open,blocked:journeyDoorOccupied(id)}))});
      for(const command of commands)setDoorOpen(command.door,command.open,'companion',false);
    }
    function toggleDoor(id:HomeWorldDoorId){if(canOperateDoor(id))setDoorOpen(id,!doors[id].open)}
    function drawDoors(now:number){
      const delta=document.hidden?0:Math.min(.08,Math.max(0,now-doorFrame));doorFrame=now;
      if((gathering.scene_type!=='home'&&!canNaturalIndoor())||!decoration)return;
      for(const id of doorIds){const door=doors[id],target=door.open?1:0;door.progress=motion?T.MathUtils.clamp(door.progress+Math.sign(target-door.progress)*Math.min(Math.abs(target-door.progress),delta*2.5),0,1):canCompanionDoors()?door.progress:target;if(canNaturalIndoor()&&id!=='home-courtyard-gate')setNaturalHouseDoorOpenness(decoration,id,T.MathUtils.smoothstep(door.progress,0,1));else if(canJourney())setHomeJourneyDoorOpenness(decoration,id,T.MathUtils.smoothstep(door.progress,0,1));else setHomeWorldDoorOpenness(decoration,id,T.MathUtils.smoothstep(door.progress,0,1));}
      host.dataset.mainDoorOpen=String(doors['home-main-entry-door'].open);host.dataset.roomDoorOpen=String(doors['home-room-connection-door'].open);host.dataset.courtyardGateOpen=String(doors['home-courtyard-gate'].open);
    }
    let selectionMenu:HTMLElement|null=null,menuCharacter:number|null=null,selectionMenuPlacement:'anchor'|'panel'='anchor';
    const villaVisit=createVillaFloorLife();let floorVisitStamp='',floorStorageChecked=false,floorStorageStamp='',floorStorageAt=0;let floorDriver=false,serverFloorApplied=0;
    const onVillaStair=(id:number)=>{const s=villaVisit.snapshot(id);return !!s&&s.phase!=='approach'&&s.phase!=='returned'&&!(s.phase==='queued'&&s.direction==='up'&&s.distance===0);};
    const avatars=new Map<number,Avatar>();releases.push(()=>avatars.clear());
    type NavState={key:string;revision:number;region:string;route:LivingNavigationRoute;elapsed:number;lastNow:number;position:{x:number;z:number}|null;waited?:number;replans?:number};
    const navStates=new Map<number,NavState>(),navGraphs=new Map<string,LivingNavigation>();
    const pedestrianTraffic=createLivingPedestrianTraffic(),walkAnimation=createLivingWalkAnimation();let navigationLastNow=Date.now()/1000,navigationDelta=0;
    releases.push(()=>{pedestrianTraffic.reset();walkAnimation.reset();});
    let navRevision=0,navDirty=true,navObstacles:HomeNavigationObstacle[]=[];
    const navNotice=document.createElement('p');navNotice.className='living3d-navigation-notice';navNotice.setAttribute('role','status');navNotice.hidden=true;
    Object.assign(navNotice.style,{position:'absolute',left:'12px',right:'12px',bottom:'64px',padding:'8px 12px',background:'#fff7e8',borderRadius:'12px',fontSize:'14px',pointerEvents:'none',zIndex:'2'});
    host.appendChild(navNotice);releases.push(()=>{navNotice.remove();navStates.clear();navGraphs.clear()});
    function invalidateNavigation(){navDirty=true;navRevision++;navGraphs.clear();}
    function refreshNavigation(){if(!navDirty)return;navObstacles=canNaturalWorld()?collectNaturalNavigationObstacles(decoration,items):collectHomeNavigationObstacles(decoration,items,doorIds);navDirty=false;}
    function navigationGraph(area:'indoor'|'bedroom'|'outdoor',radius:number){
      const graphKey=area+'/'+radius;let graph=navGraphs.get(graphKey);
      if(!graph){graph=createLivingNavigation({bounds:boundsFor(area),blocked:[...areaObstacles(area,navObstacles),...naturalLeisureClearways(area)],clearance:radius});navGraphs.set(graphKey,graph);}return graph;
    }

    let journeyGeometryKey='',journeyObstacles:HomeNavigationObstacle[]=[];
    const journeyGraphs=new Map<string,LivingNavigation>();
    function journeyBounds(area:'indoor'|'bedroom'|'outdoor'){
      const bounds=boundsFor(area),physical=decoration?.getObjectByName('home-courtyard-enclosure')?.userData.bounds;
      // Roaming uses an inset region. A purposeful journey may use the real
      // courtyard strip beside the facade; all wall/furniture solids and the
      // full body radius still constrain every segment.
      return gathering.scene_type==='home'&&area==='outdoor'&&!housePlan()&&Number.isFinite(physical?.minZ)
        ?{...bounds,minZ:Math.min(bounds.minZ,physical.minZ)}:bounds;
    }
    function refreshJourneyGeometry(){
      const key=navRevision+'/'+doorIds.map(id=>doors[id].progress.toFixed(3)).join('/');
      if(key!==journeyGeometryKey){journeyGeometryKey=key;journeyObstacles=canNaturalIndoor()?collectNaturalNavigationObstacles(decoration,items):collectHomeJourneyObstacles(decoration,items);journeyGraphs.clear();}
    }
    function journeyGraph(area:'indoor'|'bedroom'|'outdoor',radius:number){
      const key=area+'/'+radius;let graph=journeyGraphs.get(key);
      if(!graph){graph=createLivingNavigation({bounds:journeyBounds(area),blocked:areaObstacles(area,journeyObstacles),clearance:radius,step:.16});journeyGraphs.set(key,graph);}return graph;
    }
    function socialEyeLineClear(leftId:number,rightId:number,leftPoint?:{x:number;z:number},rightPoint?:{x:number;z:number}){
      const a=avatars.get(leftId),b=avatars.get(rightId);if(!a||!b)return false;
      const left=leftPoint??a.root.position,right=rightPoint??b.root.position;
      const pair=[leftId,rightId].sort((a,b)=>a-b).join(','),geometry=environmentKey+'/'+itemKey+'/'+navRevision+'/'+doorIds.map(id=>doors[id].progress.toFixed(3)).join('/')+'/'+[leftId,left.x,left.z,rightId,right.x,right.z].join('/');
      const cached=socialSightCache.get(pair);if(cached?.geometry===geometry)return cached.clear;
      // Actual eyes after facing each other, tested against rendered static
      // geometry. A low stool is not a wall; closed high doors still are.
      const eye=(avatar:Avatar,point:{x:number;z:number},other:{x:number;z:number})=>{avatar.root.updateWorldMatrix(true,true);const p=avatar.eyes.getWorldPosition(new T.Vector3()),offset=p.sub(avatar.root.position),yaw=Math.atan2(other.x-point.x,other.z-point.z);return offset.applyAxisAngle(new T.Vector3(0,1,0),yaw-avatar.root.rotation.y).add(new T.Vector3(point.x,avatar.root.position.y,point.z));};
      const from=eye(a,left,right),to=eye(b,right,left),length=from.distanceTo(to);if(!Number.isFinite(length)||length<.1)return false;
      const ray=new T.Raycaster(from,to.clone().sub(from).normalize(),.01,length-.01),roots=[decoration,items].filter((root):root is T.Group=>!!root);roots.forEach(root=>root.updateWorldMatrix(true,true));
      const clear=ray.intersectObjects(roots,true).length===0;socialSightCache.set(pair,{geometry,clear});return clear;
    }
    function idleYieldGraph(area:'indoor'|'bedroom'|'outdoor',radius:number,support:readonly string[]=[]){
      const key='idle-yield/'+area+'/'+radius+'/'+support.join(',');let graph=journeyGraphs.get(key);
      if(!graph){graph=createLivingNavigation({bounds:journeyBounds(area),blocked:areaObstacles(area,journeyObstacles).filter(o=>!support.includes(o.source)),clearance:radius,step:.08});journeyGraphs.set(key,graph);}return graph;
    }
    function journeyPortalGraph(id:number,door:HomeWorldDoorId,from:{x:number;z:number},to:{x:number;z:number},turn=false){
      const avatar=avatars.get(id)!;const c=avatar.root.userData.journeyPortalClearance as {x:number;z:number;height:number};
      const yaw=Math.atan2(to.x-from.x,to.z-from.z),cs=Math.abs(Math.cos(yaw)),sn=Math.abs(Math.sin(yaw));
      const clearance=turn?Math.hypot(c.x,c.z):{x:c.x*cs+c.z*sn,z:c.x*sn+c.z*cs};
      const key='portal/'+door+'/'+(typeof clearance==='number'?clearance:clearance.x+'/'+clearance.z);let graph=journeyGraphs.get(key);
      if(!graph){graph=createLivingNavigation({bounds:housePlan()?.worldBounds??{minX:-11.3,maxX:11.3,minZ:-8.3,maxZ:8.3},blocked:journeyObstacles,clearance,step:.16});journeyGraphs.set(key,graph);}return graph;
    }
    const contactCollision=createLivingContactCollision(),bedContactOffsets=new Map<number,{key:string;offset:number;legLift:number}>(),bedSideApproaches=new Map<number,{key:string;point:{x:number;z:number}}>();
    const benchApproaches=new Map<string,{x:number;z:number}>(),benchEgress=new Map<number,{seatKey:string;point:{x:number;z:number}}>();
    const benchReturns=new Map<number,{key:string;point:{x:number;z:number}}>();
    releases.push(()=>{benchApproaches.clear();benchEgress.clear();benchReturns.clear();});
    function benchApproach(seat:{x:number;z:number;yaw:number},radius:number){
      const key=environmentKey+'/'+itemKey+'/'+seat.x+'/'+seat.z+'/'+seat.yaw+'/'+radius;
      const cached=benchApproaches.get(key);if(cached)return cached;
      // Validate the complete contact line, not just its free floor endpoint.
      // Only this physical bench is a support; every neighbouring solid stays.
      const supports=journeyObstacles.filter(o=>/bench/i.test(o.source)&&seat.x>=o.minX&&seat.x<=o.maxX&&seat.z>=o.minZ&&seat.z<=o.maxZ);
      const contact=createLivingNavigation({bounds:boundsFor('outdoor'),blocked:journeyObstacles.filter(o=>!supports.includes(o)),clearance:radius*.9,step:.16});
      const standing=journeyGraph('outdoor',radius),forward={x:Math.sin(seat.yaw),z:Math.cos(seat.yaw)},side={x:forward.z,z:-forward.x};
      const candidates=[{x:seat.x+forward.x*1.65,z:seat.z+forward.z*1.65}];
      for(const distance of [1.2,1.4,1.6,1.8,2])for(const lateral of [-1,1])for(const front of [0,.2,.4,.6])candidates.push({x:seat.x+side.x*distance*lateral+forward.x*front,z:seat.z+side.z*distance*lateral+forward.z*front});
      const point=candidates.find(p=>standing.isSegmentClear(p,p)&&contact.isSegmentClear(p,seat));
      if(point){benchApproaches.set(key,point);if(benchApproaches.size>64)benchApproaches.delete(benchApproaches.keys().next().value!);}return point;
    }
    function actualJourneyPose(a:Avatar):JourneyPose{
      const previous=journeys.get(a.root.userData.characterId);
      return{x:a.root.position.x,y:a.root.position.y-(a.root.userData.visualGroundLift??0),z:a.root.position.z,yaw:a.root.rotation.y,tilt:a.root.rotation.x,scale:a.root.scale.x/a.baseScale.x,area:a.root.userData.homeRegion??previous?.pose.area??'outdoor',contact:previous?.active?previous.pose.contact:a.root.userData.sleepingBed?'sleep':a.root.userData.roomRestSeat?'rest':null,...(previous?.active&&previous.pose.bedSeat!==undefined?{bedSeat:previous.pose.bedSeat}:{}),...(previous?.active&&previous.pose.bedBreathing!==undefined?{bedBreathing:previous.pose.bedBreathing}:a.root.userData.sleepingBed?{bedBreathing:a.body.scale.z}:{}),...(previous?.active&&previous.pose.bedLegLift!==undefined?{bedLegLift:previous.pose.bedLegLift}:a.root.userData.sleepingBed?{bedLegLift:Number(a.root.userData.sleepLegLift??0)}:{})};
    }
    const idleYieldSource=(c:Gathering['companions'][number])=>JSON.stringify([c.activity,c.x,c.y,c.area??null]);
    const distanceToPath=(p:{x:number;z:number},path:readonly {x:number;z:number}[])=>{
      let result=Infinity;for(let index=1;index<path.length;index++){const a=path[index-1],b=path[index],dx=b.x-a.x,dz=b.z-a.z,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/Math.max(1e-12,dx*dx+dz*dz)));result=Math.min(result,Math.hypot(p.x-a.x-dx*t,p.z-a.z-dz*t));}return result;
    };
    const canHoldCourtesy=(c:Gathering['companions'][number])=>['observe','arriving','walk'].includes(c.activity)||c.activity==='talk'&&!socialPlan.has(c.id);
    function prepareIdleYields(delta:number,seated:Map<number,WorldRestSeat>,sleeping:Map<number,WorldSleepingBed>,localSeats:Map<number,{x:number;y:number;z:number;area:'indoor'|'bedroom'|'outdoor';station?:string;support?:readonly string[]}>){
      for(const [id,held]of idleYields){
        const c=gathering.companions.find(c=>c.id===id),a=avatars.get(id),benchCourtesy=held.requester!==0&&localSeats.get(id)?.station==='bench';if(!c||!a||!canHoldCourtesy(c)||idleYieldSource(c)!==held.sourceKey||seated.has(id)||sleeping.has(id)||localSeats.has(id)&&!benchCourtesy){idleYields.delete(id);if(a)delete a.root.userData.homeIdleYield;continue;}
        const requested=gathering.companions.some(c=>c.id===held.requester)&&(localSeats.has(held.requester)||seated.has(held.requester)||sleeping.has(held.requester)||villaVisit.snapshot(held.requester)?.phase==='approach');
        const cancelled=!requested||journeys.diagnostics(held.requester)?.target.key!==held.requestKey;
        const completed=!cancelled&&!journeys.get(held.requester)?.active;
        if(held.requester&&(cancelled||completed)){
          if(benchCourtesy){idleYields.delete(id);delete a.root.userData.homeIdleYield;continue;}
          // Release only the request lease; the observer keeps its actual floor
          // position. A later request may ask it to yield again without a reset.
          idleYieldChecks.delete(held.requester);
          if(c.activity==='walk'){idleYields.delete(id);floorGoalCache.delete(id);delete a.root.userData.homeIdleYield;continue;}
          held.target={x:a.root.position.x,z:a.root.position.z};held.requester=0;held.requestKey=cancelled?'cancelled':'completed';a.root.userData.homeIdleYield={...held};
        }
      }
      if(!delta||!canCompanionDoors())return;
      idleYieldElapsed+=delta;
      for(const requester of [...gathering.companions].sort((a,b)=>a.id-b.id)){
        const frame=journeys.get(requester.id),details=journeys.diagnostics(requester.id),avatar=avatars.get(requester.id);
        if(!frame?.active){idleYieldChecks.delete(requester.id);pairedCourtesyJobs.delete(requester.id);}
        const currentStage=details?.stages[details.stage],waitingAtBay=currentStage?.kind==='walk'&&!!currentStage.yielding&&Math.hypot(frame!.pose.x-currentStage.goal.x,frame!.pose.z-currentStage.goal.z)<1e-6;
        if(!avatar||!frame?.active||!details||details.waited<.9&&!waitingAtBay||!/^seat\/|^bed\/|^villa-stair-boarding$/.test(details.target.key)||[...idleYields].some(([id,held])=>held.requester===requester.id&&journeys.get(id)?.active))continue;
        const stage=details.stages[details.stage];if(stage?.kind!=='walk')continue;
        const area=stage.area,requestRadius=avatar.root.userData.navigationClearance as number;
        const resume=stage.yielding?details.stages.slice(details.stage+1).find(next=>next.kind==='walk'):stage;
        const requestedGoal=resume?.kind==='walk'?resume.goal:stage.goal;
        const path=[{x:frame.pose.x,z:frame.pose.z},...(!stage.yielding?details.route?.slice(details.waypoint)??[]:[]),requestedGoal];
        const bodyStamp=[...avatars].filter(([id,a])=>id!==requester.id&&Math.abs(a.root.position.y-avatar.root.position.y)<2.3&&a.root.userData.homeRegion===area).map(([id,a])=>id+':'+a.root.position.x.toFixed(2)+':'+a.root.position.z.toFixed(2)).join('|'),check=details.target.key+'/'+navRevision+'/'+bodyStamp,previous=idleYieldChecks.get(requester.id);
        if(!pairedCourtesyJobs.has(requester.id)&&previous&&(previous.stamp===check||idleYieldElapsed-previous.at<1))continue;if(!pairedCourtesyJobs.has(requester.id))idleYieldChecks.set(requester.id,{stamp:check,at:idleYieldElapsed});
        // A blocked walking leg may legitimately reroute around the new bay.
        // Doorways and the final approach remain reserved; every candidate must
        // also leave a complete real route for the requester below.
        const futurePaths:Array<Array<{x:number;z:number}>>=[];
        for(const next of details.stages.slice(details.stage))if(next.kind==='portal'&&(next.fromArea===area||next.toArea===area))futurePaths.push(next.points.slice(next.leg));
        if(details.target.pose.area===area)futurePaths.push([details.target.approach,details.target.pose]);
        const keepFree:Array<{position:{x:number;z:number};radius:number}>=[];
        for(const future of futurePaths)for(let index=1;index<future.length;index++){const from=future[index-1],to=future[index],count=Math.max(1,Math.ceil(Math.hypot(to.x-from.x,to.z-from.z)/.3));for(let n=0;n<=count;n++)keepFree.push({position:{x:from.x+(to.x-from.x)*n/count,z:from.z+(to.z-from.z)*n/count},radius:requestRadius+.15});}
        const blockers=gathering.companions.filter(c=>c.id!==requester.id&&['observe','arriving'].includes(c.activity)&&!seated.has(c.id)&&!sleeping.has(c.id)&&!localSeats.has(c.id)&&(!idleYields.has(c.id)||idleYields.get(c.id)!.requester===0)&&!journeys.get(c.id)?.active&&avatars.get(c.id)?.root.userData.homeRegion===area)
          .filter(c=>{const a=avatars.get(c.id)!;return distanceToPath(a.root.position,path)<requestRadius+Number(a.root.userData.navigationClearance)+.1;}).sort((a,b)=>a.id-b.id);
        for(const c of pairedCourtesyJobs.has(requester.id)?[]:blockers){
          const a=avatars.get(c.id)!,radius=a.root.userData.navigationClearance as number,from={x:a.root.position.x,z:a.root.position.z},graph=idleYieldGraph(area,radius);
          const avoid=[...avatars].filter(([id,peer])=>id!==c.id&&Math.abs(peer.root.position.y-a.root.position.y)<2.3).map(([,a])=>({position:{x:a.root.position.x,z:a.root.position.z},radius:Number(a.root.userData.navigationClearance)}));
          const candidates=new Map<string,{x:number;z:number}>();
          const free=(to:{x:number;z:number})=>Math.hypot(to.x-from.x,to.z-from.z)>=radius*.5&&graph.isSegmentClear(to,to)&&[...avoid,...keepFree].every(peer=>Math.hypot(to.x-peer.position.x,to.z-peer.position.z)>=radius+peer.radius+.04)&&futurePaths.every(future=>distanceToPath(to,future)>=radius+requestRadius+.1);
          for(const distance of [1.4,2.2,3.2,4.5])for(let direction=0;direction<12;direction++){const angle=direction*Math.PI/6,to=graph.findSafePoint({x:from.x+Math.sin(angle)*distance,z:from.z+Math.cos(angle)*distance},[...avoid,...keepFree]);if(to&&free(to))candidates.set(to.x+'/'+to.z,to);}
          // Fine boundary samples retain every original radius and obstacle.
          // They find real side bays missed by a coarse circular sample.
          const bounds=boundsFor(area);for(let x=bounds.minX+radius+.001;x<bounds.maxX-radius;x+=.08)for(let z=bounds.minZ+radius+.001;z<bounds.maxZ-radius;z+=.08){const to={x,z};if(Math.hypot(x-from.x,z-from.z)<=4.8&&free(to))candidates.set(x+'/'+z,to);}
          let best:LivingNavigationRoute|null=null;
          for(const to of [...candidates.values()].sort((a,b)=>distanceToPath(b,path)-distanceToPath(a,path)||Math.hypot(a.x-from.x,a.z-from.z)-Math.hypot(b.x-from.x,b.z-from.z))){
            const route=graph.planTo({from,to,id:'idle-yield/'+c.id,avoid});if(route.blocked||route.length<radius*.5||!route.safeAnchor||Math.hypot(route.safeAnchor.x-from.x,route.safeAnchor.z-from.z)>=1e-6)continue;
            const requestAvoid=[...avatars].filter(([id,peer])=>id!==requester.id&&id!==c.id&&Math.abs(peer.root.position.y-avatar.root.position.y)<2.3).map(([,a])=>({position:{x:a.root.position.x,z:a.root.position.z},radius:Number(a.root.userData.navigationClearance)}));requestAvoid.push({position:to,radius});
            const onward=idleYieldGraph(area,requestRadius).planTo({from:frame.pose,to:requestedGoal,id:'idle-yield/requester/'+requester.id,avoid:requestAvoid});
            if(!onward.blocked&&onward.safeAnchor&&Math.hypot(onward.safeAnchor.x-frame.pose.x,onward.safeAnchor.z-frame.pose.z)<1e-6){best=route;break;}
          }
          a.root.userData.homeIdleYieldAttempt={requester:requester.id,from,candidates:candidates.size,route:best?.points??null};
          const target=best?.points.at(-1);if(!target)continue;
          journeys.releaseYieldFor(requester.id,c.id);
          const held:IdleYield={requester:requester.id,requestKey:details.target.key,sourceKey:idleYieldSource(c),area,target};idleYields.set(c.id,held);a.root.userData.homeIdleYield={...held,from};break;
        }
        // Two floor bodies can seal each other's only escape. Prove both
        // sequential routes plus the requester's onward route before moving either.
        // Keep the existing tea recovery and use the same planner at the stair bay.
        const tea=localSeats.get(requester.id),teaRequester=tea&&'activity'in tea&&tea.activity==='tea'&&area==='outdoor';
        const stairRequester=area==='outdoor'&&details.target.key==='villa-stair-boarding';
        if((teaRequester||stairRequester)&&waitingAtBay&&![...idleYields.values()].some(held=>held.requester===requester.id)){
          const bodies=[...avatars].filter(([id,a])=>id!==requester.id&&Math.abs(a.root.position.y-avatar.root.position.y)<2.3).map(([id,a])=>({id,position:{x:a.root.position.x,z:a.root.position.z},radius:Number(a.root.userData.navigationClearance)}));
          const eligibleIds=gathering.companions.filter(c=>c.id!==requester.id&&canHoldCourtesy(c)&&!floorBusy(c.id)&&!seated.has(c.id)&&!sleeping.has(c.id)&&(!localSeats.has(c.id)||localSeats.get(c.id)?.station==='bench')&&!journeys.get(c.id)?.active&&(!idleYields.has(c.id)||idleYields.get(c.id)!.requester===0)&&avatars.get(c.id)?.root.userData.homeRegion===area).map(c=>c.id);
          const input={requester:{id:requester.id,position:{x:frame.pose.x,z:frame.pose.z},radius:requestRadius},goal:requestedGoal,bodies,eligibleIds,keepFree,graph:(id:number)=>{const local=localSeats.get(id),support=local?.station==='bench'?local.support??[]:[];return idleYieldGraph(area,Number(avatars.get(id)!.root.userData.navigationClearance),support);}};
          const jobKey=JSON.stringify([journeyGeometryKey,details.target.key,gathering.companions.map(c=>[c.id,c.activity,c.leisure??null]),eligibleIds]);
          const attempt=jobKey+'/'+JSON.stringify([input.requester,...bodies].map(body=>[body.id,Math.round(body.position.x*10),Math.round(body.position.z*10),body.radius]));
          let job=pairedCourtesyJobs.get(requester.id);
          if(!job||job.key!==jobKey){
            pairedCourtesyJobs.delete(requester.id);
            if(eligibleIds.length<2||pairedCourtesyFailures.has(attempt))continue;
            job={key:jobKey,attempt,iterator:createPairedHomeCourtesyPlanner(input),steps:0};pairedCourtesyJobs.set(requester.id,job);
          }
          let plan=job.ready??null;
          if(!plan){
            const start=performance.now();
            // The count limit remains effective with a frozen/test clock.
            for(let count=0;count<12&&performance.now()-start<4;count++){
              const part=job.iterator.next();job.steps++;
              if(part.done||job.steps>=8000){
                plan=part.done?part.value:null;pairedCourtesyJobs.delete(requester.id);
                if(!plan){pairedCourtesyFailures.add(job.attempt);pairedCourtesyFailures.add(attempt);while(pairedCourtesyFailures.size>32)pairedCourtesyFailures.delete(pairedCourtesyFailures.values().next().value!);}
                break;
              }
            }
            avatar.root.userData.homePairedCourtesyWork={steps:job.steps,pending:pairedCourtesyJobs.has(requester.id)};
            if(!plan)continue;
          }
          plan=validatePairedHomeCourtesy(input,plan);
          avatar.root.userData.homePairedCourtesy=plan;
          if(!plan){pairedCourtesyJobs.delete(requester.id);continue;}
          if(plan.wait){
            const route=idleYieldGraph(area,requestRadius).planTo({from:frame.pose,to:plan.wait.goal,id:requester.id,avoid:bodies});
            if(journeys.redirectYieldBay(requester.id,route)){job.ready={moves:plan.moves};pairedCourtesyJobs.set(requester.id,job);}
            continue;
          }
          pairedCourtesyJobs.delete(requester.id);
          if(plan)for(const [index,move]of plan.moves.entries()){
            const c=gathering.companions.find(c=>c.id===move.id)!,a=avatars.get(move.id)!;
            journeys.releaseYieldFor(requester.id,move.id);
            const held:IdleYield={requester:requester.id,requestKey:details.target.key,sourceKey:idleYieldSource(c),area,target:move.goal,after:plan.moves.slice(0,index).map(move=>move.id)};
            idleYields.set(move.id,held);a.root.userData.homeIdleYield={...held,from:{x:a.root.position.x,z:a.root.position.z}};
          }
        }
      }
    }
    function prepareHomeJourneys(delta:number,seated:Map<number,WorldRestSeat>,sleeping:Map<number,WorldSleepingBed>,localSeats:Map<number,{x:number;y:number;z:number;area:'indoor'|'bedroom'|'outdoor';station?:string;support?:readonly string[]}>){
      const proposals=new Map<number,NonNullable<ReturnType<typeof journeys.prepare>>>();
      if(!canJourney()){journeys.reset();idleYields.clear();pairedCourtesyJobs.clear();pairedCourtesyFailures.clear();idleYieldChecks.clear();socialPlan.clear();socialPlanKey='';host.dataset.socialParticipants='0';return proposals;}refreshJourneyGeometry();prepareIdleYields(delta,seated,sleeping,localSeats);
      const socialActors=gathering.companions.flatMap(c=>{const a=avatars.get(c.id);return c.activity==='talk'&&!c.leisure&&!floorBusy(c.id)&&!localSeats.has(c.id)&&a?[{id:c.id,area:areaFor(c),radius:Number(a.root.userData.navigationClearance)}]:[];});
      const socialKey=JSON.stringify([gathering.id,environmentKey,itemKey,socialActors]);
      // Wait for actual safe spawn/area arrival, never a blocked social target.
      // Real positions are inputs to one plan only, not part of the per-frame key.
      const socialOriginsReady=socialActors.every(c=>{const frame=journeys.get(c.id);return avatars.get(c.id)?.root.userData.homeRegion===c.area&&!frame?.active&&!frame?.pose.contact&&!frame?.contactBlend;});
      // A distant talk request can fail before its free floor approach finishes.
      // Retry that empty result once the real bodies settle at new safe poses;
      // an unchanged failed pose and an existing meeting never trigger searches.
      const originsKey=socialOriginsReady?socialActors.map(c=>{const p=avatars.get(c.id)!.root.position;return c.id+':'+p.x.toFixed(4)+':'+p.z.toFixed(4);}).join('|'):'';
      const arrivedAfterEmpty=!socialPlan.size&&socialActors.length>=2&&socialOriginsReady&&originsKey!==socialPlanOriginsKey;
      if(socialKey!==socialPlanKey||socialPlanPending&&socialOriginsReady||arrivedAfterEmpty){
        socialPlanKey=socialKey;socialPlanPending=!socialOriginsReady;
        socialPlanOriginsKey=socialOriginsReady?originsKey:'';
        socialSightCache.clear();
        socialPlan=socialPlanPending?new Map():planSocialGathering(socialActors.map(c=>{const a=avatars.get(c.id)!;return{...c,from:{x:a.root.position.x,z:a.root.position.z}};}),boundsFor,journeyGraph,area=>gathering.companions.filter(c=>!socialActors.some(a=>a.id===c.id)&&!floorBusy(c.id)).flatMap(c=>{const a=avatars.get(c.id);return a&&a.root.userData.homeRegion===area?[{position:{x:a.root.position.x,z:a.root.position.z},radius:Number(a.root.userData.navigationClearance)}]:[];}),(left,right)=>{
          return socialEyeLineClear(left.id,right.id);
        },(left,right)=>socialEyeLineClear(left.id,right.id,left.from,right.from));
      }
      host.dataset.socialParticipants=String(socialPlan.size);

      // Returning partners reserve distinct safe floor goals before any individual journey is reconciled.
      const floorTargets=canNaturalLeisure()?allocateLivingNavigationAnchors(gathering.companions.flatMap(c=>{
        const a=avatars.get(c.id),raw=worldAnchor(gathering,c.id),area='outdoor' as const;
        // Keep every partner's future floor slot, including while seated or indoors, so unrelated idle partners never swap targets.
        if(!a||!raw)return[];
        const radius=a.root.userData.navigationClearance as number,anchor=naturalFloorAnchor(area,navigationWorldPoint(area,{x:raw.x,y:0,z:raw.z}));
        return[{id:c.id,anchor,radius,graph:navigationGraph(area,radius)}];
      })):null;
      for(const c of gathering.companions){
        const a=avatars.get(c.id);if(!a||onVillaStair(c.id))continue;
        const goingUp=villaVisit.snapshot(c.id)?.phase==='approach';
        const local=localSeats.get(c.id),seat=local??seated.get(c.id),bed=local?undefined:sleeping.get(c.id),area=local?.area??areaFor(c),radius=a.root.userData.navigationClearance as number;
        if(!local||!('station'in local)||local.station!=='bench')benchEgress.delete(c.id);
        const raw=worldAnchor(gathering,c.id);if(!raw)continue;
        const benchReturnKey=[gathering.id,gathering.me,c.activity,c.area,c.x,c.y,environmentKey,itemKey].join('/');
        if(benchReturns.get(c.id)?.key!==benchReturnKey)benchReturns.delete(c.id);
        let target:JourneyTarget;
        if(seat){
          floorGoalCache.delete(c.id);
          const p=local?seat:navigationWorldPoint(area,{x:seat.x,y:seat.y,z:seat.z}),seatYaw='yaw'in seat?Number(seat.yaw):0,front={x:p.x+Math.sin(seatYaw)*1.65,z:p.z+Math.cos(seatYaw)*1.65};
          const bench=!!local&&'station'in local&&local.station==='bench';
          const approach=(bench?benchApproach({x:p.x,z:p.z,yaw:seatYaw},radius):undefined)??('approach' in seat?seat.approach:undefined)??journeyGraph(area,radius).findSafePoint(front,[]);
          target={key:'seat/'+area+'/'+p.x+'/'+p.z+'/'+(local?'local':'rest'),pose:{x:p.x,y:seat.y-a.seatHeight*a.baseScale.y*.9,z:p.z,yaw:seatYaw,tilt:0,scale:.9,area,contact:'rest'},approach:approach??front};
          if(bench){
            const door='home-main-entry-door',current={x:a.root.position.x,z:a.root.position.z},entry=journeyPortals().main.before,phase=journeys.get(c.id)?.phase;
            let egress=benchEgress.get(c.id);if(egress?.seatKey!==target.key){benchEgress.delete(c.id);egress=undefined;}
            if(egress&&Math.hypot(current.x-egress.point.x,current.z-egress.point.z)<.01&&!doors[door].open&&doors[door].progress<.001){benchEgress.delete(c.id);egress=undefined;}
            if(!egress&&a.root.userData.homeRegion==='outdoor'&&phase==='blocked'&&doors[door].open&&Math.hypot(current.x-entry.x,current.z-entry.z)<.2){
              const graph=journeyGraph('outdoor',radius),blocked=graph.planTo({from:current,to:target.approach,id:c.id}).blocked;
              if(blocked){
                const peers=[...avatars].filter(([id])=>id!==c.id).map(([,a])=>({position:{x:a.root.position.x,z:a.root.position.z},radius:Number(a.root.userData.navigationClearance)})),sweep=doorSweepBoxes(door);
                const points=[];for(const distance of [1.8,2.2,2.6,3])for(const side of [1,-1])for(const forward of [.3,.6,1])points.push({x:entry.x+side*distance,z:entry.z+forward});
                const routes=points.filter(point=>sweep.every(box=>point.x<box.min.x-radius-.035||point.x>box.max.x+radius+.035||point.z<box.min.z-radius-.035||point.z>box.max.z+radius+.035)).map(point=>({point,route:graph.planTo({from:current,to:point,id:c.id,avoid:peers})})).filter(value=>!value.route.blocked).sort((a,b)=>a.route.length-b.route.length);
                if(routes[0]){egress={seatKey:target.key,point:routes[0].point};benchEgress.set(c.id,egress);}
              }
            }
            // Finish this physical exit before resuming the saved bench order.
            // Door autonomy closes only after the body clears its real sweep.
            if(egress)target={...target,key:'bench-egress/'+egress.seatKey+'/'+egress.point.x+'/'+egress.point.z,approach:egress.point};
            benchReturns.set(c.id,{key:benchReturnKey,point:target.approach});
          }else{benchEgress.delete(c.id);benchReturns.delete(c.id);}
        }else if(bed){
          floorGoalCache.delete(c.id);
          const p=navigationWorldPoint(area,{x:bed.x,y:bed.y,z:bed.z}),bp=computeLivingBedPose(a.sleepSupport,a.baseScale.clone().multiplyScalar(.9),1);
          const base:JourneyPose={x:p.x,y:p.y+(bp?.rootOffsetY??0),z:p.z-bed.length*.33+(bp?.headOffsetZ??0),yaw:0,tilt:bp?.rotationX??-Math.PI/2,scale:.9,area,contact:'sleep'},fitKey=[a.root.uuid,p.x,p.y,p.z,bed.length,environmentKey,itemKey].join('/');
          let fit=bedContactOffsets.get(c.id);if(!fit||fit.key!==fitKey){fit={key:fitKey,...contactCollision.sleepContactFit(a,decoration,items,base,bed.support??['room-bed-'+bed.id])};bedContactOffsets.set(c.id,fit);}a.root.userData.sleepContactOffset=fit.offset;a.root.userData.sleepLegLift=fit.legLift;
          // A bed is boarded at a reachable long side, never through its footboard.
          // Keep the chosen side stable while peers/doors move; layout changes
          // invalidate it, and a wholly blocked side remains a safe wait.
          const sideKey=[fitKey,radius,base.z+fit.offset].join('/');
          let side=bed.approach?{key:sideKey,point:bed.approach}:bedSideApproaches.get(c.id);
          if(!side||side.key!==sideKey){
            const support=decoration?.getObjectByName((bed.support??['room-bed-'+bed.id])[0]),box=support?new T.Box3().setFromObject(support,true):null;
            const minX=box?.min.x??p.x-bed.width/2,maxX=box?.max.x??p.x+bed.width/2,graph=journeyGraph(area,radius);
            const current={x:a.root.position.x,z:a.root.position.z},origin=a.root.userData.homeRegion===area&&graph.isSegmentClear(current,current)?current:journeyPortals().bedroom.after;
            const z=base.z+fit.offset,candidates=[minX-radius-.03,maxX+radius+.03].flatMap(x=>[z,z-.3,z+.3].map(z=>({x,z})));
            const reachable=candidates.filter(point=>graph.isSegmentClear(point,point)).map(point=>({point,route:graph.planTo({from:origin,to:point,id:c.id})})).filter(value=>!value.route.blocked).sort((a,b)=>a.route.length-b.route.length||a.point.x-b.point.x||a.point.z-b.point.z);
            side={key:sideKey,point:reachable[0]?.point??candidates[0]};bedSideApproaches.set(c.id,side);
          }
          target={key:'bed/'+p.x+'/'+p.z+'/'+bed.length+'/'+side.point.x+'/'+side.point.z+(fit.offset?'/'+fit.offset+'/'+fit.legLift:''),pose:{...base,z:base.z+fit.offset,...(fit.legLift?{bedLegLift:fit.legLift}:{})},approach:side.point};
        }else if(socialPlan.has(c.id)){
          floorGoalCache.delete(c.id);
          const slot=socialPlan.get(c.id)!;target={key:'social/'+slot.group+'/'+slot.position.x+'/'+slot.position.z,pose:{...slot.position,y:0,yaw:slot.yaw,tilt:0,scale:1,area:slot.area,contact:null},approach:slot.position};
        }else{
          const p=naturalFloorAnchor(area,navigationWorldPoint(area,{x:raw.x,y:0,z:raw.z})),floorGraph=canNaturalLeisure()&&area==='outdoor'?navigationGraph(area,radius):journeyGraph(area,radius);
          // A free endpoint may be on the far side of furniture. Select once in
          // the region reached by the real body (or the destination doorway),
          // then keep that goal while walking so moving peers cannot make it jump.
          const goalKey=[gathering.id,c.activity,area,p.x,p.z,radius,navRevision,environmentKey,itemKey].join('/');
          // Stopping bench leisure completes at its proven free floor approach.
          // Preserve the saved activity; a talk meeting can plan from this real
          // origin instead of requiring an unrelated trip through busy peers.
          const benchReturn=benchReturns.get(c.id)?.point;
          let safe=area==='outdoor'&&benchReturn&&floorGraph.isSegmentClear(benchReturn,benchReturn)?benchReturn:floorTargets?.has(c.id)?floorTargets.get(c.id)??{x:a.root.position.x,z:a.root.position.z}:floorGoalCache.get(c.id)?.key===goalKey?floorGoalCache.get(c.id)!.point:null;
          if(!safe){
            const current={x:a.root.position.x,z:a.root.position.z},previous=journeys.diagnostics(c.id),portals=journeyPortals();
            const entry=area==='outdoor'?portals.main.before:area==='bedroom'?portals.bedroom.after:portals.main.after;
            const from=a.root.userData.homeRegion===area&&floorGraph.isSegmentClear(current,current)?current:previous?.target.pose.area===area&&floorGraph.isSegmentClear(previous.target.approach,previous.target.approach)?previous.target.approach:entry;
            const occupied=[...avatars].filter(([id,peer])=>id!==c.id&&!floorBusy(id)&&peer.root.userData.homeRegion===area).map(([,peer])=>({position:{x:peer.root.position.x,z:peer.root.position.z},radius:Number(peer.root.userData.navigationClearance)}));
            const frame=journeys.get(c.id),stage=previous?.stages[previous.stage];
            // A grounded walker is already at a valid roaming origin. Sending
            // it back to a business anchor can repeatedly yield to another
            // roaming body without ever completing that unnecessary approach.
            // Keep the physical pose; doorway/contact exits still finish first.
            const groundedWalk=c.activity==='walk'&&a.root.userData.homeRegion===area&&!frame?.pose.contact&&!frame?.contactBlend
              &&stage?.kind!=='portal'&&!['portal','wait-door','dock','undock'].includes(frame?.phase??'')
              &&floorGraph.isSegmentClear(current,current)&&occupied.every(peer=>Math.hypot(current.x-peer.position.x,current.z-peer.position.z)>=radius+peer.radius+.035-1e-6);
            safe=groundedWalk?current:floorGraph.findSafePoint(p,occupied,0,from)??p;
            floorGoalCache.set(c.id,{key:goalKey,point:safe});
          }
          target={key:'floor/'+c.activity+'/'+area+'/'+safe.x+'/'+safe.z,pose:{x:safe.x,y:0,z:safe.z,yaw:0,tilt:0,scale:1,area,contact:null},approach:safe};
        }
        if(goingUp)target={key:'villa-stair-boarding',pose:{...VILLA_STAIR_BOTTOM,yaw:Math.PI,tilt:0,scale:1,area:'bedroom',contact:null},approach:VILLA_STAIR_BOTTOM};
        const courtesy=goingUp?undefined:idleYields.get(c.id);if(courtesy&&(!seat&&!bed||local?.station==='bench'))target={key:'courtesy/'+courtesy.sourceKey+'/'+courtesy.requester+'/'+courtesy.requestKey+'/'+courtesy.target.x+'/'+courtesy.target.z,pose:{...courtesy.target,y:0,yaw:Math.atan2(courtesy.target.x-a.root.position.x,courtesy.target.z-a.root.position.z),tilt:0,scale:1,area:courtesy.area,contact:null},approach:courtesy.target};
        const fineRoute=!!courtesy||[...idleYields.values()].some(held=>held.requester===c.id&&held.requestKey===target.key),routeGraph=(region:'indoor'|'bedroom'|'outdoor')=>fineRoute?idleYieldGraph(region,radius):journeyGraph(region,radius);
        const support=goingUp?[]:bed?[...(bed.support??['room-bed-'+bed.id])]:seat&&'support'in seat&&seat.support?[...seat.support]:seat?journeyObstacles.filter(o=>/sofa|chair|bench/i.test(o.source)&&target.pose.x>=o.minX-.03&&target.pose.x<=o.maxX+.03&&target.pose.z>=o.minZ-.03&&target.pose.z<=o.maxZ+.03).map(o=>o.source):[];
        if(a.root.userData.journeyTargetKey!==target.key){
          a.root.userData.journeyPreviousSupport=journeys.get(c.id)?.phase==='undock'?a.root.userData.journeyPreviousSupport:a.root.userData.journeyCurrentSupport??support;
          a.root.userData.journeyPreviousContactMode=journeys.get(c.id)?.phase==='undock'?a.root.userData.journeyPreviousContactMode:a.root.userData.journeyCurrentContactMode;
          a.root.userData.journeyCurrentContactMode=bed?'sleep':local&&'activity'in local&&local.activity==='television'?'television':support.some(name=>/^home-mahjong-chair-\d$/.test(name))?'mahjong':null;
          a.root.userData.journeyCurrentSupport=support;a.root.userData.journeyTargetKey=target.key;
        }
        a.root.userData.journeyTargetArea=target.pose.area;
        if(socialPlan.has(c.id)&&!journeys.diagnostics(c.id)){
          if(!a.root.userData.homeRegion)continue;
          const initial=actualJourneyPose(a);journeys.reconcile(c.id,{key:'social-initial',pose:initial,approach:initial},initial);
        }
        journeys.reconcile(c.id,target,a.root.userData.homeRegion?actualJourneyPose(a):target.pose);
        const egress=benchEgress.get(c.id);
        if(egress&&Math.hypot(a.root.position.x-egress.point.x,a.root.position.z-egress.point.z)<.01){
          const frozen=journeys.get(c.id)!,point={x:frozen.pose.x,z:frozen.pose.z};
          proposals.set(c.id,{id:c.id,position:point,desired:point,yaw:frozen.pose.yaw,area:frozen.pose.area,phase:frozen.phase,speed:0,canTraverse:(from,to)=>Math.hypot(from.x-to.x,from.z-to.z)<1e-7});continue;
        }
        const courtesyWaiting=[...idleYields].some(([id,held])=>held.requester===c.id&&held.requestKey===target.key&&(!journeys.diagnostics(id)?.target.key.startsWith('courtesy/')||journeys.get(id)?.active));
        const courtesyPredecessorWaiting=courtesy?.after?.some(id=>!journeys.diagnostics(id)?.target.key.startsWith('courtesy/')||journeys.get(id)?.active);
        if(courtesyWaiting||courtesyPredecessorWaiting){
          // A retreat created before the observer accepted its courtesy route
          // must release its reverse reservation throughout the clearance wait.
          for(const [peerId,held] of idleYields)if(held.requester===c.id&&held.requestKey===target.key)journeys.releaseYieldFor(c.id,peerId);
          // The observer's one physical route owns this short clearance wait.
          // Do not let the requester create a second, reverse yielding plan.
          const frozen=journeys.get(c.id)!;const point={x:frozen.pose.x,z:frozen.pose.z};
          proposals.set(c.id,{id:c.id,position:point,desired:point,yaw:frozen.pose.yaw,area:frozen.pose.area,phase:frozen.phase,speed:0,canTraverse:(from,to)=>Math.hypot(from.x-to.x,from.z-to.z)<1e-7});continue;
        }
        const contactSupport=(journeys.get(c.id)?.phase==='undock'?a.root.userData.journeyPreviousSupport:support) as string[]|undefined;
        const exactMahjongContact=!!contactSupport?.some(name=>/^home-mahjong-chair-\d$/.test(name));
        const savedContactMode=journeys.get(c.id)?.phase==='undock'?a.root.userData.journeyPreviousContactMode:a.root.userData.journeyCurrentContactMode;
        const contactMode=savedContactMode==='sleep'?'sleep':savedContactMode==='television'?'television':'mahjong';
        const exactContact=exactMahjongContact||contactMode==='sleep'||contactMode==='television'&&!!contactSupport?.some(name=>/^sofa-/.test(name));
        const contactRadius=exactContact&&journeys.get(c.id)?.pose.contact==='rest'?contactCollision.radius(a,contactMode):null;
const proposal=journeys.prepare(c.id,delta,{revision:navRevision,yaw:a.root.rotation.y,recoverYieldingRoute:canLocalLeisure()||canNaturalIndoor(),coordinateContacts:canLocalLeisure(),radius:contactRadius??(canNaturalLeisure()&&!journeys.get(c.id)?.active?radius*a.root.scale.x/a.baseScale.x:radius),plan:(from,to,region,avoid)=>{
          const fixed=goingUp?[...avatars].filter(([id,peer])=>id!==c.id&&peer.root.userData.homeRegion===region&&(localSeats.has(id)||seated.has(id)||sleeping.has(id))&&idleYields.get(id)?.requester!==c.id).map(([,peer])=>({position:{x:peer.root.position.x,z:peer.root.position.z},radius:Number(peer.root.userData.navigationClearance)})):[];
          return routeGraph(region).planTo({from,to,id:c.id,avoid:courtesy?[...(avoid??[]),...[...avatars].filter(([id])=>id!==c.id).map(([,a])=>({position:{x:a.root.position.x,z:a.root.position.z},radius:Number(a.root.userData.navigationClearance)}))]:[...(avoid??[]),...fixed]});
        },yieldPlan:(from,region,avoid,keepFree)=>{
          const graph=journeyGraph(region,radius),occupied=[...avoid,...keepFree],candidates=new Map<string,{x:number;z:number}>();
          for(const distance of [0,1.2,2.4,3.6,4.8])for(let direction=0;direction<(distance?8:1);direction++){
            const angle=direction*Math.PI/4,point=graph.findSafePoint({x:from.x+Math.sin(angle)*distance,z:from.z+Math.cos(angle)*distance},occupied);
            if(point&&Math.hypot(point.x-from.x,point.z-from.z)>.15)candidates.set(point.x+'/'+point.z,point);
          }
          for(const to of [...candidates.values()].sort((a,b)=>Math.hypot(a.x-from.x,a.z-from.z)-Math.hypot(b.x-from.x,b.z-from.z)||a.x-b.x||a.z-b.z)){
            if(Math.hypot(to.x-from.x,to.z-from.z)<radius*.5)continue;
            const route=graph.planTo({from,to,id:c.id,avoid});if(!route.blocked&&route.length>.15)return route;
          }
          return null;
        },...(contactMode==='sleep'?{contactPath:(from:JourneyPose,to:JourneyPose,fromBlend:number,toBlend:number)=>contactCollision.sleepPath(a,decoration,from,to,fromBlend,toBlend,contactSupport??[])}:{}),...(exactContact?{contactPeerRadius:(id:number)=>{const peer=avatars.get(id);return peer?(contactMode==='sleep'||contactMode==='television'&&!peer.root.userData.roomRestSeat?Number(peer.root.userData.navigationClearance):contactCollision.radius(peer,contactMode)):NaN;},isContactClear:(from:JourneyPose,to:JourneyPose,fromBlend:number,toBlend:number,wholeTransfer?:boolean)=>{
          const clear=contactCollision.isClear(a,decoration,items,from,to,fromBlend,toBlend,contactSupport!,wholeTransfer,contactMode);
          a.root.userData.contactCollision=contactCollision.getLastCollision();return clear;
        }}:{}),isClear:(from,to,region)=>{
          const phase=journeys.get(c.id)?.phase;
          if(phase==='dock'||phase==='undock'){
            const ignored=(phase==='undock'?a.root.userData.journeyPreviousSupport:a.root.userData.journeyCurrentSupport) as string[];
            const key='contact/'+region+'/'+radius+'/'+ignored.join(',');let graph=journeyGraphs.get(key);
            if(!graph){graph=createLivingNavigation({bounds:boundsFor(region),blocked:areaObstacles(region,journeyObstacles).filter(o=>!ignored.some(prefix=>o.source===prefix||o.source.startsWith(prefix+':'))),clearance:radius*.9,step:.16});journeyGraphs.set(key,graph);}
            return graph.isSegmentClear(from,to);
          }
          return journeyGraph(region,radius).isSegmentClear(from,to);
        },portalClear:(from,to,door)=>journeyPortalGraph(c.id,door,from,to).isSegmentClear(from,to),turnClear:(point,door)=>journeyPortalGraph(c.id,door,point,point,true).isSegmentClear(point,point),doorOpen:door=>doors[door].open&&doors[door].progress>=.999});
        if(proposal)proposals.set(c.id,proposal);
        else{const frozen=journeys.get(c.id);if(frozen?.active){const point={x:frozen.pose.x,z:frozen.pose.z};proposals.set(c.id,{id:c.id,position:point,desired:point,yaw:frozen.pose.yaw,area:frozen.pose.area,phase:frozen.phase,portal:a.root.userData.journeyPortal??undefined,speed:0,canTraverse:(from,to)=>Math.hypot(from.x-to.x,from.z-to.z)<1e-7});}else{delete a.root.userData.homeJourney;delete a.root.userData.journeyPortal;}}
      }
      return proposals;
    }

    function navigateHomeFrame(now:number,seated:Map<number,WorldRestSeat>,sleeping:Map<number,WorldSleepingBed>,localSeats:Map<number,{x:number;y:number;z:number;area:'indoor'|'bedroom'|'outdoor'}>){
      const delta=motion&&!document.hidden?Math.min(.1,Math.max(0,now-navigationLastNow)):0;navigationLastNow=now;navigationDelta=delta;
      const frame=new Map<number,ReturnType<typeof sampleLivingNavigation>&{yielded:boolean}>();
      if(gathering.scene_type!=='home'&&!canNaturalWorld()){pedestrianTraffic.reset();return frame;}refreshNavigation();
      const journeyPrepared=prepareHomeJourneys(delta,seated,sleeping,localSeats),trafficRegion=(area:string)=>canJourney()?'home':area;
      const actors:LivingPedestrianActor[]=[],occupied=new Map<string,{position:{x:number;z:number};radius:number}[]>();
      const prepared=new Map<number,{state:NavState;sample:ReturnType<typeof sampleLivingNavigation>;from:{x:number;z:number};walking:boolean;graph:LivingNavigation;radius:number;area:string}>();
      const companions=[...gathering.companions].filter(c=>!onVillaStair(c.id)).sort((a,b)=>a.id-b.id),fixedIds=new Set<number>();
      const reserve=(area:string,position:{x:number;z:number},radius:number)=>{const entries=occupied.get(area)??[];entries.push({position,radius});occupied.set(area,entries);};
      for(const[id,p]of journeyPrepared){const radius=avatars.get(id)!.root.userData.navigationClearance as number;for(const area of ['indoor','bedroom','outdoor'])reserve(area,p.position,radius);}
      // Furniture users are fixed before walkers choose any initial free floor point.
      for(const companion of companions){
        const id=companion.id,a=avatars.get(id);if(!a||journeyPrepared.has(id))continue;
        const local=localSeats.get(id),seat=local??seated.get(id),bed=local?undefined:sleeping.get(id);if(!seat&&!bed)continue;
        const area=local?.area??areaFor(companion),radius=local&&'station'in local&&local.station==='mahjong'?contactCollision.radius(a):(a.root.userData.navigationClearance as number)*.9;
        const bedPose=bed?computeLivingBedPose(a.sleepSupport,a.baseScale.clone().multiplyScalar(.9),1):null;
        const raw=seat?{x:seat.x,y:0,z:seat.z}:{x:bed!.x,y:0,z:bed!.z-bed!.length*.33+(bedPose?.headOffsetZ??0)};
        const fixed=local?raw:navigationWorldPoint(area,raw),position={x:fixed.x,z:fixed.z};
        actors.push({id,region:trafficRegion(area),position,desired:position,radius,walking:false,speed:0,canTraverse:()=>false});reserve(area,position,radius);fixedIds.add(id);
      }
      // A completed courtesy occupies real floor, not a new roaming anchor.
      // Natural-scene leisure clearways must not snap it to another free point.
      for(const [id,held]of idleYields){
        const a=avatars.get(id);if(!a||fixedIds.has(id)||journeyPrepared.has(id))continue;
        const position={x:a.root.position.x,z:a.root.position.z},radius=Number(a.root.userData.navigationClearance);
        actors.push({id,region:trafficRegion(held.area),position,desired:position,radius,walking:false,speed:0,canTraverse:()=>false});
        reserve(held.area,position,radius);fixedIds.add(id);navStates.delete(id);journeyArrivals.delete(id);
        frame.set(id,{position,yaw:journeys.get(id)?.pose.yaw??Number(a.root.userData.observeFacing??a.root.rotation.y),moving:false,blocked:null,anchorCorrected:false,yielded:false});
      }
      const resetInputs=new Map<number,{key:string;graph:LivingNavigation;anchor:{x:number;z:number};from:{x:number;z:number};area:'indoor'|'bedroom'|'outdoor';radius:number;newcomer:boolean}>();
      for(const companion of companions){
        const id=companion.id,a=avatars.get(id);if(!a||fixedIds.has(id)||journeyPrepared.has(id))continue;
        const area=areaFor(companion),radius=a.root.userData.navigationClearance as number,raw=worldAnchor(gathering,id);if(!raw)continue;
        const anchor=naturalFloorAnchor(area,navigationWorldPoint(area,{x:raw.x,y:0,z:raw.z})),graph=navigationGraph(area,radius),key=area+'/'+companion.activity+'/'+anchor.x+'/'+anchor.z+'/'+radius,old=navStates.get(id);
        if(!old||old.key!==key||old.revision!==navRevision){a.root.userData.homeNavigationReset={oldKey:old?.key,key,oldRevision:old?.revision,revision:navRevision,position:old?.position,arrival:journeyArrivals.get(id)};resetInputs.set(id,{key,graph,anchor,from:old?.region===area&&old.position?old.position:journeyArrivals.get(id)??anchor,area,radius,newcomer:!old?.position&&!journeyArrivals.has(id)&&!a.root.userData.homeRegion});}
        else if(old.position)reserve(area,old.position,radius);
      }
      // New floor arrivals must not seal a traveller's remaining doorway or
      // seating corridor. Existing bodies keep their physical position.
      const futureOccupied=new Map<string,{position:{x:number;z:number};radius:number}[]>();
      if([...resetInputs.values()].some(input=>input.newcomer))for(const [id,p]of journeyPrepared){
        const details=journeys.diagnostics(id),radius=avatars.get(id)!.root.userData.navigationClearance as number;
        if(!details)continue;const path=[p.position,...(details.route?.slice(details.waypoint)??[])];
        for(const stage of details.stages.slice(details.stage)){
          if(stage.kind==='portal')path.push(...stage.points.slice(stage.leg));else path.push(stage.goal);
        }
        path.push(details.target.approach,details.target.pose);
        for(let index=0;index<path.length;index++){
          const from=index?path[index-1]:path[index],to=path[index],steps=Math.max(1,Math.ceil(Math.hypot(to.x-from.x,to.z-from.z)/.4));
          for(let step=0;step<=steps;step++){const t=step/steps,point={x:from.x+(to.x-from.x)*t,z:from.z+(to.z-from.z)*t};for(const area of ['indoor','bedroom','outdoor']){const values=futureOccupied.get(area)??[];values.push({position:point,radius:radius+.2});futureOccupied.set(area,values);}}
        }
      }
      const placements=new Map<number|string,{x:number;z:number}|null>();
      for(const area of ['indoor','bedroom','outdoor'] as const){
        const values=[...resetInputs].filter(([,input])=>input.area===area),inputs=(newcomer:boolean)=>values.filter(([,input])=>input.newcomer===newcomer).map(([id,input])=>({id,anchor:input.from,radius:input.radius,graph:input.graph,roaming:gathering.companions.find(c=>c.id===id)?.activity==='walk'}));
        // Arrivals already occupy real floor. Future route reservations must not
        // relocate them; only bodies that have never been placed may be spawned
        // away from a traveller's future corridor.
        const known=inputs(false),arrived=known.filter(input=>journeyArrivals.has(Number(input.id)));
        for(const input of arrived){placements.set(input.id,input.anchor);reserve(area,input.anchor,input.radius);}
        const continuing=known.filter(input=>!journeyArrivals.has(Number(input.id))),safeContinuing=continuing.filter(input=>input.graph.isSegmentClear(input.anchor,input.anchor));
        for(const input of safeContinuing){placements.set(input.id,input.anchor);reserve(area,input.anchor,input.radius);}
        for(const [id,position]of allocateLivingNavigationAnchors(continuing.filter(input=>!safeContinuing.includes(input)),occupied.get(area)??[])){placements.set(id,position);if(position)reserve(area,position,resetInputs.get(Number(id))!.radius);}
        for(const [id,position]of allocateLivingNavigationAnchors(inputs(true).map(input=>canReferenceVilla()?{...input,graph:journeyGraph(area,input.radius),reachableFrom:area==='outdoor'?journeyPortals().main.before:area==='indoor'?journeyPortals().main.after:journeyPortals().bedroom.after}:input),[...(occupied.get(area)??[]),...(futureOccupied.get(area)??[])]))placements.set(id,position);
      }
      for(const companion of companions){
        const id=companion.id,a=avatars.get(id);if(!a||fixedIds.has(id)||journeyPrepared.has(id))continue;
        const area=areaFor(companion),radius=a.root.userData.navigationClearance as number,raw=worldAnchor(gathering,id);if(!raw)continue;
        const anchor=naturalFloorAnchor(area,navigationWorldPoint(area,{x:raw.x,y:0,z:raw.z})),graph=navigationGraph(area,radius);
        const key=area+'/'+companion.activity+'/'+anchor.x+'/'+anchor.z+'/'+radius;let state=navStates.get(id);
        if(!state||state.key!==key||state.revision!==navRevision){
          const original=state?.region===area&&state.position?state.position:anchor,safe=placements.get(id)??null,planned=graph.plan({anchor:safe??original,id});
          const route:LivingNavigationRoute=safe?{...planned,anchorCorrected:planned.anchorCorrected||Math.hypot(safe.x-original.x,safe.z-original.z)>1e-6}:{...planned,safeAnchor:null,blocked:'no-safe-point'};
          state={key,revision:navRevision,region:area,route,elapsed:0,lastNow:now,position:safe};navStates.set(id,state);journeyArrivals.delete(id);
        }
        const walking=motion&&companion.activity==='walk'&&!state.route.blocked;
        let current=sampleLivingNavigation(state.route,state.elapsed,walking);const from=state.position??current.position;
        if(!from){frame.set(id,{...current,yielded:false});continue;}
        let sample=current;
        if(walking){
          const rawArc=state.elapsed*state.route.speed%state.route.length,arc=state.route.length-rawArc<1e-6?0:rawArc,nextCorner=state.route.cumulative.find(value=>value>arc+1e-6)??state.route.length;
          const toCorner=Math.max(0,(nextCorner-arc)/state.route.speed);
          const candidate=[.6,.3,.1,delta].map(horizon=>sampleLivingNavigation(state!.route,state!.elapsed+Math.min(horizon,toCorner),true))
            .find(value=>value.position&&graph.isSegmentClear(from,value.position));
          if(candidate)sample=candidate;
          else{state.route=graph.plan({anchor:from,id});state.elapsed=0;current=sampleLivingNavigation(state.route,0,true);sample=sampleLivingNavigation(state.route,delta,true);}
        }
        if(!sample.position){frame.set(id,{...sample,yielded:false});continue;}
        reserve(area,from,radius);prepared.set(id,{state,sample,from,walking,graph,radius,area});
        actors.push({id,region:trafficRegion(area),position:from,desired:sample.position,radius,walking,speed:state.route.speed,
          heading:{x:Math.sin(current.yaw),z:Math.cos(current.yaw)},canTraverse:graph.isSegmentClear});
      }
      for(const[id,p]of journeyPrepared){
        const a=avatars.get(id)!,contact=!!p.contactTransition&&!!journeys.get(id)?.pose.contact;
        const contactMode=(p.contactTransition==='undock'?a.root.userData.journeyPreviousContactMode:a.root.userData.journeyCurrentContactMode)==='television'?'television':'mahjong';
        const exactContact=contact&&((p.contactTransition==='undock'?a.root.userData.journeyPreviousSupport:a.root.userData.journeyCurrentSupport) as string[]|undefined)?.some(name=>/^home-mahjong-chair-\d$/.test(name)||contactMode==='television'&&/^sofa-/.test(name));
        const radius=exactContact?contactCollision.radius(a,contactMode):(a.root.userData.navigationClearance as number)*(contact&&!canNaturalLeisure()?.9:1);
        actors.push({id,region:'home',position:p.position,desired:p.desired,radius,walking:motion&&Math.hypot(p.desired.x-p.position.x,p.desired.z-p.position.z)>1e-7,speed:p.speed,heading:{x:Math.sin(p.yaw),z:Math.cos(p.yaw)},canTraverse:p.canTraverse,managedRoute:true});
      }
      const exactContacts=new Set([...journeyPrepared].filter(([id,p])=>{const a=avatars.get(id),mode=p.contactTransition==='undock'?a?.root.userData.journeyPreviousContactMode:a?.root.userData.journeyCurrentContactMode;return !!p.contactTransition&&((p.contactTransition==='undock'?a?.root.userData.journeyPreviousSupport:a?.root.userData.journeyCurrentSupport) as string[]|undefined)?.some(name=>/^home-mahjong-chair-\d$/.test(name)||mode==='television'&&/^sofa-/.test(name));}).map(([id])=>id));
      const hasMahjongContact=[...exactContacts].some(id=>avatars.get(id)?.root.userData.journeyCurrentContactMode!=='television');
      const trafficActors=canLocalLeisure()?actors.map(actor=>{const a=avatars.get(Number(actor.id)),mode=a?.root.userData.journeyCurrentContactMode==='television'?'television':'mahjong';return{...actor,...(exactContacts.size?{contacting:exactContacts.has(Number(actor.id)),contactRadius:a&&(hasMahjongContact||exactContacts.has(Number(actor.id))||a.root.userData.roomRestSeat)?contactCollision.radius(a,mode):actor.radius}:{}),canTraverse:(from:{x:number;z:number},to:{x:number;z:number})=>actor.canTraverse(from,to)&&journeys.canCrossContact(Number(actor.id),from,to,actor.radius)};}):actors;
      const resolved=pedestrianTraffic.step(trafficActors,delta);let resetTraffic=false;
      for(const[id,p]of journeyPrepared){
        const result=resolved.get(id),a=avatars.get(id);if(!result||!a)continue;
        const value=journeys.commit(id,result.position,delta),details=journeys.diagnostics(id),waitingForClearance=!!value?.active&&value.phase==='walk'&&!result.moving&&(details?.waited??0)>=.9;
        a.root.userData.homeJourneyNavigation=details;a.root.userData.homeJourney=value?{...value,phase:waitingForClearance?'blocked':value.phase,waitingForClearance,position:{x:value.pose.x,z:value.pose.z},area:value.pose.area,targetArea:a.root.userData.journeyTargetArea}:null;a.root.userData.journeyPortal=p.portal??null;
        if(value&&!value.active){navStates.delete(id);journeyArrivals.set(id,result.position);pedestrianTraffic.reset();}
        const journeySample={position:result.position,yaw:value?.pose.yaw??p.yaw,moving:result.moving,blocked:null,anchorCorrected:false,yielded:result.yielded};frame.set(id,journeySample);
        const avatar=avatars.get(id);if(avatar){avatar.root.userData.homeNavigation={...journeySample,clearance:avatar.root.userData.navigationClearance,region:value?.pose.area??p.area,revision:navRevision};delete avatar.root.userData.homeNavigationRoute;}
      }
      for(const [id,p]of prepared){
        const result=resolved.get(id);if(!result)continue;
        p.state.position=result.position;if(p.walking&&result.moving)p.state.elapsed=advanceLivingNavigationPhase(p.state.route,p.state.elapsed,result.position,delta+1e-6);p.state.lastNow=now;
        p.state.waited=p.walking&&!result.moving?(p.state.waited??0)+delta:0;
        if(p.state.waited>=.9){
          const nearby=actors.filter(other=>other.id!==id&&other.region===trafficRegion(p.area)&&Math.hypot((resolved.get(other.id)?.position??other.position).x-result.position.x,(resolved.get(other.id)?.position??other.position).z-result.position.z)<p.radius+other.radius+1.2);
          const canYield=nearby.some(other=>!other.walking)||nearby.some(other=>other.id<id)||p.state.waited>=1.8;
          if(canYield){
            const avoid=nearby.map(other=>({position:resolved.get(other.id)?.position??other.position,radius:other.radius}));
            const route=p.graph.plan({anchor:result.position,id:id+':pass:'+(p.state.replans??0),avoid});
            const extent=route.safeAnchor?Math.max(...route.points.map(point=>Math.hypot(point.x-route.safeAnchor!.x,point.z-route.safeAnchor!.z))):0;
            if(!route.blocked&&route.safeAnchor&&extent>=.2&&Math.hypot(route.safeAnchor.x-result.position.x,route.safeAnchor.z-result.position.z)<1e-5){p.state.route=route;p.state.elapsed=0;p.state.replans=(p.state.replans??0)+1;resetTraffic=true;}
            p.state.waited=0;
          }
        }
        const dx=result.position.x-p.from.x,dz=result.position.z-p.from.z,previous=avatars.get(id)?.root.userData.homeNavigation;
        const yaw=Math.hypot(dx,dz)>1e-7?Math.atan2(dx,dz):(previous?.yaw??p.sample.yaw);
        const sample={...p.sample,position:result.position,yaw,moving:p.walking&&result.moving,yielded:result.yielded};
        frame.set(id,sample);const a=avatars.get(id);if(a){a.root.userData.homeNavigation={...sample,clearance:a.root.userData.navigationClearance,region:p.state.region,revision:navRevision};a.root.userData.homeNavigationRoute={key:p.state.key,elapsed:p.state.elapsed,waited:p.state.waited,replans:p.state.replans,points:p.state.route.points,length:p.state.route.length,speed:p.state.route.speed,anchor:p.state.route.safeAnchor};}
      }
      if(resetTraffic)pedestrianTraffic.reset();
      host.dataset.navigationYielding=String([...frame.values()].filter(p=>p.yielded).length);return frame;
    }
    function resetCamera(){
      if(upperFloorView&&canReferenceVilla()){const p=VILLA_UPPER_CAMERA;controls.target.set(...p.target);camera.position.set(...p.position);controls.minDistance=p.minDistance;controls.maxDistance=p.maxDistance;}
      else if(softHome&&(view==='overview'||view==='outdoor')){controls.target.set(...HOME_CARTOON_CAMERA.target);camera.position.set(...HOME_CARTOON_CAMERA.position);controls.minDistance=4;controls.maxDistance=60;}
      else if(toon&&(view==='overview'||view==='outdoor')){controls.target.set(0,1,0);camera.position.set(8,9,14);controls.minDistance=4;controls.maxDistance=40;}
      else if(gathering.scene_type==='home'){const pose=options?.realistic&&view==='indoor'?{target:[-6,1.05,-5.8] as [number,number,number],position:[-2.8,1.95,-1.3] as [number,number,number],minDistance:1.8,maxDistance:24}:options?.realistic&&view==='bedroom'?{target:[5.4,.9,-5.1] as [number,number,number],position:[9.25,1.8,-1.25] as [number,number,number],minDistance:1.8,maxDistance:24}:homeWorldCamera(view);controls.target.set(...pose.target);camera.position.set(...pose.position);controls.minDistance=pose.minDistance;controls.maxDistance=pose.maxDistance;}
      else if(canNaturalIndoor()&&(view==='indoor'||view==='bedroom')){const room=housePlan()!.bounds[view],x=(room.minX+room.maxX)/2,z=(room.minZ+room.maxZ)/2;controls.target.set(x,.85,z);camera.position.set(x+1.5,2.7,room.maxZ+3.2);controls.minDistance=1.5;controls.maxDistance=30;}
      else if(canNaturalWorld()){controls.target.set(0,.65,-1.8);camera.position.set(9.2,8.8,12.6);controls.minDistance=4.5;controls.maxDistance=34;}else{controls.target.set(0,.5,0);camera.position.set(8.7,9.1,12.1);controls.minDistance=6;controls.maxDistance=26;}
      camera.position.sub(controls.target).multiplyScalar(fitFactor).add(controls.target);updateControls();
    }
    function configureCamera(){
      camera.aspect=Math.max(1,host.clientWidth)/Math.max(1,host.clientHeight);
      const insideRoom=options?.realistic&&(gathering.scene_type==='home'||canNaturalIndoor())&&(view==='indoor'||view==='bedroom');
      camera.fov=insideRoom?52:toon||canNaturalWorld()?42:36;camera.updateProjectionMatrix();
      // Keep room close-ups inside their walls when the viewport becomes narrow.
      const nextFit=insideRoom?1:Math.min(1.55,Math.max(1,1.45/camera.aspect)),key=gathering.scene_type+'/'+view+'/'+upperFloorView;
      if(key!==cameraKey){cameraKey=key;fitFactor=nextFit;resetCamera()}else if(Math.abs(nextFit-fitFactor)>.01){camera.position.sub(controls.target).multiplyScalar(nextFit/fitFactor).add(controls.target);fitFactor=nextFit;updateControls()}
      scene.background=new T.Color(toon?TOON_SCENE.sky:canNaturalWorld()?(gathering.scene_type==='forest'?'#c4cfc8':'#d9d4c7'):canReferenceVilla()?'#ccd3d5':options?.realistic?'#cadbe6':'#d6e7dc');
      // Narrow screens move the overview camera back. Keep the same atmospheric
      // distance relative to that framing instead of washing the house out.
      scene.fog=new T.Fog(scene.background,(toon?42:gathering.scene_type==='home'?(options?.realistic?35:65):28)*fitFactor,(toon?100:gathering.scene_type==='home'?(options?.realistic?110:135):55)*fitFactor);renderer.setClearColor(scene.background,1);
      host.dataset.presentation=gathering.scene_type==='home'?'home-world':'world';host.dataset.camera='perspective';host.dataset.focusView=view;host.dataset.sceneStyle=softHome?'soft-toon':toon?'toon':'original';
      renderer.domElement.setAttribute('aria-label',gathering.scene_type==='home'?'可转动视角的连续家园，院子、客厅与卧室的伙伴同时在场':'可转动视角的立体共同生活场景');
      const shadow=gathering.scene_type==='home'?19:canNaturalWorld()?14:9;light.shadow.camera.left=-shadow;light.shadow.camera.right=shadow;light.shadow.camera.top=shadow;light.shadow.camera.bottom=-shadow;light.shadow.radius=softHome?4.5:1;light.shadow.intensity=softHome?.58:1;light.shadow.camera.updateProjectionMatrix();
    }
    function draw(){
      if(disposed||updating||drawing)return;drawing=true;try{
      if(options?.realistic&&gathering.scene_type==='home'&&houseView==='interior'&&!upperFloorView&&(view==='indoor'||view==='bedroom')){
        if(constrainRoomCamera(camera.position,controls.target,homeNavigationBounds(view))){camera.lookAt(controls.target);camera.updateMatrixWorld();}
      }
      const now=Date.now()/1000;drawDoors(now);for(const [id,source] of pendingDoorOpenings)if(!journeyDoorOccupied(id))setDoorOpen(id,true,source,false);for(const id of pendingDoorClosures)if(!journeyDoorOccupied(id)){pendingDoorClosures.delete(id);setDoorOpen(id,false);}const naturalSlots=canNaturalIndoor()?naturalHouseAssignments(gathering):null,seats:WorldRestSeat[]=naturalSlots?.seats??homeSofaSeats(gathering),beds:WorldSleepingBed[]=naturalSlots?.beds??homeSleepingBeds(gathering);
      if(naturalSlots){host.dataset.naturalIndoor='true';host.dataset.naturalCapacityBlocked=String(naturalSlots.blockedIds.length);}else{delete host.dataset.naturalIndoor;delete host.dataset.naturalCapacityBlocked;}
      const leisureFrameDelta=now-leisureLast;
      if(decoration)stepVillaUpperDoor(decoration,leisureFrameDelta,motion&&!document.hidden);
      if(motion&&(!canNaturalLeisure()||!document.hidden))leisureElapsed+=Math.min(.1,Math.max(0,leisureFrameDelta));leisureLast=now;
      const local=leisure.getSnapshot(),leisureSeats=new Map(local.assignments.flatMap(a=>{const s=leisureSeatList.find(s=>s.id===a.seatId);return s?[[a.actorId,{...s,...a,characterId:a.actorId,index:0}] as const]:[]}));
      const callArea=upperFloorView?'upper':houseView==='exterior'?'outdoor':view==='overview'?'indoor':view;
      const mahjongActors=local.assignments.filter(a=>{const avatar=avatars.get(a.actorId),seat=avatar?.root.userData.roomRestSeat;return a.activity==='mahjong'&&!!avatar?.root.visible&&seat?.seatId===a.seatId&&!journeys.get(a.actorId)?.active;}).map(a=>({actorId:a.actorId,seatId:a.seatId}));
      const gameFrame=mahjongGame.step({elapsed:leisureElapsed,moving:motion&&!document.hidden&&leisureFrameDelta>=0&&leisureFrameDelta<=.75,enabled:canPlayMahjong(),busy:lifeSpeech.getSnapshot().speaking,actors:mahjongActors}),gameState=gameFrame.snapshot;
      if(canPlayMahjong()){
        const revisionStamp=gameState.status+':'+gameState.revision;if(revisionStamp!==mahjongRevisionStamp){mahjongRevisionStamp=revisionStamp;options?.onLocalMahjongChange?.(gameState.status==='waiting'?null:gameState);}
        host.dataset.mahjongGameStatus=gameState.status;host.dataset.mahjongTurnActor=String(gameState.turnActorId??'');host.dataset.mahjongGameEvent=gameState.lastEvent?.kind??'';host.dataset.mahjongGameText=gameState.lastEvent?.kind==='draw'?'摸牌':gameState.lastEvent?.text??'';host.dataset.mahjongGamePhase=gameState.phase;
        const event=gameFrame.event;
        if(event){const assignment=local.assignments.find(a=>a.actorId===event.actorId),index=assignment?.seatId.split('-').at(-1),tile=index!==undefined?scene.getObjectByName('home-mahjong-tile-'+index):null;
          const faceReady=event.tile?!!tile?.userData.homeMahjongTile&&applyHomeMahjongFace(tile,event.tile):event.kind==='win'||event.kind==='exhausted';
          if(faceReady&&event.kind!=='draw'&&motion&&!document.hidden&&callArea==='outdoor'){
            mahjongCaption={actorId:event.actorId,text:event.text,until:leisureElapsed+1.8};
            lifeSpeech.say({key:'local-mahjong-game:'+gathering.id+':'+event.id,text:event.text,actorId:event.actorId});
          }
        }
      }else{if(mahjongRevisionStamp){mahjongRevisionStamp='';options?.onLocalMahjongChange?.(null);}host.dataset.mahjongGameStatus='disabled';delete host.dataset.mahjongTurnActor;delete host.dataset.mahjongGameEvent;delete host.dataset.mahjongGameText;delete host.dataset.mahjongGamePhase;}
      const call=mahjongCalls.step({elapsed:leisureElapsed,moving:motion&&!document.hidden,enabled:canPreviewLeisure()&&!isPersistent()&&!canPlayMahjong()&&!!options?.localSpeechClips,assignments:local.assignments,audibleIds:local.assignments.filter(a=>{const avatar=avatars.get(a.actorId);return avatar&&!journeys.get(a.actorId)?.active&&(avatar.root.userData.homePresenceArea??avatar.root.userData.homeRegion)===callArea;}).map(a=>a.actorId)});if(call){
        const assignment=local.assignments.find(a=>a.actorId===call.actorId), index=assignment?.seatId.split('-').at(-1);
        // The placement cue precedes prop release: the same tile may still be in
        // the actor's hand, outside decoration, until activityEffects.update.
        const tile=index!==undefined?scene.getObjectByName('home-mahjong-tile-'+index):null, speech=lifeSpeech.getSnapshot();
        const announcingSameActor=speech.speaking&&speech.currentCaption?.actorId===call.actorId;
        if(tile?.userData.homeMahjongTile&&!announcingSameActor&&applyHomeMahjongFace(tile,call.text)&&!speech.speaking)lifeSpeech.say(call);
      }
      const sharedGame=isPersistent()&&sharedMahjong?.gathering_id===gathering.id?sharedMahjong:null;
      const sharedAnimation=sharedMahjongAnimation(sharedGame,(sharedGame?.server_now_ms??0)+Math.max(0,Date.now()-sharedMahjongReceivedAt));
      if(sharedGame?.game){const game=sharedGame.game;host.dataset.mahjongGameStatus=game.status;host.dataset.mahjongTurnActor=String(game.turn_character_id);host.dataset.mahjongGameEvent=game.last_event?.kind??'';host.dataset.mahjongGameText=game.last_event?.kind==='draw'?'摸牌':game.last_event?.text??'';host.dataset.mahjongGamePhase=game.phase;host.dataset.mahjongAuthority='server';}
      else delete host.dataset.mahjongAuthority;
      if(sharedAnimation?.lastEvent?.tile){const actor=sharedGame?.game?.players.find(p=>p.character_id===sharedAnimation.lastEvent!.actorId),index=actor?.seat_id.split('-').at(-1),tile=index===undefined?null:scene.getObjectByName('home-mahjong-tile-'+index);if(tile?.userData.homeMahjongTile)applyHomeMahjongFace(tile,sharedAnimation.lastEvent.tile); }
      const televisionOn=canPreviewLeisure()?local.television.powered:true;
      const program=decoration?.getObjectByName('home-television-program');if(program&&!canPreviewLeisure())program.visible=televisionOn;
      const screen=decoration?.getObjectByName('home-television-screen');if(screen instanceof T.Mesh&&screen.material instanceof T.MeshStandardMaterial)screen.material.emissiveIntensity=televisionOn?.3:0;
      host.dataset.leisurePreview=[...new Set(local.assignments.map(a=>a.activity))].join(',')||'none';if(canPreviewLeisure())host.dataset.televisionOn=String(televisionOn);else delete host.dataset.televisionOn;
      const cupAssignments=canJourney()?local.assignments.filter(a=>{const avatar=avatars.get(a.actorId);return avatar?.root.userData.roomRestSeat?.seatId===a.seatId&&!journeys.get(a.actorId)?.active;}):local.assignments;
      teaCups.sync(decoration,cupAssignments,leisureSeatList,avatars);
      if(gathering.scene_type==='home'||canNaturalIndoor()){host.dataset.houseView=houseView;host.dataset.houseStyle=canNaturalIndoor()?gathering.scene_type+'-house':canReferenceVilla()?'reference-villa':'farmhouse';}else{delete host.dataset.houseView;delete host.dataset.houseStyle;}
      const seated=new Map<number,WorldRestSeat>(seats.map(s=>[s.characterId,s])),sleeping=new Map<number,WorldSleepingBed>(beds.map(b=>[b.characterId,b]));let navBlocked=0,navCorrected=0;
      restoreFloorLife();const navigationFrame=navigateHomeFrame(now,seated,sleeping,leisureSeats);
      for(const visit of villaVisit.snapshots())if(!avatars.has(visit.id)||!gathering.companions.some(c=>c.id===visit.id))villaVisit.remove(visit.id);
      const boarding=villaVisit.snapshot();if((!isPersistent()||floorDriver)&&boarding?.phase==='approach'&&!journeys.get(boarding.id)?.active){const a=avatars.get(boarding.id),arrived=journeys.get(boarding.id);if(a&&arrived?.targetKey==='villa-stair-boarding')villaVisit.board(boarding.id,arrived.pose,arrived.pose.yaw);}
      villaVisit.step(navigationDelta,motion&&!document.hidden&&(!isPersistent()||floorDriver),(visit,from,to)=>{
        const {id,radius}=visit;if(to.y>3.4&&to.x<.1){const upper=decoration?.getObjectByName('home-villa-upper-interior');if((upper?.userData.door?.progress??0)<.999)return false;}
        if(from.blend>0||to.blend>0){const a=avatars.get(id);if(!a)return false;const pose=(p:typeof from)=>({...p,area:'bedroom' as const,contact:visit.activity==='sleep'?'sleep' as const:'rest' as const});if(!contactCollision.isClear(a,decoration,null,pose(from),pose(to),from.blend,to.blend,visit.support,false,visit.activity==='sleep'?'sleep':'television',Number(a.root.userData.upperBedLegLift??0))){host.dataset.upperContactBlocked=JSON.stringify(contactCollision.getLastCollision());return false;}}

        for(const [peerId,peer]of avatars){if(peerId===id||!peer.root.visible||Math.abs(peer.root.position.y-to.y)>2.3)continue;const gap=radius+Number(peer.root.userData.navigationClearance??1);if(Math.hypot(peer.root.position.x-to.x,peer.root.position.z-to.z)<gap)return false;}return true;
      });
      const stairSummary=villaVisit.snapshot();host.dataset.stairVisit=stairSummary?.phase??'idle';host.dataset.stairActor=stairSummary?String(stairSummary.id):'';const floorPresence=stairSummary?{id:stairSummary.id,phase:stairSummary.phase,floor:stairSummary.pose.y>3.4?2:1}:null,floorLife=villaVisit.snapshots().map(s=>({id:s.id,phase:s.phase,floor:s.pose.y>3.4?2:1,activity:s.activity})),fs=JSON.stringify(floorLife);if(fs!==floorVisitStamp){floorVisitStamp=fs;options?.onFloorVisitChange?.(floorPresence);options?.onFloorLifeChange?.(floorLife);}
      if(canNaturalIndoor()&&decoration)applyNaturalHouseView(decoration,houseView,camera.position);
      if(gathering.scene_type==='home'&&decoration){applyHomeWorldArchitectureView(decoration,houseView,camera.position);applyVillaUpperView(decoration,upperFloorView,camera.position,houseView==='exterior');if(softHome)applySoftCottageView(decoration,houseView==='exterior',upperFloorView);}
      // Paused view changes still need the current camera transform before projecting labels.
      if(softHome)camera.updateMatrixWorld(true);
      let architectureQuery:ReturnType<typeof prepareArchitectureOcclusion>|undefined;
      const architectureBlocks=(to:T.Vector3)=>(architectureQuery??=prepareArchitectureOcclusion(camera.position,architectureOccluders))(to);
      const socialReady=(slot:NonNullable<ReturnType<SocialPlan['get']>>)=>socialGroupReady(slot,socialPlan,id=>{const a=avatars.get(id);return a?{x:a.root.position.x,z:a.root.position.z,area:String(a.root.userData.homePresenceArea??a.root.userData.homeRegion??''),moving:!!journeys.get(id)?.active,upstairs:floorBusy(id)}:null;})&&(!(slot.stationary||slot.sightRequired)||socialEyeLineClear(slot.members[0],slot.members[1]));
      const realSocialSpeaking=[...socialPlan.keys()].some(id=>!!livingBubble(gathering,id,now,motion,replayAt,bubbleReceipts));
      lifeSpeech.retain(caption=>{
        if(gathering.closed||!gathering.members.some(m=>m.id===gathering.me)||!gathering.companions.some(c=>c.id===caption.actorId))return false;
        if(caption.key.startsWith('preset-social:')){const slot=socialPlan.get(caption.actorId);return !!slot&&socialReady(slot)&&!realSocialSpeaking&&socialGatheringTurn(gathering,slot,now)?.key===caption.key;}
        if(caption.key.startsWith('[')){
          try{const key:unknown=JSON.parse(caption.key);return Array.isArray(key)&&key.length===5&&(key[4]===null||typeof key[4]==='number'&&Number.isFinite(key[4]))&&key[0]===gathering.id&&key[2]===caption.actorId&&typeof key[1]==='string'&&isLivingConversationCaptionValid(gathering,caption.actorId,key[1],key[4]!==null);}
          catch{return false;}
        }
        return true;
      });
      const visibleLabels:LivingLabelAnchor[]=[];
      for(const[id,a]of avatars){
        const previousGroundYaw=a.root.rotation.y;
        const pose=sampleLivingPose(gathering,id,canNaturalLeisure()?naturalPoseEpoch+leisureElapsed:now,motion);if(!pose){a.root.visible=false;a.label.hidden=true;continue}a.root.visible=true;a.body.position.y=.75;a.root.userData.visualGroundLift=0;
        const stairFrame=villaVisit.snapshot(id),stairActive=!!stairFrame&&stairFrame.phase!=='approach'&&!(stairFrame.phase==='queued'&&stairFrame.direction==='up'&&stairFrame.distance===0);
        const journeyValue=canJourney()&&!stairActive?journeys.get(id):null,journey=journeyValue?.active?journeyValue:null;
        const leisure=stairActive?undefined:leisureSeats.get(id),gesture=!journey&&leisure?sampleHomeLeisurePose(leisure.activity,Math.max(0,leisureElapsed-leisure.startedAtElapsed),id):null,seat=journey||stairActive?undefined:leisure??seated.get(id),bed=journey||leisure||stairActive?undefined:sleeping.get(id);a.root.scale.copy(a.baseScale).multiplyScalar(seat||bed?.9:1);
        const ambience=sampleHomeAmbience(bed?'sleep':leisure?.activity??'observe',leisureElapsed,id);const breathing=1+(motion&&(seat||bed)?(bed?ambience.sleep.breath:Math.sin(leisureElapsed*1.6+id))*.008:0),bedPose=bed?computeLivingBedPose(a.sleepSupport,a.root.scale,breathing):null;setLivingSleepSupport(a.sleepSupport,!!bed,bedPose);
        a.root.rotation.set(0,pose.yaw,0);a.root.position.set(pose.x,pose.y,pose.z);
        if(seat){a.root.position.set(seat.x,seat.y-a.seatHeight*a.root.scale.y,seat.z);a.root.rotation.y=leisure?.yaw??seat.yaw??0;a.root.userData.roomRestSeat=seat;}else delete a.root.userData.roomRestSeat;
        if(bed&&bedPose){a.root.rotation.set(bedPose.rotationX,0,0);a.root.position.set(bed.x,bed.y+bedPose.rootOffsetY,bed.z-bed.length*.33+bedPose.headOffsetZ+Number(a.root.userData.sleepContactOffset??0));a.root.userData.sleepingBed=bed;a.root.userData.sleepMattressY=bed.y;}else{delete a.root.userData.sleepingBed;delete a.root.userData.sleepMattressY;}
        const companion=gathering.companions.find(c=>c.id===id)!;if(canNaturalIndoor()&&!seat&&!bed){pose.rest=false;pose.lean=0;}
        const calmObserver=companion.activity==='observe'&&!journey&&!seat&&!bed&&(gathering.scene_type==='home'||canNaturalWorld());
        if(calmObserver){
          // Observing is a quiet standing activity, not a repeated whole-body
          // turn. Use the physical navigation facing once and a bounded local
          // animation clock, so wall-clock jumps cannot shake the avatar.
          const facing=navigationFrame.get(id)?.yaw??Number(a.root.userData.observeFacing??0);a.root.userData.observeFacing=facing;
          a.root.rotation.y=facing+(motion?Math.sin(leisureElapsed*.12+id*.71)*.06:0);
          pose.lean=motion?Math.sin(leisureElapsed*.7+id*.71)*.006:0;pose.stride=0;pose.arm=0;
        }
        if(!journey&&((gathering.scene_type!=='home'&&!canNaturalWorld())||companion.activity!=='walk'||seat||bed))walkAnimation.reset(id);
        if(gathering.scene_type==='home'||canNaturalIndoor()){
          const region=leisure?leisure.area:areaFor(companion),position=leisure?{x:a.root.position.x,y:a.root.position.y,z:a.root.position.z}:navigationWorldPoint(region,a.root.position);
          if(journey){
            const jp=journey.pose,nav=navigationFrame.get(id),portal=!!a.root.userData.journeyPortal,sleepTransfer=jp.contact==='sleep'&&jp.bedSeat!==undefined;
            const gait=walkAnimation.sample(id,{position:{x:jp.x,z:jp.z},targetYaw:nav?.yaw??jp.yaw,delta:navigationDelta,moving:!!nav?.moving&&!journey.contactBlend&&jp.bedSeat===undefined,active:true});
            const mahjongTransfer=(journey.phase==='dock'||journey.phase==='undock')&&((journey.phase==='undock'?a.root.userData.journeyPreviousSupport:a.root.userData.journeyCurrentSupport) as string[]|undefined)?.some(name=>/^home-mahjong-chair-\d$/.test(name));
            a.root.scale.copy(a.baseScale).multiplyScalar(jp.scale);a.root.rotation.set(jp.tilt,journey.contactBlend||mahjongTransfer||sleepTransfer?jp.yaw:gait.yaw,0);position.x=jp.x;position.y=jp.y+(journey.contactBlend||mahjongTransfer||sleepTransfer?0:gait.bob)+(!canNaturalIndoor()&&a.root.userData.journeyPortal==='home-main-entry-door'?Math.min(T.MathUtils.smoothstep(jp.z,-1,-.65),1-T.MathUtils.smoothstep(jp.z,.87,1.2))*.06:0);position.z=jp.z;a.root.userData.visualGroundLift=position.y-jp.y;
            pose.stride=sleepTransfer?0:gait.stride;pose.arm=portal||sleepTransfer?0:gait.arm;pose.lean=portal||sleepTransfer?0:gait.lean;
            a.root.userData.homeRegion=jp.area;delete a.root.userData.roomRestSeat;delete a.root.userData.sleepingBed;
          }else if(!seat&&!bed){const nav=navigationFrame.get(id);if(nav){a.root.userData.homeNavigation={...nav,clearance:a.root.userData.navigationClearance,region,revision:navRevision};if(nav.anchorCorrected)navCorrected++;if(nav.blocked&&companion.activity==='walk')navBlocked++;if(!nav.position){walkAnimation.reset(id);a.root.visible=false;a.label.hidden=true;continue;}position.x=nav.position.x;position.z=nav.position.z;if(companion.activity==='walk'){const gait=walkAnimation.sample(id,{position:nav.position,targetYaw:nav.yaw,delta:navigationDelta,moving:nav.moving,active:true});a.root.rotation.y=gait.yaw;pose.stride=gait.stride;pose.arm=gait.arm;pose.lean=gait.lean;position.y=gait.bob;a.root.userData.visualGroundLift=gait.bob;}}}
          else{navStates.delete(id);delete a.root.userData.homeNavigation;}
          a.root.position.set(position.x,position.y,position.z);
          const portal=a.root.userData.journeyPortal;
          a.root.userData.homeRegion=journey?.pose.area??region;
          const naturalDoor=canNaturalIndoor()?housePlan()?.doors.find(d=>d.id===portal):null;
          a.root.userData.homePresenceArea=journey&&naturalDoor?(portal==='home-main-entry-door'?(journey.pose.z<naturalDoor.z?'indoor':'outdoor'):(journey.pose.x>naturalDoor.x?'bedroom':'indoor')):journey?(portal==='home-main-entry-door'?(journey.pose.z<-.15?'indoor':'outdoor'):portal==='home-room-connection-door'?(journey.pose.x>0?'bedroom':'indoor'):journey.pose.area):region;
        }else{delete a.root.userData.homeRegion;delete a.root.userData.homePresenceArea;delete a.root.userData.homeNavigation;delete a.root.userData.homeJourney;delete a.root.userData.journeyPortal;delete a.root.userData.visualGroundLift;
          if(canNaturalWorld()){const nav=navigationFrame.get(id);if(nav){a.root.userData.homeNavigation={...nav,clearance:a.root.userData.navigationClearance,region:'outdoor',revision:navRevision};if(nav.anchorCorrected)navCorrected++;if(nav.blocked&&companion.activity==='walk')navBlocked++;if(!nav.position){walkAnimation.reset(id);a.root.visible=false;a.label.hidden=true;continue;}a.root.position.x=nav.position.x;a.root.position.z=nav.position.z;a.root.position.y=0;if(companion.activity==='walk'){const gait=walkAnimation.sample(id,{position:nav.position,targetYaw:nav.yaw,delta:navigationDelta,moving:nav.moving,active:true});a.root.rotation.y=gait.yaw;a.root.position.y=gait.bob;pose.stride=gait.stride;pose.arm=gait.arm;pose.lean=gait.lean;a.root.userData.visualGroundLift=gait.bob;}}}
        }
        const socialSlot=socialPlan.get(id),socialArrived=!!socialSlot&&!journey&&!seat&&!bed&&socialReady(socialSlot);
        const ownSocialArrival=!!socialSlot&&!journey&&!seat&&!bed&&!floorBusy(id)&&a.root.userData.homePresenceArea===socialSlot.area&&Math.hypot(a.root.position.x-socialSlot.position.x,a.root.position.z-socialSlot.position.z)<.24;
        a.root.userData.socialGathering=socialSlot?{group:socialSlot.group,target:socialSlot.position,center:socialSlot.center,ready:socialArrived,personallyArrived:ownSocialArrival}:null;
        if(companion.activity==='talk'&&!seat&&!bed&&!stairActive){
          if(!journey){
            // Keep one continuous physical heading while waiting. Group readiness
            // controls conversation, not whether an already-arrived body faces its peers.
            const previous=Number(a.root.userData.socialFacing??previousGroundYaw),target=ownSocialArrival?socialSlot!.yaw:previous;
            const angle=Math.atan2(Math.sin(target-previous),Math.cos(target-previous));
            const facing=previous+Math.sign(angle)*Math.min(Math.abs(angle),navigationDelta*2.4);
            a.root.userData.socialFacing=facing;a.root.rotation.y=facing;
            const turn=socialArrived?socialGatheringTurn(gathering,socialSlot!,now):null;
            pose.arm=motion&&turn?.actorId===id?Math.sin(leisureElapsed*2)*.12:0;pose.lean=0;pose.stride=0;
          }else delete a.root.userData.socialFacing;
          // Entering/leaving a route must not snap to the gait sampler's first yaw.
          const change=Math.atan2(Math.sin(a.root.rotation.y-previousGroundYaw),Math.cos(a.root.rotation.y-previousGroundYaw));
          a.root.rotation.y=previousGroundYaw+Math.max(-navigationDelta*3.6,Math.min(navigationDelta*3.6,change));
        }else delete a.root.userData.socialFacing;
        a.body.rotation.set(bed||seat?0:pose.rest?-.08:0,0,bed||seat?0:pose.lean);
        a.body.scale.z=bedPose?.breathing??(calmObserver&&motion?1+Math.sin(leisureElapsed*1.6+id*.71)*.003:breathing);
        a.body.position.z=bedPose?.bodyOffsetZ??0;
        const mahjongLegs=!!(leisure?.activity==='mahjong'||journey&&((journey.phase==='undock'?a.root.userData.journeyPreviousSupport:a.root.userData.journeyCurrentSupport) as string[]|undefined)?.some(name=>/^home-mahjong-chair-\d$/.test(name)));
        a.leftLeg.position.y=a.rightLeg.position.y=seat?(mahjongLegs?mahjongContactLegPose(a.seatHeight,1,a.baseScale.y*.9).y:a.seatHeight+.06):.30;
        a.leftLeg.position.z=a.rightLeg.position.z=seat?(mahjongLegs?mahjongContactLegPose(a.seatHeight,1,a.baseScale.y*.9).z:.06):bedPose?(bedPose.legOffsetZ+Number(a.root.userData.sleepLegLift??0)):0;
        a.leftLeg.rotation.x=seat?-1.15:bed?0:pose.rest?-.55:pose.stride;a.rightLeg.rotation.x=seat?-1.15:bed?0:pose.rest?-.55:-pose.stride;
        a.leftKnee.rotation.x=a.rightKnee.rotation.x=seat?1.15:0;
        a.rightArm.scale.set(1,1,1);a.leftArm.rotation.x=gesture?.leftArmX??(seat?-.35:0);a.rightArm.rotation.x=gesture?.rightArmX??(seat?-.35:0);
        a.leftArm.rotation.z=gesture?.leftArmZ??(pose.rest?-.12:pose.arm);a.rightArm.rotation.z=gesture?.rightArmZ??(pose.rest?.12:-pose.arm);
        if(journey){
          const blend=journey.contactBlend,contact=journey.pose.contact;
          a.body.rotation.set(0,0,blend?0:pose.lean);a.body.position.z=0;a.body.scale.z=1;
          a.leftArm.rotation.x=a.rightArm.rotation.x=contact==='rest'?-.35*blend:0;
          a.leftArm.rotation.z=mahjongLegs?0:pose.arm*(1-blend);a.rightArm.rotation.z=mahjongLegs?0:-pose.arm*(1-blend);
          a.leftLeg.position.y=a.rightLeg.position.y=mahjongLegs?mahjongContactLegPose(a.seatHeight,contact==='rest'?blend:0,a.baseScale.y*.9).y:T.MathUtils.lerp(.3,a.seatHeight+.06,contact==='rest'?blend:0);
          a.leftLeg.position.z=a.rightLeg.position.z=mahjongLegs?mahjongContactLegPose(a.seatHeight,contact==='rest'?blend:0,a.baseScale.y*.9).z:contact==='rest'?.06*blend:0;
          a.leftLeg.rotation.x=T.MathUtils.lerp(pose.stride,contact==='rest'?-1.15:0,blend);a.rightLeg.rotation.x=T.MathUtils.lerp(-pose.stride,contact==='rest'?-1.15:0,blend);
          a.leftKnee.rotation.x=a.rightKnee.rotation.x=contact==='rest'?1.15*blend:0;
          if(contact==='sleep'){const breath=journey.pose.bedBreathing??1,support=computeLivingBedPose(a.sleepSupport,a.baseScale.clone().multiplyScalar(.9),breath),seat=journey.pose.bedSeat??0;a.body.scale.z=breath;a.leftLeg.position.y=a.rightLeg.position.y=T.MathUtils.lerp(.3,a.seatHeight+.06,seat);a.leftLeg.position.z=a.rightLeg.position.z=((support?.legOffsetZ??0)+(journey.pose.bedLegLift??0))*blend+.06*seat;a.leftLeg.rotation.x=a.rightLeg.rotation.x=-1.15*seat;a.leftKnee.rotation.x=a.rightKnee.rotation.x=1.15*seat;for(const adjustment of support?.adjustments??[])adjustment.part.position.z=T.MathUtils.lerp(adjustment.awakeZ,adjustment.asleepZ,blend);}
        }
        a.eyes.scale.y=journey?journey.pose.contact==='sleep'&&journey.contactBlend>.7?.12:1:leisure?1:pose.rest||pose.blink?.12:1;a.ring.visible=focused===id&&!bed;a.ring.position.y=seat?a.seatHeight+.015:.03;
        if(stairActive&&stairFrame){
          const p=stairFrame.pose,gait=walkAnimation.sample(id,{position:p,targetYaw:stairFrame.pose.yaw,delta:navigationDelta,moving:stairFrame.phase==='walking',active:true});
          a.root.scale.copy(a.baseScale).multiplyScalar(p.scale);a.root.position.set(p.x,p.y,p.z);a.root.rotation.set(p.tilt,p.yaw,0);
          a.body.rotation.set(0,0,0);a.body.position.set(0,.75,0);a.body.scale.z=1;setLivingSleepSupport(a.sleepSupport,false,null);
          for(const leg of [a.leftLeg,a.rightLeg]){leg.position.y=.3;leg.position.z=0;}a.leftLeg.rotation.x=gait.stride;a.rightLeg.rotation.x=-gait.stride;a.leftKnee.rotation.x=a.rightKnee.rotation.x=0;if(!p.blend)supportVillaStairFeet(a.root,[a.leftLeg,a.rightLeg],[a.leftKnee,a.rightKnee]);
          a.leftArm.rotation.set(0,0,0);a.rightArm.rotation.set(0,0,0);a.eyes.scale.y=1;
          if(p.blend>0){const blend=p.blend;if(stairFrame.activity==='rest'){a.leftLeg.position.y=a.rightLeg.position.y=T.MathUtils.lerp(.3,a.seatHeight+.06,blend);a.leftLeg.position.z=a.rightLeg.position.z=.06*blend;a.leftLeg.rotation.x=a.rightLeg.rotation.x=-1.15*blend;a.leftKnee.rotation.x=a.rightKnee.rotation.x=1.15*blend;a.leftArm.rotation.x=a.rightArm.rotation.x=-.35*blend;}else if(stairFrame.activity==='sleep'){const bp=computeLivingBedPose(a.sleepSupport,a.baseScale.clone().multiplyScalar(.9),1);a.leftLeg.position.y=a.rightLeg.position.y=.3;a.leftLeg.position.z=a.rightLeg.position.z=((bp?.legOffsetZ??0)+Number(a.root.userData.upperBedLegLift??0))*blend;a.leftLeg.rotation.x=a.rightLeg.rotation.x=a.leftKnee.rotation.x=a.rightKnee.rotation.x=0;for(const adjustment of bp?.adjustments??[])adjustment.part.position.z=T.MathUtils.lerp(adjustment.awakeZ,adjustment.asleepZ,blend);a.eyes.scale.y=blend>.7?.12:1;}}

          a.root.userData.homeFloor=p.y>3.4?2:1;a.root.userData.homePresenceArea=p.y>3.4?'upper':'bedroom';a.root.userData.homeRegion='bedroom';a.root.userData.villaStairPhase=stairFrame.phase;
          delete a.root.userData.roomRestSeat;delete a.root.userData.sleepingBed;
        }else{delete a.root.userData.villaStairPhase;a.root.userData.homeFloor=1;}
        updateCourtyardFigure(a,{id:companion.id,portrait:companion.portrait,courtyard_figure:companion.courtyard_figure==='ready'||companion.courtyard_figure==='pending'||companion.courtyard_figure==='failed'?companion.courtyard_figure:undefined},camera,now,motion,gathering.scene_type,draw,toon);const point=a.root.localToWorld(new T.Vector3(0,bed?1.35:softHome?(SCENE_SCALE.companionHeight+.15)/Math.max(.001,a.root.scale.y):toon && !['indoor','bedroom'].includes(String(a.root.userData.homeRegion))?1.65*TOON_SCENE.companionScale:1.65,bed?.4:0)).project(camera);
        a.label.style.transform='translate('+((point.x*.5+.5)*host.clientWidth).toFixed(1)+'px,'+((-point.y*.5+.5)*host.clientHeight).toFixed(1)+'px) translate(-50%,-100%)';
        const shellCovered=!stairActive&&(gathering.scene_type==='home'||canNaturalIndoor())&&houseView==='exterior'&&(canJourney()?a.root.userData.homePresenceArea:a.root.userData.homeRegion)!=='outdoor';
        const floorCovered=softHome&&homeFloorCovered(a.root.userData.homeFloor,upperFloorView);
        if(softHome)setHomeActorCutaway(a.root,shellCovered||floorCovered);
        let bubble=shellCovered?null:livingBubble(gathering,id,now,motion,replayAt,bubbleReceipts);
        const preset=!shellCovered&&motion&&!document.hidden&&!realSocialSpeaking&&socialArrived&&socialSlot?socialGatheringTurn(gathering,socialSlot,now):null;
        if(!bubble&&preset?.actorId===id)bubble={kind:'preset',text:preset.text};
        const wantsName=focused===id||avatars.size<=5;
        const captionActor=lifeSpeech.getSnapshot().currentCaption?.actorId;
        const needsCaption=captionActor===id||mahjongCaption?.actorId===id&&leisureElapsed<mahjongCaption.until;
        const occluded=!shellCovered&&(wantsName||!!bubble||needsCaption||menuCharacter===id)&&architectureBlocks(a.body.getWorldPosition(new T.Vector3()));
        a.label.dataset.occluded=String(occluded);
        const covered=shellCovered||floorCovered||occluded;if(covered)bubble=null;const nameVisible=!covered&&wantsName;
        const speechArea=canJourney()?(a.root.userData.homePresenceArea??a.root.userData.homeRegion):gatheringCompanionArea(gathering,gathering.companions.find(c=>c.id===id)!);const hearingArea=houseView==='exterior'?'outdoor':view==='overview'?'indoor':view;
        if(canPreviewLeisure()&&motion&&!document.hidden&&!upperFloorView&&!covered&&speechArea===hearingArea){
          if(bubble?.kind==='preset'&&preset&&point.z<=1&&point.z>=-1)lifeSpeech.say({key:preset.key,text:preset.text,actorId:id});
          if(bubble&&bubble.kind!=='preset'&&point.z<=1&&point.z>=-1){const event=[...gathering.events].reverse().find(e=>e.kind==='dialogue'&&e.lines?.some(l=>l.character_id===id&&l.text===bubble?.text));lifeSpeech.say({key:JSON.stringify([gathering.id,event?.id??'caption',id,bubble.text,replayAt]),text:bubble.text,actorId:id});}
          if((canPlayMahjong()||isPersistent())&&mahjongCaption&&leisureElapsed<mahjongCaption.until)bubble=mahjongCaption.actorId===id?{kind:'dialogue',text:mahjongCaption.text}:null;
          const speaking=lifeSpeech.getSnapshot().currentCaption;if(speaking)bubble=speaking.actorId===id?{kind:speaking.key.startsWith('preset-social:')?'preset':'dialogue',text:speaking.text}:null;
        }
        a.nameLabel.hidden=!nameVisible;a.bubble.hidden=!bubble;
        if(bubble){if(a.bubbleText.textContent!==bubble.text)a.bubbleText.textContent=bubble.text;a.bubble.dataset.kind=bubble.kind;}
        a.label.hidden=covered||point.z>1||point.z< -1||(!nameVisible&&!bubble);
        if(!a.label.hidden&&(!upperFloorView||a.root.userData.homeFloor===2)){
          const width=a.label.offsetWidth,height=a.label.offsetHeight;
          if(width>0&&height>0)visibleLabels.push({id,x:(point.x*.5+.5)*host.clientWidth,y:(-point.y*.5+.5)*host.clientHeight,width,height});
        }
      }
      for(const p of layoutLivingLabels(visibleLabels,host.clientWidth,host.clientHeight))avatars.get(p.id)!.label.style.transform=`translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) translate(-50%,-100%)`;
      host.dataset.navigationBlocked=String(navBlocked);host.dataset.navigationCorrected=String(navCorrected);host.dataset.navigationRevision=String(navRevision);navNotice.hidden=navBlocked===0;navNotice.textContent=navBlocked?'散步空间不足，伙伴暂时停下。可调整布置后再试。':'';
      if(canJourney()){const all=gathering.companions.map(c=>journeys.get(c.id)).filter(f=>f?.active),waiting=all.filter(f=>f?.phase==='wait-door'),blocked=all.filter(f=>f?.phase==='blocked'),trafficWaiting=[...avatars.values()].some(a=>a.root.userData.homeJourney?.waitingForClearance);host.dataset.journeyActive=String(all.length);host.dataset.journeyWaiting=String(waiting.length);if(waiting.length){navNotice.hidden=false;navNotice.textContent=waiting.some(frame=>frame?.waitingFor&&doors[frame.waitingFor].open&&doors[frame.waitingFor].progress>=.999)?'门边的通道暂时被挡住，伙伴正在安全等候。请留出通行空间。':'伙伴在门前等候，门打开后会继续走。';}else if(blocked.length||trafficWaiting){navNotice.hidden=false;navNotice.textContent='前面的空间暂时走不过去，伙伴已停在安全位置。';}}
      if(selectionMenu&&selectionMenuPlacement==='panel')selectionMenu.hidden=false;
      if(selectionMenu&&selectionMenuPlacement==='anchor'){
        const avatar=menuCharacter===null?undefined:avatars.get(menuCharacter);
        const target=gathering.companions.find(c=>c.id===menuCharacter),covered=!!avatar&&architectureBlocks(avatar.body.getWorldPosition(new T.Vector3()))||target&&(gathering.scene_type==='home'||canNaturalIndoor())&&houseView==='exterior'&&(canJourney()?avatar?.root.userData.homePresenceArea:leisureSeats.get(target.id)?.area??gatheringCompanionArea(gathering,target))!=='outdoor';
        if(covered)selectionMenu.hidden=true;
        else if(avatar){const point=avatar.root.localToWorld(new T.Vector3(0,1.65,0)).project(camera);const width=selectionMenu.offsetWidth||220,height=selectionMenu.offsetHeight||230;const x=(point.x*.5+.5)*host.clientWidth,y=(-point.y*.5+.5)*host.clientHeight;selectionMenu.hidden=point.z>1||point.z< -1;selectionMenu.style.left=T.MathUtils.clamp(x,width/2+10,Math.max(width/2+10,host.clientWidth-width/2-10))+'px';selectionMenu.style.top=T.MathUtils.clamp(y+12,12,Math.max(12,host.clientHeight-height-12))+'px';}
        else{selectionMenu.hidden=false;selectionMenu.style.left='50%';selectionMenu.style.top='80px';}
      }
      if(canNaturalWorld()){host.dataset.naturalWorld=gathering.scene_type;host.dataset.naturalObstacleCount=String(navObstacles.length);}else{delete host.dataset.naturalWorld;delete host.dataset.naturalObstacleCount;}
      const textureStatus=decoration?.userData.homeTextureStatus;
      if(textureStatus){host.dataset.texturePending=String(textureStatus.pending);host.dataset.textureLoaded=String(textureStatus.loaded);host.dataset.textureFailed=String(textureStatus.failed);host.dataset.materialMode=decoration?.userData.homeMaterialMode;}else{for(const key of ['texturePending','textureLoaded','textureFailed','materialMode'])delete host.dataset[key];}
      for(const o of animatedEnvironmentNodes){
        const normal=o.userData.wallNormal;if(gathering.scene_type!=='home'&&!o.userData.architectureManaged&&Array.isArray(normal)){const toward=camera.position.clone().sub(o.getWorldPosition(new T.Vector3()));o.visible=normal[0]*toward.x+normal[1]*toward.z<.2;}
        const kind=o.userData.localMotion;if(!kind)continue;
        if(o.userData.motionBase===undefined)o.userData.motionBase={z:o.rotation.z,y:o.scale.y};
        const base=o.userData.motionBase;
        const environmentalNow=canNaturalLeisure()?naturalPoseEpoch+leisureElapsed:now;
        if(kind==='leaf')o.rotation.z=base.z+((canNaturalLeisure()||motion)?Math.sin(environmentalNow*.8+o.id)*.018:0);
        else if(kind==='fire')o.scale.y=base.y*(1+((canNaturalLeisure()||motion)?Math.sin(environmentalNow*5+o.id)*.08:0));
      }
      teaCups.orient(avatars,local.assignments,leisureElapsed);if(canLocalLeisure()){activityEffects?.update(decoration,avatars,canJourney()?{...local,assignments:local.assignments.filter(a=>avatars.get(a.actorId)?.root.userData.roomRestSeat?.seatId===a.seatId&&!journeys.get(a.actorId)?.active)}:local,leisureSeatList,leisureElapsed,sharedAnimation??(isPersistent()||canPlayMahjong()?gameState:undefined));
        // Laughing may lean or bounce the torso, but the actual cushion still
        // supports its lowest mesh. Do not let that visual gesture sink a seated
        // body into the sofa or alter its root/seat/standing collision radius.
        if(canJourney())for(const assignment of local.assignments){
          if(assignment.activity!=='television'||journeys.get(assignment.actorId)?.active)continue;
          const avatar=avatars.get(assignment.actorId),seat=leisureSeatList.find(seat=>seat.id===assignment.seatId);if(!avatar||!seat||avatar.root.userData.roomRestSeat?.seatId!==assignment.seatId)continue;
          avatar.body.updateWorldMatrix(true,true);const bottom=new T.Box3().setFromObject(avatar.body,true).min.y,correction=seat.y-bottom;
          if(correction>1e-6)avatar.body.position.y+=correction/Math.max(.001,avatar.root.scale.y);
        }
        if(canPreviewLeisure()){const remote=activityEffects?.getTelevisionRemote()??{heldByActorId:null,buttonPressed:false};
        const television=televisionChannels.step({elapsed:leisureElapsed,moving:motion&&!document.hidden&&leisureFrameDelta>=0&&leisureFrameDelta<=.75,powered:televisionOn,remote});
        televisionPrograms.update(decoration,{channel:television.channel,powered:televisionOn,elapsed:television.elapsed});
        host.dataset.televisionChannel=String(television.channel);host.dataset.televisionProgram=television.name;host.dataset.televisionProgramFrame=String(televisionPrograms.getSnapshot().frame);host.dataset.televisionRemoteOwner=String(remote.heldByActorId??'none');host.dataset.televisionRemotePressed=String(remote.buttonPressed);
        for(let index=0;index<4;index++){const tile=scene.getObjectByName('home-mahjong-tile-'+index);if(tile?.userData.homeMahjongTile)setHomeMahjongFaceExposed(tile,isPersistent()?!!sharedAnimation?.lastEvent?.tile&&sharedAnimation.phase==='discard'&&sharedAnimation.phaseProgress>=.6:!canPlayMahjong()||gameState.status==='won'||(gameState.phase==='discard'&&gameState.phaseProgress>=.6));}if(isPersistent())mahjongGameView.updatePublic(decoration,sharedGame,sharedAnimation?.phaseProgress??1);else if(canPlayMahjong())mahjongGameView.update(decoration,gameState);if(motion&&!document.hidden&&!upperFloorView){const listenerArea=houseView==='exterior'?'outdoor':view==='overview'?'indoor':view;if(canQuietAudio())lifeAudio.pause();else lifeAudio.tick(leisureElapsed,gathering.companions.map(c=>{const avatar=avatars.get(c.id),assignment=local.assignments.find(a=>a.actorId===c.id),journey=journeys.get(c.id);const area=canJourney()?(avatar?.root.userData.homePresenceArea??avatar?.root.userData.homeRegion??gatheringCompanionArea(gathering,c)):(assignment?.activity==='television'?'indoor':assignment?'outdoor':gatheringCompanionArea(gathering,c));const old=audioPositions.get(c.id),position=avatar?.root.position;const moving=!!(old&&position&&Math.hypot(position.x-old.x,position.z-old.z)>.001);if(position)audioPositions.set(c.id,{x:position.x,z:position.z});return{actorId:c.id,activity:journey?.active?'walk':assignment?.activity??c.activity,startedAtElapsed:assignment?.startedAtElapsed,moving,audible:!!avatar&&(assignment?.activity!=='television'||local.television.powered)&&area===listenerArea};}),listenerArea);host.dataset.lifeAudioArea=listenerArea;}else silenceLifeAudio();const audioState=lifeAudio.getSnapshot();host.dataset.lifeAudioEnabled=String(canQuietAudio()?lifeSpeech.getSnapshot().enabled:audioState.enabled);host.dataset.lifeAudioVoices=String(audioState.activeVoices);const speechState=lifeSpeech.getSnapshot();host.dataset.lifeSpeechStatus=speechState.status;host.dataset.lifeSpeechVoice=speechState.voiceName??'';host.dataset.lifeSpeechPaused=String(speechState.clipPlayback?.paused??true);host.dataset.lifeSpeechTime=String(speechState.clipPlayback?.currentTime??0);host.dataset.lifeSpeechDuration=String(speechState.clipPlayback?.duration??'');host.dataset.lifeSpeechError=speechState.lastPlayError??'';const statusStamp=JSON.stringify([speechState.status,speechState.available,speechState.voiceName]);if(statusStamp!==speechStatusStamp){speechStatusStamp=statusStamp;options?.onSpeechChange?.(speechState);}}}for(const a of avatars.values())a.label.style.display=upperFloorView&&a.root.userData.homeFloor!==2?'none':'';const returned=villaVisit.releaseReturned();if(returned!==null){journeys.remove(returned);navStates.delete(returned);walkAnimation.reset(returned);}saveFloorLife(); host.dataset.upperFloorView=String(upperFloorView);host.dataset.seatedCharacters=String(seats.filter(s=>!leisureSeats.has(s.characterId)&&!(canJourney()&&journeys.get(s.characterId)?.active)).length+[...leisureSeats.keys()].filter(id=>!(canJourney()&&journeys.get(id)?.active)).length);host.dataset.sleepingCharacters=String(beds.filter(b=>!leisureSeats.has(b.characterId)&&!(canJourney()&&journeys.get(b.characterId)?.active)).length);updateCompanionDoors();publishPresence();renderer.render(scene,camera);
      }finally{drawing=false;}
    }
    function loop(t:number){if(frameClock.step(t))draw()}
    function setMotion(value:boolean){if(disposed)return;if(!value)silenceLifeAudio();motion=value;frameClock.reset();renderer.setAnimationLoop(value?loop:null);draw()}
    function countMeshes(root:T.Object3D|null){let n=0;root?.traverse(o=>{if(o instanceof T.Mesh)n++});return n}
    function update(g:Gathering,id:number|null,focusView:boolean|HomeWorldView='overview'){
      if(disposed)return;updating=true;try{
      const nextView=g.scene_type==='home'||naturalIndoorFor(g)?(focusView===true?'indoor':focusView===false?'outdoor':focusView):'outdoor';
      if(nextView!==view)silenceLifeAudio();
      const target=g.companions.find(c=>c.id===id),oldTarget=gathering.companions.find(c=>c.id===id);
      if(g.id!==gathering.id||g.me!==gathering.me||g.scene_type!==gathering.scene_type)floorGoalCache.clear();
      for(const cachedId of floorGoalCache.keys())if(!g.companions.some(c=>c.id===cachedId))floorGoalCache.delete(cachedId);
      if(!canPreviewLeisure()&&!canNaturalIndoor()&&g.scene_type==='home'&&((nextView!==view&&(nextView==='indoor'||nextView==='bedroom'))||(target&&gatheringCompanionArea(g,target)!=='outdoor'&&(focused!==id||!oldTarget||gatheringCompanionArea(gathering,oldTarget)!==gatheringCompanionArea(g,target)))))houseView='interior';
      if(g.id!==gathering.id||g.me!==gathering.me||g.scene_type!==gathering.scene_type){upperFloorView=false;upperReturnCamera=null;villaVisit.reset();floorDriver=false;serverFloorApplied=0;floorStorageChecked=false;floorStorageStamp='';teaCups.restore();activityEffects?.restore();if(options?.persistentWorld){for(const a of avatars.values()){a.label.remove();disposeLivingObject(a.root);}avatars.clear();environmentKey='';itemKey='';}selectionMenu=null;menuCharacter=null;leisure.reset();leisureInputKey='';leisureSeeded=false;persistentLeisureStamp='';leisureElapsed=0;leisureLast=Date.now()/1000;naturalPoseEpoch=leisureLast;televisionPrograms.reset();televisionChannels.reset();clearTelevisionData();mahjongGame.reset();mahjongGameView.reset();mahjongCaption=null;sharedMahjong=null;sharedMahjongEventStamp='';sharedMahjongReceivedAt=0;lifeAudio.setEnabled(false);lifeSpeech.off();audioPositions.clear();pedestrianTraffic.reset();walkAnimation.reset();navStates.clear();journeys.reset();journeyArrivals.clear();idleYields.clear();pairedCourtesyJobs.clear();pairedCourtesyFailures.clear();idleYieldChecks.clear();idleYieldElapsed=0;journeyGraphs.clear();journeyGeometryKey='';socialPlanKey='';socialPlan.clear();pendingDoorClosures.clear();pendingDoorOpenings.clear();companionDoors.reset();doorSweepCache.clear();for(const a of avatars.values()){delete a.root.userData.homeRegion;delete a.root.userData.homePresenceArea;delete a.root.userData.homeJourney;delete a.root.userData.journeyPortal;delete a.root.userData.visualGroundLift;delete a.root.userData.homeIdleYield;delete a.root.userData.homeIdleYieldAttempt;}}
      const resetAutonomousDoors=!!options?.localCompanionDoors&&(g.id!==gathering.id||g.me!==gathering.me||g.scene_type!==gathering.scene_type);
      const changedJourneyScope=g.id!==gathering.id||g.me!==gathering.me||g.scene_type!==gathering.scene_type;gathering=g;if(changedJourneyScope){journeys=createHomeJourneyController(journeyPortals());benchApproaches.clear();benchEgress.clear();benchReturns.clear();}focused=id;view=nextView;configureCamera();
      const nextSoftHome=toon&&g.scene_type==='home';
      if(softHome&&!nextSoftHome)for(const actor of avatars.values())setHomeActorCutaway(actor.root,false);
      softHome=nextSoftHome;
      if(toon){renderer.toneMappingExposure=softHome?.98:1.05;light.color.set('#fff3d6');light.intensity=softHome?1.9:1.6;fillLight.intensity=softHome?1.25:1.1;fillLight.color.set('#fff9e8');fillLight.groundColor.set('#b3cda1');}else if(options?.realistic){const reference=canReferenceVilla();renderer.toneMappingExposure=reference?1:.96;light.color.set(reference?'#fffaf2':'#fff3dc');light.intensity=reference?2.6:3.1;fillLight.intensity=reference?1:.75;fillLight.color.set(reference?'#e7eced':'#e1efff');fillLight.groundColor.set(reference?'#7b7b70':'#766e5a');}
      if(resetAutonomousDoors){
        const enabled=canCompanionDoors();doors['home-main-entry-door']={open:!(options?.localLeisurePreview||canNaturalIndoor()),progress:options?.localLeisurePreview||canNaturalIndoor()?0:1};
        doors['home-room-connection-door']={open:!enabled,progress:enabled?0:1};doorFrame=Date.now()/1000;
      }
      const resting=homeSofaSeats(g).length,sleepers=homeSleepingBeds(g).length;
      const ek=g.scene_type+'/'+g.season+'/'+(resting>3)+'/'+sleepers+'/'+canReferenceVilla()+'/'+canNaturalWorld()+'/'+canNaturalIndoor()+'/'+canNaturalLeisure();
      if(ek!==environmentKey){televisionPrograms.reset();televisionChannels.reset();clearTelevisionData();mahjongGameView.reset();teaCups.restore();activityEffects?.restore();if(items){disposeLivingObject(items,decoration?[decoration]:[]);items=null;itemKey='';}if(decoration)disposeLivingObject(decoration);invalidateNavigation();decoration=g.scene_type==='home'?buildHomeWorldEnvironment(g.season,{resting,sleeping:sleepers},options?.realistic?{realistic:true,toon,referenceVilla:canReferenceVilla(),onTextureLoaded:()=>draw()}:undefined):canNaturalWorld()?(g.scene_type==='forest'?buildForestEnvironment(g.season,{toon,indoor:canNaturalIndoor(),leisure:canNaturalLeisure(),onTextureLoaded:()=>draw()}):buildDesertEnvironment(g.season,{toon,indoor:canNaturalIndoor(),leisure:canNaturalLeisure(),onTextureLoaded:()=>draw()})):environment(g.scene_type,g.season);if(toon)applyToonScene(decoration,g.scene_type);scene.add(decoration);animatedEnvironmentNodes=[];decoration.traverse(o=>{if(o.userData.localMotion||Array.isArray(o.userData.wallNormal)&&!o.userData.architectureManaged)animatedEnvironmentNodes.push(o);});architectureOccluders=collectArchitectureOccluders(decoration);environmentKey=ek;}
      const ik=JSON.stringify([g.scene_type,g.items,g.season,canNaturalWorld()]);
      if(ik!==itemKey){teaCups.restore();activityEffects?.restore();const previousItems=items,nextItems=new T.Group();invalidateNavigation();for(const item of g.items.filter(i=>!i.stored)){const m=canNaturalWorld()?(g.scene_type==='forest'?buildForestItem(item.kind,g.season,decoration!.userData.homeMaterialLibrary as HomeMaterialLibrary):buildDesertItem(item.kind,g.season,decoration!.userData.homeMaterialLibrary as HomeMaterialLibrary)):options?.realistic&&g.scene_type==='home'&&['tree','bench','shade'].includes(item.kind)?buildRealisticHomeItem(item.kind as 'tree'|'bench'|'shade',g.season,decoration?.userData.homeMaterialLibrary):itemMesh(item.kind,g.season),local={x:(item.x-.5)*8,y:0,z:(item.y-.5)*5.2},point=g.scene_type==='home'?homeWorldPoint('outdoor',local):local;m.position.set(point.x,point.y,point.z);if(item.flipped)m.rotation.y+=Math.PI;m.userData.homeItemId=item.id;if(item.kind==='bench'){m.userData.homeLeisure='bench';if(canNaturalLeisure())m.userData.naturalLeisureSupportId='natural-'+g.scene_type+'-bench-'+item.id;}nextItems.add(m)}if(previousItems)disposeLivingObject(previousItems,[...(decoration?[decoration]:[]),nextItems]);items=nextItems;if(toon)applyToonScene(items,g.scene_type);scene.add(items);itemKey=ik;}
      for(const[cid,a]of avatars)if(!g.companions.some(c=>c.id===cid)){villaVisit.remove(cid);teaCups.release(cid);activityEffects?.restore();a.label.remove();disposeLivingObject(a.root);avatars.delete(cid);navStates.delete(cid);walkAnimation.reset(cid);journeys.remove(cid);journeyArrivals.delete(cid)}
      for(const c of g.companions){const spec=parseAvatar3D(c.avatar3d,c.id),signature=JSON.stringify(spec),old=avatars.get(c.id);if(old?.signature===signature){old.nameLabel.textContent=c.name;old.nameLabel.setAttribute('aria-label','选择画面中的'+c.name);continue}if(old){villaVisit.remove(c.id);teaCups.release(c.id);activityEffects?.restore();old.label.remove();disposeLivingObject(old.root);avatars.delete(c.id)}walkAnimation.reset(c.id);journeys.remove(c.id);journeyArrivals.delete(c.id);if(spec.kind==='unavailable'&&!c.portrait)continue;
        const a=buildAvatar(spec);const label=document.createElement('span'),nameLabel=document.createElement('button'),bubble=document.createElement('span'),bubbleText=document.createElement('span');label.className='living3d-marker';nameLabel.type='button';nameLabel.className='living3d-name';nameLabel.textContent=c.name;nameLabel.setAttribute('aria-label','选择画面中的'+c.name);nameLabel.addEventListener('click',()=>{const current=avatars.get(c.id);if(!disposed&&current?.nameLabel===nameLabel&&!((gathering.scene_type==='home'||canNaturalIndoor())&&houseView==='exterior'&&(canJourney()?current.root.userData.homePresenceArea:current.root.userData.homeRegion)!=='outdoor'))select(c.id)});bubble.className='living3d-bubble';bubble.append(bubbleText);label.append(bubble,nameLabel);labelLayer.appendChild(label);a.root.userData.characterId=c.id;a.root.userData.journeyPortalClearance=homeJourneyPortalClearance(a);a.root.userData.navigationClearance=Math.ceil(homeAvatarNavigationClearance(a.root)*20)/20;navStates.delete(c.id);
        const ring=new T.Mesh(new T.RingGeometry(.48,.53,40),new T.MeshBasicMaterial({color:'#b96c7b',side:T.DoubleSide,depthWrite:false}));ring.rotation.x=-Math.PI/2;ring.position.y=.03;a.root.add(ring);scene.add(a.root);avatars.set(c.id,{...a,baseScale:a.root.scale.clone(),signature,label,nameLabel,bubble,bubbleText,ring});
      }
      refreshLeisure();
      syncPersistentLeisure();
      if(!isPersistent()&&!leisureSeeded&&canLocalLeisure()){leisureSeeded=true;if(canPreviewLeisure())leisure.setTelevisionPower(true);for(const seed of options?.initialLeisure??[])if(canPreviewLeisure()||seed.activity==='tea'||seed.activity==='bench')leisure.start(seed.activity,{actorIds:seed.actorIds,count:seed.actorIds.length,elapsed:leisureElapsed});refreshLeisure();options?.onLeisureChange?.(leisure.getSnapshot());}
      host.dataset.meshCharacters=String(avatars.size);host.dataset.sceneRevision=String(g.revision);host.dataset.environmentMeshes=String(countMeshes(decoration));host.dataset.itemMeshes=String(countMeshes(items));}finally{updating=false;}draw();
    }
    const resize=()=>{if(disposed)return;if(softHome)applyTouchMode();const w=Math.max(1,host.clientWidth),h=Math.max(1,host.clientHeight);renderer.setSize(w,h);configureCamera();draw()};
    const observer=new ResizeObserver(resize);observer.observe(host);releases.push(()=>observer.disconnect());
    const change=()=>{if(!disposed&&!suppressOrbitDraw&&!motion)draw()};controls.addEventListener('change',change);releases.push(()=>controls.removeEventListener('change',change));
    const ray=new T.Raycaster(),taps=createWorldTapTracker();
    const down=(e:PointerEvent)=>taps.down(e),move=(e:PointerEvent)=>taps.move(e),cancel=(e:PointerEvent)=>taps.cancel(e);
    const up=(e:PointerEvent)=>{
      if(disposed||!taps.up(e))return;
      const r=renderer.domElement.getBoundingClientRect();if(r.width<=0||r.height<=0)return;
      ray.setFromCamera(new T.Vector2((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2),camera);
      const targets:T.Object3D[]=[...avatars.values()].filter(a=>a.root.visible&&(upperFloorView?a.root.userData.homeFloor===2:!((gathering.scene_type==='home'||canNaturalIndoor())&&houseView==='exterior'&&(canJourney()?a.root.userData.homePresenceArea:a.root.userData.homeRegion)!=='outdoor'))).map(a=>a.root);
      if((gathering.scene_type==='home'||canNaturalIndoor())&&decoration)targets.push(decoration);if(canLocalLeisure()&&items)targets.push(items);
      const hit=ray.intersectObjects(targets,true).find(h=>{for(let o:T.Object3D|null=h.object;o;o=o.parent)if(!o.visible||o.userData.homeWallGhost===true)return false;return true});
      if(!hit)return;
      if(upperFloorView){for(let o:T.Object3D|null=hit.object;o;o=o.parent){if(o.userData.upperFloorDoor){toggleUpperDoor();return;}if(typeof o.userData.characterId==='number'){select(o.userData.characterId);return;}}return;}
      for(let o:T.Object3D|null=hit.object;o;o=o.parent){if(canLocalLeisure()&&(canNaturalLeisure()?['tea','bench']:['tea','television','mahjong','bench']).includes(o.userData.homeLeisure)){startLocalLeisure(o.userData.homeLeisure,focused??undefined);return}if(typeof o.userData.homeDoorId==='string'){toggleDoor(o.userData.homeDoorId as HomeWorldDoorId);return}if(typeof o.userData.characterId==='number'){select(o.userData.characterId);return}}
    };
    renderer.domElement.addEventListener('pointerdown',down);renderer.domElement.addEventListener('pointermove',move);renderer.domElement.addEventListener('pointerup',up);renderer.domElement.addEventListener('pointercancel',cancel);
    releases.push(()=>{renderer.domElement.removeEventListener('pointerdown',down);renderer.domElement.removeEventListener('pointermove',move);renderer.domElement.removeEventListener('pointerup',up);renderer.domElement.removeEventListener('pointercancel',cancel)});
    const lost=(e:Event)=>{e.preventDefault();host.dispatchEvent(new CustomEvent('living3d-lost'));setMotion(false)};renderer.domElement.addEventListener('webglcontextlost',lost);releases.push(()=>renderer.domElement.removeEventListener('webglcontextlost',lost));
    function rotate(delta:number){if(disposed||!Number.isFinite(delta))return;const v=camera.position.clone().sub(controls.target).applyAxisAngle(new T.Vector3(0,1,0),delta);camera.position.copy(controls.target).add(v);updateControls();draw()}
    function zoom(multiplier:number){if(disposed||!Number.isFinite(multiplier)||multiplier<=0)return;const v=camera.position.clone().sub(controls.target);
      if(softHome&&multiplier<1&&houseView==='exterior'&&!upperFloorView&&gathering.companions.length===1){const actor=avatars.get(gathering.companions[0].id);if(actor?.root.userData.homeRegion==='outdoor'){const center=actor.root.getWorldPosition(new T.Vector3());center.y+=SCENE_SCALE.companionHeight*.55;controls.target.lerp(center,.5);}}
      v.setLength(T.MathUtils.clamp(v.length()*multiplier,controls.minDistance,controls.maxDistance));camera.position.copy(controls.target).add(v);updateControls();draw()}
    function reset(){if(disposed)return;resetCamera();draw()}
    const key=(e:KeyboardEvent)=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();rotate(e.key==='ArrowLeft'?.22:-.22)}else if(e.key==='+'||e.key==='-'){e.preventDefault();zoom(e.key==='+'?.9:1.1)}};renderer.domElement.addEventListener('keydown',key);releases.push(()=>renderer.domElement.removeEventListener('keydown',key));
    function updateSharedMahjong(value:PublicSharedMahjongSnapshot|null){
      if(disposed||!isPersistent())return;
      if(value&&(value.gathering_id!==gathering.id||value.game&&('own_hands' in value.game||value.game.gathering_id!==gathering.id)))return;
      const previous=sharedMahjong?.game,next=value?.game;
      if(previous&&next&&previous.game_id===next.game_id&&next.revision<previous.revision)return;
      const stamp=next?.last_event?next.game_id+':'+next.last_event.seq:'';
      const fresh=!!previous&&!!next&&previous.game_id===next.game_id&&stamp!==sharedMahjongEventStamp&&next.last_event&&next.last_event.seq>(previous.last_event?.seq??-1);
      sharedMahjong=value;sharedMahjongReceivedAt=Date.now();sharedMahjongEventStamp=stamp;
      const event=next?.last_event;
      if(fresh&&event&&event.kind!=='draw'&&motion&&!document.hidden&&(houseView==='exterior'||view==='outdoor')){
        mahjongCaption={actorId:event.character_id,text:event.text,until:leisureElapsed+1.8};
        lifeSpeech.say({key:'shared-mahjong:'+stamp,actorId:event.character_id,text:event.text});
      }
      draw();
    }
    function setReplay(value:boolean){if(disposed)return;replayAt=value?Date.now()/1000:null;draw()}
    function setBubbleReceipts(value:LivingBubbleReceipts){if(disposed)return;bubbleReceipts=value;draw()}
    function floorPlan(id:number,activity:VillaActivity){
      const a=avatars.get(id),c=gathering.companions.find(c=>c.id===id);if(!a||!decoration||!decoration.getObjectByName('villa-indoor-stair')||(!isPersistent()&&c?.owner_id!==gathering.me))return null;
      const furniture=villaLifeFurniture(decoration);if(!furniture)return null;const bp=computeLivingBedPose(a.sleepSupport,a.baseScale.clone().multiplyScalar(.9),1),bed=furniture.bed,seat=furniture.seat;a.root.userData.upperBedLegLift=bed.footLift/Math.max(.1,a.baseScale.z*.9*-Math.sin(bp?.rotationX??-Math.PI/2));
      const target=activity==='sleep'?{x:bed.x,y:bed.y+(bp?.rootOffsetY??0),z:bed.z-bed.length*.33+(bp?.headOffsetZ??0)+.35,yaw:0,tilt:bp?.rotationX??-Math.PI/2,scale:.9,blend:1}:{x:seat.x,y:seat.y-a.seatHeight*a.baseScale.y*.9,z:seat.z,yaw:0,tilt:0,scale:.9,blend:1};
      const radius=Number(a.root.userData.navigationClearance),plan=buildVillaLifePlan(decoration,activity,radius,target);return plan?{radius,plan}:null;
    }
    function setFloorDriver(value:boolean){floorDriver=isPersistent()&&value;}
    function applyServerFloor(value:FloorSnapshot,preserve=false){
      if(disposed||!isPersistent()||!canReferenceVilla())return false;
      try{
        const candidate=createVillaFloorLife();if(!candidate.restore(preserve?villaVisit.export():value.checkpoint,floorPlan))return false;
        for(const cmd of value.commands){if(cmd.seq<=value.applied)continue;const c=gathering.companions.find(c=>c.id===cmd.id),a=avatars.get(cmd.id);if(!c||!a)return false;const plan=cmd.activity===null?null:floorPlan(cmd.id,cmd.activity);if(cmd.activity!==null&&!plan)return false;if(!candidate.request(cmd.id,plan?.radius??Number(a.root.userData.navigationClearance),plan?.plan??null))return false;}
        if(!villaVisit.restore(candidate.export(),floorPlan))return false;serverFloorApplied=value.seq;
        if(villaVisit.snapshots().length&&decoration)setVillaUpperDoor(decoration,true);draw();return true;
      }catch{return false;}
    }
    function canRequestServerFloor(id:number,activity:VillaActivity|null){
      if(disposed||!isPersistent()||!canReferenceVilla()||!gathering.companions.some(c=>c.id===id&&c.owner_id===gathering.me&&!c.leisure))return false;
      const a=avatars.get(id);if(!a)return false;const p=activity===null?null:floorPlan(id,activity);if(activity!==null&&!p)return false;
      if(p){refreshJourneyGeometry();if(!journeyGraph('bedroom',p.radius).isSegmentClear(VILLA_STAIR_BOTTOM,VILLA_STAIR_BOTTOM))return false;}
      const trial=createVillaFloorLife();if(!trial.restore(villaVisit.export(),floorPlan))return false;return trial.request(id,p?.radius??Number(a.root.userData.navigationClearance),p?.plan??null);
    }
    function floorSaveStatus(status:'saved'|'restored'|'unavailable'|'rejected'){if(host.dataset.upperSaveStatus!==status){host.dataset.upperSaveStatus=status;options?.onFloorSaveChange?.(status);}}
    function archivePreviousFloorSave(){if(host.dataset.upperRestore!=='rejected')return;try{const key=floorStorageKey(),raw=localStorage.getItem(key);if(raw)localStorage.setItem(key+'/retained/'+Date.now(),raw);host.dataset.upperRestore='archived';}catch{floorSaveStatus('unavailable');}}
    function floorStorageKey(){return 'wanwu-local-upper-life-v1/'+encodeURIComponent(gathering.id)+'/'+encodeURIComponent(gathering.me);}
    function floorFingerprint(){return JSON.stringify([3,gathering.scene_type,gathering.items,gathering.companions.map(c=>[c.id,c.owner_id,c.avatar3d,c.activity])]);}
    function restoreFloorLife(){if(floorStorageChecked||!options?.localFloorStorage||isPersistent()||!canReferenceVilla()||!avatars.size)return;floorStorageChecked=true;try{const text=localStorage.getItem(floorStorageKey());if(!text)return;const data=JSON.parse(text);if(data.fingerprint!==floorFingerprint()||!villaVisit.restore(data.state,floorPlan)){host.dataset.upperRestore='rejected';floorSaveStatus('rejected');return;}setVillaUpperDoor(decoration!,true);host.dataset.upperRestore='restored';floorSaveStatus('restored');}catch{host.dataset.upperRestore='unavailable';floorSaveStatus('unavailable');}}
    function saveFloorLife(){if(!floorStorageChecked||!options?.localFloorStorage||isPersistent()||!canReferenceVilla()||host.dataset.upperRestore==='rejected')return;const now=Date.now();if(now-floorStorageAt<500)return;try{const text=JSON.stringify({fingerprint:floorFingerprint(),state:villaVisit.export()});if(text!==floorStorageStamp){localStorage.setItem(floorStorageKey(),text);floorStorageStamp=text;floorStorageAt=now;host.dataset.upperSave='saved';floorSaveStatus('saved');}}catch{host.dataset.upperSave='unavailable';floorSaveStatus('unavailable');}}
    function requestFloorActivity(id:number,activity:VillaActivity){
      const a=avatars.get(id),c=gathering.companions.find(c=>c.id===id);if(disposed||!canReferenceVilla()||isPersistent()||!a||c?.owner_id!==gathering.me)return false;
      const p=floorPlan(id,activity);if(!p)return false;refreshJourneyGeometry();if(!journeyGraph('bedroom',p.radius).isSegmentClear(VILLA_STAIR_BOTTOM,VILLA_STAIR_BOTTOM))return false;
      if(!villaVisit.request(id,p.radius,p.plan))return false;archivePreviousFloorSave();setVillaUpperDoor(decoration!,true);leisure.stop({actorId:id});teaCups.release(id);idleYields.delete(id);refreshLeisure(true);floorStorageAt=0;draw();return true;
    }
    function requestFloorVisit(id:number,up:boolean){if(up)return requestFloorActivity(id,'observe');const a=avatars.get(id),c=gathering.companions.find(c=>c.id===id);if(disposed||isPersistent()||!a||c?.owner_id!==gathering.me)return false;const ok=villaVisit.request(id,Number(a.root.userData.navigationClearance),null);floorStorageAt=0;if(ok){if(decoration)setVillaUpperDoor(decoration,true);draw();}return ok;}
    function setUpperFloorView(value:boolean){
      if(disposed||!canReferenceVilla())return false;
      if(value===upperFloorView)return true;
      if(value)upperReturnCamera={position:camera.position.clone(),target:controls.target.clone(),view,min:controls.minDistance,max:controls.maxDistance,fov:camera.fov};
      const returning=!value?upperReturnCamera:null;upperFloorView=value;
      if(value){houseView='interior';silenceLifeAudio();}configureCamera();
      if(returning&&returning.view===view){camera.position.copy(returning.position);controls.target.copy(returning.target);controls.minDistance=returning.min;controls.maxDistance=returning.max;camera.fov=returning.fov;camera.updateProjectionMatrix();updateControls();}
      if(!value)upperReturnCamera=null;draw();return true;
    }
    function toggleUpperDoor(){const root=decoration?.getObjectByName('home-villa-upper-interior');return root?setUpperDoorOpen(!root.userData.door.requested):false;}
    function setUpperDoorOpen(value:boolean){if(disposed||!upperFloorView||!decoration||!value&&villaVisit.snapshots().some(s=>s.phase!=='upper'&&s.phase!=='returned'))return false;const result=setVillaUpperDoor(decoration,value);draw();return result;}
    function setHouseView(value:'interior'|'exterior'){if(disposed||(gathering.scene_type!=='home'&&!canNaturalIndoor())||(value!=='interior'&&value!=='exterior'))return;if(houseView!==value)silenceLifeAudio();if(value==='exterior'){upperFloorView=false;upperReturnCamera=null;}houseView=value;if(value==='exterior'&&view!=='overview'&&(!(canPreviewLeisure()||canNaturalIndoor())||view!=='outdoor')){view='overview';configureCamera()}draw()}
    function focusLocalLeisure(kind:HomeLeisureActivity){
      if(disposed||!canLocalLeisure()||canNaturalLeisure()&&kind!=='tea'&&kind!=='bench')return false;
      const object=kind==='bench'?items?.children.find(o=>o.userData.homeRestKind==='bench'||canNaturalLeisure()&&o.userData.naturalItemKind==='bench'):decoration?.getObjectByName(kind==='mahjong'?'home-mahjong-table':kind==='tea'?'home-farmhouse-tea-table':'home-television-screen');if(!object)return false;
      if(kind==='television'&&houseView==='exterior')return false;object.updateWorldMatrix(true,false);const center=object.getWorldPosition(new T.Vector3());view=kind==='television'?'indoor':'outdoor';configureCamera();
      if(kind==='television'){
        const seat=leisureSeatList.find(s=>s.station==='television');const z=seat?(seat.z+center.z)*.5:center.z-2.4;
        controls.target.set(center.x,1.1,z);camera.position.set(center.x-4.5,2.5,z+.6);
      }else{controls.target.set(center.x,.8,center.z);camera.position.set(center.x+3.5,canReferenceVilla()?4.2:3.6,center.z+(canReferenceVilla()?2:4.2));}
      camera.fov=52;camera.updateProjectionMatrix();controls.minDistance=1.5;controls.maxDistance=24;updateControls();draw();return true;
    }
    function setSelectionMenu(value:HTMLElement|null,id:number|null,placement:'anchor'|'panel'='anchor'){if(disposed)return;selectionMenu=value;menuCharacter=id;selectionMenuPlacement=placement;if(value&&placement==='panel'){value.hidden=false;value.style.removeProperty('left');value.style.removeProperty('top');}draw()}
    update(initial,null);resize();return{setFloorDriver,applyServerFloor,canRequestServerFloor,exportServerFloor:()=>({checkpoint:villaVisit.export(),applied:serverFloorApplied}),requestFloorActivity,getFloorLives:()=>villaVisit.snapshots(),requestFloorVisit,getFloorVisit:(id?:number)=>villaVisit.snapshot(id),update,updateSharedMahjong,setMotion,setReplay,setBubbleReceipts,setHouseView,setUpperFloorView,setUpperDoorOpen,toggleUpperDoor,setDoorOpen:(id:HomeWorldDoorId,open:boolean)=>setDoorOpen(id,open),toggleDoor,toggleLocalLeisure,setLifeAudio,startLocalLeisure,stopLocalLeisure,getLocalLeisure:()=>leisure.getSnapshot(),getLeisureSeats:()=>{if(!disposed)refreshLeisure(true);return leisureSeatList.map(s=>({...s}));},getLocalMahjong:()=>mahjongGame.getSnapshot(),restartLocalMahjong(){if(disposed||!canPlayMahjong())return false;activityEffects?.restore();mahjongGameView.reset();mahjongGame.reset();silenceLifeAudio();draw();return true;},focusLocalLeisure,setSelectionMenu,rotate,zoom,reset,dispose(){selectionMenu=null;cleanup()}};
  }catch(error){cleanup();throw error}
}
