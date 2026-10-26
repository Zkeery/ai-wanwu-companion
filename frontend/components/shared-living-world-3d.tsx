'use client';
import type { PublicSharedMahjongSnapshot } from '../lib/shared-mahjong';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { gatheringAreaNames, gatheringCompanionArea, type Gathering } from '@/lib/gatherings';
import { parseAvatar3D } from '@/lib/shared-living-3d';
import { createLivingWorld } from '@/lib/living-world-engine';
import { createLivingBubbleClock } from '@/lib/living-world-bubbles';
import type { HomeWorldView } from '@/lib/living-home-world';
import { getHomePresenceActor, homePresenceActivityLabel, type HomePresenceSnapshot } from '@/lib/living-home-presence';
import { naturalActivityCapacity } from '@/lib/living-natural-occupancy';
import type { HomeWorldDoorId } from '@/lib/living-home-world-meshes';
import { persistentLivingScope, type LivingLeisureRequest } from '@/lib/living-persistent-world';
import type { HomeLeisureActivity, HomeLeisureSnapshot } from '@/lib/living-home-leisure';
import {createFloorSync,floorApi} from '@/lib/villa-floor-sync';
import {getToken,AUTH_CHANGED} from '@/lib/auth';
import {errorText} from '@/lib/api';
import { describeCompanionPresence, type GatheringCompanionPresence } from '@/lib/gathering-presence';
import type {VillaActivity} from '@/lib/living-villa-floor-life';
import styles from './shared-living-world-3d.module.css';

const activities: Record<string, string> = { arriving: '刚刚到达', rest: '休息', sleep: '睡觉', walk: '散步', observe: '观察', talk: '相聚', tea:'喝茶', television:'看电视', mahjong:'打麻将', bench:'长椅休息' };
const mahjongPhases:Record<string,string>={waiting:'等待四位伙伴入座',exchange:'正在换三张',dingque:'正在定缺',draw:'正在摸牌',hold:'正在选牌',discard:'正在出牌',claim:'正在应牌',win:'胡牌，其他伙伴继续',ended:'本局结束'};
type LocalMahjongSummary={scope:string;rules:'basic'|'sichuan';status:string;phase:string;wallRemaining:number;players:{actorId:number;won:boolean;missingSuit:'万'|'筒'|'条'|null;score:number}[]};
type ManualActivity = 'rest' | 'sleep' | 'walk' | 'observe' | 'talk';
type Props = { gathering: Gathering; focusedId: number | null; onSelect: (id: number) => void; animate: boolean; room?: boolean; bedroom?: boolean;
  onFloorOccupancyChange?: (ids: readonly number[]) => void; onCompanionPresenceChange?: (values: readonly GatheringCompanionPresence[]) => void; floorKind?:'shared'|'private'; sharedMahjongSnapshot?: PublicSharedMahjongSnapshot | null; emptyMessage?: string; persistentWorld?: boolean; onLeisureAction?: (request: LivingLeisureRequest) => Promise<void> | void; visualStyle?: 'classic' | 'realistic'; localLeisurePreview?: boolean; localRoomTransitions?: boolean; localCompanionDoors?: boolean; localReferenceVilla?: boolean; localNaturalWorld?:boolean; localNaturalLeisure?:boolean; localSpeechClips?:Readonly<Record<string,string>>; localQuietAudio?:boolean; localMahjongGame?:boolean; localMahjongRules?:'basic'|'sichuan'; initialLeisure?: readonly {activity:HomeLeisureActivity;actorIds:number[]}[]; view?: HomeWorldView; onFocusView?: (view: HomeWorldView) => void; onPausedChange?: (paused: boolean) => void; busy?: boolean; onActivity?: (id: number, activity: ManualActivity) => Promise<void> | void };
export default function SharedLivingWorld3D({ gathering, focusedId, onSelect, animate, room = false, bedroom = false, view, onFocusView, onPausedChange, busy = false, onActivity, onFloorOccupancyChange, onCompanionPresenceChange, floorKind, sharedMahjongSnapshot, emptyMessage, persistentWorld = false, onLeisureAction, visualStyle: requestedVisualStyle = 'classic', localLeisurePreview: previewLeisure = false, localRoomTransitions: previewTransitions = false, localCompanionDoors: previewDoors = false, localReferenceVilla: previewVilla = false, localNaturalWorld: previewNatural = false, localNaturalLeisure: previewNaturalLeisure = false, localSpeechClips, localQuietAudio: previewQuietAudio = false, localMahjongGame = false, localMahjongRules = 'basic', initialLeisure }: Props) {
  const persistent = persistentLivingScope(gathering, persistentWorld);
  const visualStyle = persistent ? 'realistic' : requestedVisualStyle;
  const localQuietAudio = persistent || previewQuietAudio;
  const localLeisurePreview=persistent||previewLeisure,localRoomTransitions=persistent||previewTransitions,localCompanionDoors=persistent||previewDoors;
  const localReferenceVilla=persistent||previewVilla,localNaturalWorld=persistent||previewNatural,localNaturalLeisure=persistent||previewNaturalLeisure;
  const home = gathering.scene_type === 'home';
  const host = useRef<HTMLDivElement>(null), labels = useRef<HTMLDivElement>(null);
  const world = useRef<ReturnType<typeof createLivingWorld> | null>(null), select = useRef(onSelect);
  const [replay, setReplay] = useState(false),[lifeSound,setLifeSound]=useState(false),[soundBusy,setSoundBusy]=useState(false);
  const [speechStatus,setSpeechStatus]=useState('off');
  const [localMahjongInfo,setLocalMahjongInfo]=useState<LocalMahjongSummary|null>(null);
  const [leisureState,setLeisureState]=useState<HomeLeisureSnapshot|null>(null),[leisureError,setLeisureError]=useState('');
  const [leisureFocus,setLeisureFocus]=useState<{kind:HomeLeisureActivity;sequence:number}|null>(null);
  const leisureNavigate=useRef<(kind:HomeLeisureActivity)=>void>(()=>{});
  const naturalEnabled=localNaturalWorld&&visualStyle==='realistic'&&['forest','desert'].includes(gathering.scene_type)&&(gathering.id.startsWith('synthetic-')||persistent);
  const naturalIndoor=naturalEnabled&&localRoomTransitions&&localCompanionDoors;
  const dwelling=home||naturalIndoor;
  const areaNames=naturalIndoor?{outdoor:gathering.scene_type==='forest'?'林地':'绿洲',indoor:'休息间',bedroom:'卧室'}:gatheringAreaNames;
  const homeLeisureEnabled=localLeisurePreview&&visualStyle==='realistic'&&home&&(gathering.id.startsWith('synthetic-')||persistent);
  const naturalLeisureEnabled=naturalIndoor&&localLeisurePreview&&localNaturalLeisure;
  const leisureEnabled=homeLeisureEnabled||naturalLeisureEnabled;
  const leisureKinds:readonly HomeLeisureActivity[]=naturalLeisureEnabled?['tea','bench']:['tea','television','mahjong','bench'];
  const localAssignments=useMemo(()=>leisureEnabled?leisureState?.assignments??[]:[],[leisureEnabled,leisureState]);
  const [presence,setPresence]=useState<HomePresenceSnapshot|null>(null);
  const floorSync=useRef<ReturnType<typeof createFloorSync>|null>(null),floorMoving=useRef(false);
  const [serverFloorStatus,setServerFloorStatus]=useState('正在读取二楼进度');
  const [floorSave,setFloorSave]=useState<'saved'|'restored'|'unavailable'|'rejected'|null>(null);
  const [floorLives,setFloorLives]=useState<{id:number;phase:string;floor:number;activity:'observe'|'rest'|'sleep'}[]>([]);
  useEffect(() => { onFloorOccupancyChange?.(floorLives.filter(v => v.phase !== 'returned').map(v => v.id)); }, [floorLives, onFloorOccupancyChange]);
  const presenceEnabled=(leisureEnabled||naturalIndoor)&&localRoomTransitions;
  const companionDoorsEnabled=presenceEnabled&&localCompanionDoors;
  const referenceVillaEnabled=home&&presenceEnabled&&localReferenceVilla;
  const presenceScope=useMemo(()=>({groupId:gathering.id,ownerId:gathering.me,sceneType:gathering.scene_type,enabled:presenceEnabled,localNaturalWorld:naturalIndoor,persistentWorld:persistent,actorIds:gathering.companions.map(c=>c.id)}),[gathering,presenceEnabled,naturalIndoor,persistent]);
  const physicalActor=(id:number)=>getHomePresenceActor(presence,presenceScope,id);
  const localActivity=(id:number)=>localAssignments.find(a=>a.actorId===id)?.activity??(persistent?gathering.companions.find(c=>c.id===id)?.leisure?.activity:undefined);
  const currentArea=useCallback((c:Gathering['companions'][number])=>{const actual=getHomePresenceActor(presence,presenceScope,c.id);if(actual)return actual.area;const activity=localAssignments.find(a=>a.actorId===c.id)?.activity;return activity?activity==='television'?'indoor':'outdoor':gatheringCompanionArea(gathering,c);},[localAssignments,gathering,presence,presenceScope]);
  const currentActivity=(c:Gathering['companions'][number])=>localActivity(c.id)??c.activity;
  const activityLabel=(c:Gathering['companions'][number])=>{const visit=floorLives.find(v=>v.id===c.id);return visit&&visit.phase!=='returned'?(visit.phase==='upper'?'二楼 · '+({observe:'看风景',rest:'休息',sleep:'睡觉'}[visit.activity]):visit.phase==='queued'?'等候楼梯':visit.phase==='waiting'?'通道等候':'上下楼途中'):homePresenceActivityLabel(physicalActor(c.id),activities[currentActivity(c)]||'在场');};
  const companionPresenceStamp = JSON.stringify(gathering.companions.map(c => describeCompanionPresence(gathering, c, { floorVisit: floorLives.find(v => v.id === c.id), activityLabel: homePresenceActivityLabel(physicalActor(c.id), activities[currentActivity(c)] || '在场'), locationLabel: areaNames[currentArea(c)] })));
  useEffect(() => { onCompanionPresenceChange?.(JSON.parse(companionPresenceStamp) as GatheringCompanionPresence[]); }, [companionPresenceStamp, onCompanionPresenceChange]);
  const [bubbleClock] = useState(() => createLivingBubbleClock(gathering));
  const [localView, setLocalView] = useState<HomeWorldView>('overview');
  const focusView = view ?? (bedroom ? 'bedroom' : room ? 'indoor' : localView);
  const leisureRequest=useRef<(request:LivingLeisureRequest)=>void>(()=>{});
  const menu = useRef<HTMLDivElement>(null), menuLock = useRef(false);
  const [mobileControls, setMobileControls] = useState(false);
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(max-width: 600px), (pointer: coarse)');
    const update = () => setMobileControls(query.matches);
    update(); query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  const [menuId, setMenuId] = useState<number | null>(null), [menuSending, setMenuSending] = useState(false), [menuError, setMenuError] = useState(''), [menuNotice, setMenuNotice] = useState('');
  const menuCompanion = gathering.companions.find(c => c.id === menuId);
  const focusedCompanion = gathering.companions.find(c => c.id === focusedId);
  const focusedArea = focusedCompanion ? currentArea(focusedCompanion) : null;
  const menuArea = menuCompanion ? currentArea(menuCompanion) : null;
  const houseContext = { sceneType:gathering.scene_type, space: gathering.id, owner: gathering.me, view: focusView, focus: focusedId, focusedArea, menu: menuId, menuArea };
  const houseStamp = JSON.stringify(houseContext);
  const [architecture, setArchitecture] = useState(() => ({ ...houseContext, stamp: houseStamp, mode: (leisureEnabled||naturalIndoor?'exterior':'interior') as 'interior' | 'exterior' }));
  if (architecture.stamp !== houseStamp) {
    const enteredRoom = architecture.view !== focusView && (focusView === 'indoor' || focusView === 'bedroom');
    const selectedInside = (architecture.focus !== focusedId || architecture.focusedArea !== focusedArea) && focusedArea !== null && focusedArea !== 'outdoor';
    const openedInside = (architecture.menu !== menuId || architecture.menuArea !== menuArea) && menuArea !== null && menuArea !== 'outdoor';
    const changedSpace = architecture.sceneType !== gathering.scene_type || architecture.space !== gathering.id || architecture.owner !== gathering.me;
    setArchitecture({ ...houseContext, stamp: houseStamp, mode: changedSpace?(leisureEnabled||naturalIndoor?'exterior':'interior'):(leisureEnabled||naturalIndoor?architecture.mode:enteredRoom || selectedInside || openedInside ? 'interior' : architecture.mode) });
  }
  const houseView = architecture.mode;
  const upperScope=gathering.id+'/'+gathering.me+'/'+gathering.scene_type;
  const [upperFloor,setUpperFloor]=useState({scope:upperScope,enabled:false});
  const upperFloorView=referenceVillaEnabled&&houseView==='interior'&&upperFloor.scope===upperScope&&upperFloor.enabled;
  const doorScope=JSON.stringify([gathering.id,gathering.me,gathering.scene_type,leisureEnabled,companionDoorsEnabled,referenceVillaEnabled]);
  const initialDoors:Record<HomeWorldDoorId,boolean>={'home-main-entry-door':!(leisureEnabled||naturalIndoor),'home-room-connection-door':!companionDoorsEnabled,'home-courtyard-gate':true};
  const [doorSnapshot,setDoorSnapshot]=useState(()=>({scope:doorScope,values:initialDoors}));
  if(doorSnapshot.scope!==doorScope)setDoorSnapshot({scope:doorScope,values:initialDoors});
  const doors=doorSnapshot.scope===doorScope?doorSnapshot.values:initialDoors;
  const doorWrites=useRef<{scope:string;values:Partial<Record<HomeWorldDoorId,boolean>>}>({scope:doorScope,values:{}});
  const setDoors=(change:(previous:Record<HomeWorldDoorId,boolean>)=>Record<HomeWorldDoorId,boolean>)=>setDoorSnapshot(previous=>previous.scope===doorScope?{scope:doorScope,values:change(previous.values)}:previous);
  const cameraView = dwelling && houseView === 'exterior' && (!(leisureEnabled||naturalIndoor) || focusView === 'indoor' || focusView === 'bedroom') ? 'overview' : focusView;
  const [failed, setFailed] = useState(false), [paused, setPaused] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(()=>{floorMoving.current=animate&&!busy&&!paused&&!failed;},[animate,busy,paused,failed]);
  useEffect(()=>{leisureNavigate.current=kind=>{const next=kind==='television'?'indoor':'outdoor';if(kind==='television'&&architecture.mode==='exterior')return;setLocalView(next);onFocusView?.(next);setArchitecture(previous=>({...previous,mode:kind==='television'?'interior':naturalLeisureEnabled?'exterior':previous.mode}));setLeisureFocus(previous=>({kind,sequence:(previous?.sequence??0)+1}));};},[onFocusView,architecture.mode,naturalLeisureEnabled]);
  useEffect(() => { select.current = id => {
    const companion = gathering.companions.find(c => c.id === id);
    const visit = floorLives.find(v => v.id === id && v.phase !== 'returned');
    if (referenceVillaEnabled) {
      const upstairs = !!visit && (visit.floor === 2 || visit.phase === 'upper');
      setUpperFloor({ scope: upperScope, enabled: upstairs });
      if (upstairs) { setLeisureFocus(null); setArchitecture(previous => ({ ...previous, mode: 'interior' })); }
    }
    if (!leisureEnabled && home && companion && currentArea(companion) !== 'outdoor') setArchitecture(previous => ({ ...previous, mode: 'interior' }));
    setMenuId(id); setMenuError(''); setMenuNotice(''); onSelect(id);
  }; }, [onSelect, gathering, home,currentArea,leisureEnabled,floorLives,referenceVillaEnabled,upperScope]);
  useEffect(() => {
    const element = host.current; if (!element || !labels.current) return;
    let active = true;doorWrites.current={scope:doorScope,values:{}};
    const lost = () => setFailed(true); element.addEventListener('living3d-lost', lost);
    try { const changed = (id: HomeWorldDoorId, open: boolean, source?:'manual'|'companion') => {if(!active)return;if(doorWrites.current.scope===doorScope)doorWrites.current.values[id]=open;setDoors(previous => previous[id] === open ? previous : { ...previous, [id]: open });if(source!=='companion'&&(leisureEnabled||naturalIndoor)&&id==='home-main-entry-door'&&open){setLeisureFocus(null);setArchitecture(previous=>({...previous,mode:'interior'}));setLocalView('indoor');onFocusView?.('indoor');}}; world.current = visualStyle === 'realistic' ? createLivingWorld(element, labels.current, gathering, id => select.current(id), changed, { strictLeisureContacts:leisureEnabled,persistentWorld:persistent,onLeisureRequest:request=>{if(active)leisureRequest.current(request);},realistic: true, localNaturalWorld:naturalEnabled, localNaturalLeisure:naturalLeisureEnabled, localLeisurePreview: leisureEnabled, localRoomTransitions, localCompanionDoors:companionDoorsEnabled, localReferenceVilla:referenceVillaEnabled, localSpeechClips:leisureEnabled?localSpeechClips:undefined, localQuietAudio, localMahjongGame, localMahjongRules, onLocalMahjongChange:state=>{if(active)setLocalMahjongInfo(state?{scope:gathering.id,rules:state.rules??localMahjongRules,status:state.status,phase:state.phase,wallRemaining:state.wallRemaining,players:state.players.map(player=>({actorId:player.actorId,won:player.won===true,missingSuit:player.missingSuit??null,score:Number.isInteger(player.score)?player.score??0:0}))}:null);}, onSpeechChange:state=>{if(active)setSpeechStatus(state.status);}, localFloorStorage:!persistent,onFloorSaveChange:status=>{if(active)setFloorSave(status);},onFloorLifeChange:state=>{if(active)setFloorLives(state);}, onJourneyChange:state=>{if(active)setPresence(state);}, initialLeisure, onLeisureChange: (state,kind,error)=>{setLeisureState(state);setLeisureError(error?({insufficient_actors:'空闲伙伴不够，请先带伙伴来，或点选一位伙伴。',insufficient_seats:'这里没有足够的空座位。',seat_blocked:'这里的座位或通道被布置挡住了，调整布置后再试。',seat_busy:'座位已被使用，请先结束原活动。',actor_busy:'这位伙伴正在另一项休闲中，请先结束。',actor_unavailable:'这位伙伴暂时不能参与。',forbidden:'这位伙伴的活动由它的主人安排。'}[error]??'这项活动暂时无法安排。'):'');if(kind)leisureNavigate.current(kind);} }) : createLivingWorld(element, labels.current, gathering, id => select.current(id), changed); }
    catch { queueMicrotask(() => { if (active) setFailed(true); }); }
    queueMicrotask(()=>{if(active){setLeisureFocus(null);setLifeSound(false);if(!presenceEnabled)setPresence(null);}});
    return () => { active = false; element.removeEventListener('living3d-lost', lost); world.current?.dispose(); world.current = null; };
    // The parent remounts for a different account or space; snapshots update below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, persistent, visualStyle, leisureEnabled, naturalEnabled, naturalLeisureEnabled, localRoomTransitions, companionDoorsEnabled, referenceVillaEnabled, localSpeechClips, localQuietAudio, localMahjongGame, localMahjongRules, gathering.id, gathering.me, gathering.scene_type]);
  useEffect(() => {
    bubbleClock.observe(gathering, home ? 'all' : 'outdoor', Date.now() / 1000);
    world.current?.setBubbleReceipts?.(bubbleClock.receipts);
    if (dwelling && (view !== undefined || room || bedroom || localView !== 'overview')) world.current?.update(gathering, focusedId, cameraView); else world.current?.update(gathering, focusedId);
  }, [gathering, focusedId, attempt, room, bedroom, home, dwelling, bubbleClock, view, localView, cameraView, visualStyle]);
  useEffect(() => { world.current?.setMotion(animate && !paused && !failed); }, [animate, paused, failed, attempt, visualStyle]);
  useEffect(() => { world.current?.setReplay?.(replay); }, [replay, attempt, visualStyle]);
  useEffect(() => { world.current?.updateSharedMahjong?.(persistent ? sharedMahjongSnapshot ?? null : null); }, [persistent, sharedMahjongSnapshot, gathering.id, gathering.me, attempt, visualStyle]);
  useEffect(() => {
    if(!world.current)return;
    if(doorWrites.current.scope!==doorScope)doorWrites.current={scope:doorScope,values:{}};
    for(const id of ['home-main-entry-door','home-room-connection-door','home-courtyard-gate'] as const)if(doorWrites.current.values[id]!==doors[id]){
      doorWrites.current.values[id]=doors[id];world.current.setDoorOpen?.(id,doors[id]);
    }
  }, [doors, doorScope, attempt, visualStyle, companionDoorsEnabled]);
  useEffect(() => { world.current?.setHouseView?.(dwelling ? houseView : 'interior'); }, [dwelling, houseView, attempt, visualStyle]);
  useEffect(()=>{world.current?.setUpperFloorView?.(upperFloorView);},[upperFloorView,attempt,visualStyle,gathering.id,gathering.me,gathering.scene_type]);
  useEffect(() => { world.current?.setSelectionMenu?.(menu.current, menuCompanion?.id ?? null, mobileControls ? 'panel' : 'anchor'); }, [menuCompanion, attempt, visualStyle, mobileControls]);
  useEffect(()=>{if(leisureEnabled&&leisureFocus)world.current?.focusLocalLeisure(leisureFocus.kind);},[leisureEnabled,leisureFocus,cameraView,attempt,visualStyle]);
  useEffect(() => {
    if (menuId === null) return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    // Place the menu above the fixed phone navigation before it can be tapped.
    // Nearest/smooth scrolling can leave its actions covered or still moving.
    if (mobileControls) menu.current?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setMenuId(null); host.current?.querySelector('canvas')?.focus(); } };
    window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close);
  }, [menuId, mobileControls]);
  useEffect(()=>{
    if(!persistent||!floorKind||!referenceVillaEnabled)return;
    const token=getToken(),viewer=crypto.randomUUID();let active=true;
    const sync=createFloorSync(()=>world.current,floorApi(floorKind,gathering.id,viewer),viewer,message=>{if(active)setServerFloorStatus(message);},()=>active&&!!token&&getToken()===token);
    floorSync.current=sync;const tick=()=>void sync.tick(floorMoving.current&&!document.hidden);
    tick();const timer=setInterval(tick,1000),visibility=()=>{if(document.hidden)sync.pause();else void sync.tick(floorMoving.current,true);};document.addEventListener('visibilitychange',visibility);const auth=()=>{if(getToken()!==token)sync.dispose();};window.addEventListener(AUTH_CHANGED,auth);window.addEventListener('storage',auth);
    return()=>{active=false;clearInterval(timer);document.removeEventListener('visibilitychange',visibility);window.removeEventListener(AUTH_CHANGED,auth);window.removeEventListener('storage',auth);sync.dispose();if(floorSync.current===sync)floorSync.current=null;};
  },[persistent,floorKind,referenceVillaEnabled,gathering.id,gathering.me,attempt]);
  function floorUnavailable(activity: VillaActivity | null) {
    if (!menuCompanion) return '请先选择自己的伙伴。';
    const own = floorLives.find(v => v.id === menuCompanion.id && v.phase !== 'returned');
    if (activity === null && !own) return '这位伙伴目前在一楼，无需下楼。';
    if (activity !== null && menuCompanion.leisure) return '请先结束这位伙伴当前的休闲，再安排上楼。';
    if (activity !== null && floorLives.some(v => v.id !== menuCompanion.id && v.phase !== 'returned' && v.activity === activity)) return ({ sleep: '二楼床位已有伙伴，请选择其他空位。', rest: '二楼沙发已有伙伴，请选择其他空位。', observe: '二楼观景位置已有伙伴，请稍后再试。' })[activity];
    return null;
  }
  async function arrangeFloor(activity:VillaActivity|null){
    if(!menuCompanion||menuCompanion.owner_id!==gathering.me||busy||menuLock.current)return;
    const unavailable = floorUnavailable(activity); if (unavailable) { setMenuError(unavailable); setMenuNotice(''); return; }
    menuLock.current=true;setMenuSending(true);setMenuError('');setMenuNotice('');
    try{if(persistent){if(!floorSync.current)throw new Error('二楼同步尚未就绪');await floorSync.current.command(menuCompanion.id,activity);}else{const ok=activity===null||activity==='observe'?world.current?.requestFloorVisit(menuCompanion.id,activity==='observe'):world.current?.requestFloorActivity(menuCompanion.id,activity);if(!ok)throw new Error('这个位置已有人，或伙伴还在途中。请稍后再试。');}setMenuNotice(activity === null ? '已安排下楼，伙伴会沿楼梯返回。' : '安排已保存，伙伴会依次通过楼梯。');}
    catch(e){setMenuError(e instanceof Error?e.message:'二楼安排尚未确认');}finally{menuLock.current=false;setMenuSending(false);}
  }
  function chooseView(next: HomeWorldView) {
    setUpperFloor({scope:upperScope,enabled:false});
    setLeisureFocus(null);
    if (next === 'indoor' || next === 'bedroom') setArchitecture({ ...houseContext, stamp: houseStamp, mode: 'interior' });
    setLocalView(next); onFocusView?.(next);
  }
  function chooseArchitecture(mode: 'interior' | 'exterior') {
    setUpperFloor({scope:upperScope,enabled:false});
    setLeisureFocus(null);
    setArchitecture({ ...houseContext, stamp: houseStamp, mode });
    if (mode === 'exterior') { if(leisureEnabled||naturalIndoor)world.current?.setDoorOpen?.('home-main-entry-door',false);setLocalView('overview'); onFocusView?.('overview'); }
  }
  useEffect(()=>{leisureRequest.current=async request=>{
    if(!persistent||!onLeisureAction||busy||menuLock.current||!gathering.companions.some(c=>c.id===request.actorId&&c.owner_id===gathering.me))return;
    menuLock.current=true;setMenuSending(true);setMenuError('');setMenuNotice('');setLeisureError('');
    try{await onLeisureAction(request);setMenuNotice(request.activity ? '休闲安排已保存，伙伴正在前往座位。' : '已结束休闲，伙伴恢复原活动。');}
    catch(e){setMenuError(errorText(e));setLeisureError(errorText(e));}
    finally{menuLock.current=false;setMenuSending(false);}
  };},[persistent,onLeisureAction,busy,gathering]);
  async function arrange(activity: ManualActivity) {
    if (!menuCompanion || menuCompanion.owner_id !== gathering.me || !onActivity || busy || menuLock.current) return;
    const visit = world.current?.getFloorVisit?.(menuCompanion.id);
    if(visit && visit.phase !== 'returned'){setMenuError('请先让伙伴下楼，再调整一楼活动。');return;}
    if(naturalIndoor&&!naturalActivityCapacity(gathering,menuCompanion.id,activity)){setMenuError(activity==='sleep'?'床位已满，请等伙伴起床后再安排。':'座位已满，请等伙伴起身后再安排。');return;}
    menuLock.current = true; setMenuSending(true); setMenuError(''); setMenuNotice('');
    try { if(!persistent)world.current?.stopLocalLeisure?.(menuCompanion.id); await onActivity(menuCompanion.id, activity); setMenuNotice(`已安排${activities[activity]}，位置和动作会随安排更新。`); }
    catch (e) { setMenuError(errorText(e)); }
    finally { menuLock.current = false; setMenuSending(false); }
  }
  return <section className={styles.world} aria-label="共同生活场景" data-world-mode={persistent?'saved':'preview'} data-season={gathering.season ?? 'base'}>
    <div className={styles.worldStage} data-controls-layout={mobileControls ? 'mobile' : 'desktop'}>
    <div className={styles.viewport+' '+styles.spatial} data-presentation={home ? 'home-world' : 'world-3d'} data-focus-view={dwelling ? cameraView : 'outdoor'} data-house-view={dwelling ? houseView : undefined} data-visual-style={visualStyle}>
      <div ref={host} className={styles.canvas} data-testid="living3d-canvas" />
      <div ref={labels} className={styles.labels} aria-live="polite" />
      {failed && <div className={styles.failure} role="status"><p>立体画面暂时无法显示，伙伴和住处记录都已保留。</p><button className="button" onClick={() => { setFailed(false); setAttempt(n => n + 1); }}>重新打开立体画面</button></div>}
      {!gathering.companions.length && <p className={styles.empty}>{emptyMessage ?? '家园已准备好，从下方带一位已有伙伴来相聚。'}</p>}
    </div>
    <div className={styles.worldControls} role="group" aria-label="家园查看与房门">
      {dwelling && !upperFloorView ? <div className={styles.regions} role="group" aria-label="家园镜头"><button type="button" aria-pressed={cameraView === 'overview'} onClick={() => chooseView('overview')}>看全景</button>{(['outdoor', 'indoor', 'bedroom'] as const).filter(area=>!(leisureEnabled||naturalIndoor)||houseView==='interior'||area==='outdoor').map(area => <button key={area} type="button" aria-pressed={cameraView === area} onClick={() => chooseView(area)}>{areaNames[area]}<span>{gathering.companions.filter(c => currentArea(c) === area && !floorLives.some(v=>v.id===c.id&&v.floor===2)).length}</span></button>)}</div>
        : upperFloorView?null:<div className={styles.badge}>{gathering.companions.length} 位伙伴在这里</div>}
      {referenceVillaEnabled&&houseView==='interior'?<div className={styles.regions} role="group" aria-label="楼层查看" style={{top:upperFloorView?undefined:'4.8rem'}}><button type="button" aria-pressed={upperFloorView} onClick={()=>{setLeisureFocus(null);setUpperFloor({scope:upperScope,enabled:!upperFloorView});}}>{upperFloorView?'返回一楼':'查看二楼'}</button>{upperFloorView?<><button type="button" onClick={()=>world.current?.toggleUpperDoor?.()}>开关二楼卧室门</button><span>二楼查看 · 点伙伴可上下楼</span></>:null}</div>:null}
      {homeLeisureEnabled&&!upperFloorView&&<div className={styles.soundControl}><button type="button" aria-pressed={lifeSound} disabled={soundBusy||failed} onClick={async()=>{setSoundBusy(true);try{const on=await world.current?.setLifeAudio?.(!lifeSound);setLifeSound(!!on);if(!lifeSound&&!on)setLeisureError('浏览器暂时无法播放音效，请点按钮再开启。');}finally{setSoundBusy(false);}}}>{lifeSound?(localQuietAudio?'关闭伙伴声音':'关闭生活音效'):(localQuietAudio?'打开伙伴声音':'打开生活音效')}</button>{lifeSound&&<small role="status">{speechStatus==='unavailable'?'此浏览器暂无本地中文音色':speechStatus==='speaking'?'伙伴正在说话':'本地中文朗读'}</small>}</div>}
      {dwelling && <div className={styles.houseControls}>
        {leisureEnabled||naturalIndoor ? houseView==='interior'?<button type="button" onClick={()=>chooseArchitecture('exterior')}>{naturalIndoor?'回到室外':'回到院子'}</button>:<span>点入户门，开门进屋</span>:<div className={styles.houseViews} role="group" aria-label="房屋展示">{(['interior', 'exterior'] as const).map(mode => <button type="button" key={mode} aria-pressed={houseView === mode} onClick={() => chooseArchitecture(mode)}>{mode === 'interior' ? '看室内' : '看外观'}</button>)}</div>}
        <div className={styles.doorViews} role="group" aria-label="房门开关" hidden={upperFloorView} style={upperFloorView?{display:"none"}:undefined}>{([{ id: 'home-main-entry-door', label: '入户门' }, { id: 'home-room-connection-door', label: '卧室门' }, { id: 'home-courtyard-gate', label: '院门' }] as const).filter(door=>!naturalIndoor||door.id!=='home-courtyard-gate').map(door => <button type="button" key={door.id} aria-label={companionDoorsEnabled&&houseView==='exterior'&&door.id==='home-main-entry-door'&&doors[door.id]?'进入客厅':(doors[door.id] ? '关闭' : '打开') + door.label} aria-pressed={doors[door.id]} disabled={failed || (door.id === 'home-room-connection-door' && houseView === 'exterior')} title={door.id === 'home-room-connection-door' && houseView === 'exterior' ? (leisureEnabled||naturalIndoor?'先开门进屋，再开关卧室门':'先看室内，再开关卧室门') : undefined} onClick={() => {if((leisureEnabled||naturalIndoor)&&houseView==='exterior'&&door.id==='home-main-entry-door'){world.current?.setDoorOpen?.(door.id,true);if(companionDoorsEnabled)chooseView('indoor');}else world.current?.toggleDoor?.(door.id);}}>{(leisureEnabled||naturalIndoor)&&houseView==='exterior'&&door.id==='home-main-entry-door'?'开门进屋':(doors[door.id] ? '关' : '开')+door.label}</button>)}</div>
      </div>}
    </div>
      {menuCompanion && !failed && <div ref={menu} data-menu-placement={mobileControls ? 'panel' : 'anchor'} className={styles.actionMenu} role="group" aria-label={`${menuCompanion.name}的活动`}>
        <div className={styles.menuHeading}><strong>{menuCompanion.name}</strong><button type="button" aria-label="关闭活动菜单" onClick={() => { setMenuId(null); host.current?.querySelector('canvas')?.focus(); }}>×</button></div>
        <p>{home && !floorLives.some(v=>v.id===menuCompanion.id&&v.floor===2) && `${areaNames[currentArea(menuCompanion)]} · `}{activityLabel(menuCompanion)}</p>
        {menuError && <p role="alert">{menuError}</p>}{menuNotice && <p role="status">{menuNotice}</p>}
        {parseAvatar3D(menuCompanion.avatar3d, menuCompanion.id).kind === 'unavailable' && <p>立体形象待准备，原资料仍保留。</p>}
        {menuCompanion.owner_id === gathering.me ? <><div className={styles.menuActivities}>{([...(naturalEnabled&&!naturalIndoor?[]:[{ id: 'rest', label: '休息' }]), ...(dwelling ? [{ id: 'sleep', label: '睡觉' }] : []), { id: 'walk', label: '散步' }, { id: 'observe', label: '观察' }, { id: 'talk', label: '相聚' }] as Array<{ id: ManualActivity; label: string }>).map(activity => <button type="button" key={activity.id} aria-label={`安排${activity.label}`} disabled={busy || menuSending || !onActivity} onClick={() => void arrange(activity.id)}>{activity.label}</button>)}</div><small>{menuSending ? (naturalIndoor?'正在切换活动…':'正在保存活动…') : '这些活动免费，不会发起 AI 对话。'}</small>{leisureEnabled&&<div className={styles.menuActivities}>{leisureKinds.map(kind=><button type="button" key={kind} aria-label={'安排'+activities[kind]} disabled={busy||menuSending||(persistent&&!onLeisureAction)} onClick={()=>world.current?.startLocalLeisure(kind,menuCompanion.id)}>{activities[kind]}</button>)}{localActivity(menuCompanion.id)&&<button type="button" onClick={()=>world.current?.stopLocalLeisure?.(menuCompanion.id)}>结束本次休闲</button>}</div>}</>
          : <><p>{leisureEnabled&&!persistent?'这是本地合成伙伴，可预览休闲活动，不改变线上记录。':'这是朋友的伙伴，活动由它的主人安排。'}</p>{leisureEnabled&&!persistent&&<div className={styles.menuActivities}>{leisureKinds.map(kind=><button type="button" key={kind} aria-label={'安排'+activities[kind]} disabled={busy||menuSending||(persistent&&!onLeisureAction)} onClick={()=>world.current?.startLocalLeisure(kind,menuCompanion.id)}>{activities[kind]}</button>)}{localActivity(menuCompanion.id)&&<button type="button" onClick={()=>world.current?.stopLocalLeisure(menuCompanion.id)}>结束本次休闲</button>}</div>}</>}
        {referenceVillaEnabled&&(!persistent||!!floorKind)&&menuCompanion.owner_id===gathering.me&&<div className={styles.menuActivities}>{[true,false].map(up=><button type="button" key={String(up)} disabled={busy||menuSending} onClick={()=>void arrangeFloor(up?'observe':null)}>{up?'上楼看看':'下楼返回原活动'}</button>)}{(['rest','sleep'] as const).map(activity=><button type="button" key={activity} disabled={busy||menuSending} onClick={()=>void arrangeFloor(activity)}>{activity==='rest'?'去二楼沙发休息':'去二楼床上睡觉'}</button>)}{floorLives.some(v => v.id !== menuCompanion.id && v.activity === 'sleep') && <small>二楼床位已有伙伴；可以安排其他空位，一楼伙伴仍可继续自己的活动。</small>}<small>{persistent?'楼梯依次通行，床和沙发各一位；二楼进度保存到服务器。':'楼梯依次通行，床和沙发各一位；进度保存在当前浏览器。仅本地预览。'}</small>{!persistent&&floorSave&&<small role="status">{({saved:'本地进度已保存',restored:'已恢复上次本地进度',unavailable:'浏览器保存不可用，刷新后可能无法恢复。',rejected:'上次进度与当前场景不兼容，已保留旧记录；重新安排后建立新进度。'})[floorSave]}</small>}</div>}
      </div>}

    </div>
    {persistent&&floorKind&&referenceVillaEnabled&&<div role="status"><span>{serverFloorStatus}</span><button type="button" disabled={busy} onClick={()=>void floorSync.current?.reconcile()}>核对二楼进度</button></div>}
    <div className={styles.tools} aria-label="场景视角">
      <span>{mobileControls ? '单指上下滑动页面 · 双指转动和缩放画面' : '拖动画面旋转 · 双指缩放'}</span>
      <button type="button" aria-label="向左看" onClick={() => world.current?.rotate(.32)}>↶</button>
      <button type="button" aria-label="向右看" onClick={() => world.current?.rotate(-.32)}>↷</button>
      <button type="button" aria-label="拉近" onClick={() => world.current?.zoom(.85)}>＋</button>
      <button type="button" aria-label="拉远" onClick={() => world.current?.zoom(1.15)}>－</button>
      <button type="button" onClick={() => world.current?.reset()}>恢复视角</button>
      <button type="button" aria-pressed={paused} onClick={() => { const next = !paused; setPaused(next); onPausedChange?.(next); }}>{paused ? '继续画面' : '暂停画面'}</button>
      {gathering.events.some(e => e.kind === 'dialogue' && e.origin === 'real_provider' && e.lines?.length) && <button type="button" aria-pressed={replay} onClick={() => setReplay(v => !v)}>{replay ? '收起交流气泡' : '回看最近交流'}</button>}
    </div>
    {leisureEnabled&&!persistent&&<div className={styles.tools} aria-label="本地休闲预览">{leisureKinds.map(kind=><button type="button" key={kind} aria-pressed={localAssignments.some(a=>a.activity===kind)} onClick={()=>world.current?.startLocalLeisure(kind)}>{activities[kind]}</button>)}{homeLeisureEnabled&&<button type="button" aria-pressed={leisureState?.television.powered??false} onClick={()=>world.current?.toggleLocalLeisure('television')}>{leisureState?.television.powered?'关闭电视':'打开电视'}</button>}<button type="button" disabled={!localAssignments.length} onClick={()=>world.current?.stopLocalLeisure()}>结束休闲，恢复原活动</button>{homeLeisureEnabled&&localMahjongGame&&<button type="button" onClick={()=>world.current?.restartLocalMahjong()}>新一局麻将</button>}<span>{naturalLeisureEnabled?'点伙伴、茶桌或长椅安排活动；伙伴走过去坐稳后再喝茶。仅本地合成预览，不保存到线上。':'点人物选择活动，或点茶桌、电视、麻将桌和长椅。仅本地合成演示，不保存到线上。声音为本地环境与动作音效，可在画面中开启。'}</span>{leisureError&&<p role="alert">{leisureError}</p>}</div>}
    {persistent&&leisureError&&<p role="alert">{leisureError}</p>}
    {homeLeisureEnabled&&localMahjongGame&&localMahjongRules==='sichuan'&&<details className={styles.note} aria-label="四川麻将规则与本局积分"><summary>四川麻将 · 规则与本局积分</summary><p>血战到底：108 张万、筒、条，先换三张、再定缺，不吃牌。胡牌后其余伙伴继续，三家胡牌或牌墙摸完结束。</p><p>本桌四番封顶，0 番计 1 分。这里只记录本局积分，不涉及现金。</p>{localMahjongInfo?.scope===gathering.id&&localMahjongInfo.rules==='sichuan'?<><p role="status">{localMahjongInfo.status==='won'?'本局结束':localMahjongInfo.status==='exhausted'?'牌墙已摸完':(mahjongPhases[localMahjongInfo.phase]??'本局进行中')} · 剩余 {localMahjongInfo.wallRemaining} 张</p><ul>{localMahjongInfo.players.map(player=><li key={player.actorId}>{gathering.companions.find(companion=>companion.id===player.actorId)?.name??'在座伙伴'} · {player.missingSuit?'定缺'+player.missingSuit:'尚未定缺'}{player.won?' · 已胡牌':''} · {player.score>0?'+':''}{player.score} 分</li>)}</ul></>:<p>四位伙伴入座后显示本局积分。</p>}</details>}
    {leisureEnabled&&gathering.companions.some(c=>c.activity==='talk')&&<p className={styles.note}>相聚闲聊采用免费预设对白；真实 AI 交流需另行开启。请选择相聚加入伙伴所在区域，抵达后开始闲聊。</p>}
    <div className={styles.companions} aria-label="在场伙伴">
      {gathering.companions.map(c => <button key={c.id} type="button" aria-label={`查看${c.name}的生活近况`} aria-pressed={c.id === focusedId} onClick={() => select.current(c.id)}><strong>{c.name}</strong><span>{home && !floorLives.some(v=>v.id===c.id&&v.floor===2) && `${areaNames[currentArea(c)]} · `}{activityLabel(c)}</span>{c.id === focusedId && <span className={styles.selection}>已选中</span>}{parseAvatar3D(c.avatar3d, c.id).kind === 'unavailable' && <small>立体形象待准备</small>}</button>)}
    </div>
    <p className={styles.note}>{!animate || paused ? '画面已保持静态，仍可点选伙伴查看近况。' : home ? houseView === 'exterior' ? leisureEnabled?'点入户门开门进屋；可拖动旋转、缩放查看整个小院。':'外观模式可看完整房屋；点击客厅、卧室或屋内伙伴，即可查看室内。' : '近侧墙为半透明，方便看清室内；点门开关，点自己的伙伴安排免费活动。' : '伙伴按已保存的活动走动；气泡中的台词来自实际共同交流记录。'}</p>
  </section>;
}
