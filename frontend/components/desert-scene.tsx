'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import type { Props } from './living-scene';
import type { LivingItem } from '@/lib/contracts';
import { api, errorText } from '@/lib/api';
import { kindMeta } from '@/lib/living-ui';
import { crops, groundPoint, oasisKinds, templates, widths, type Template } from '@/lib/oasis';
import SceneCompanions from './scene-companions';
import TreeGrowthCard from './tree-growth';
import TreeOverview from './tree-overview';
import SpaceDecorations from './space-decorations';
import SeasonSettingsPanel from './season-settings';
import LifeJournal from './life-journal';
import LifeSimulation from './life-simulation';
import LifeRuntimePanel from './life-runtime-panel';
import SceneActivityFeedback from './scene-activity-feedback';
import SceneLifeNow from './scene-life-now';
import SceneNavigation, { SceneSection, focusSceneSection } from './scene-navigation';
import type { RuntimeView } from '@/lib/life-runtime';
import { seasonNames, type Season } from '@/lib/seasons';
import OasisBackdrop, { OasisSeasonPreview } from './oasis-backdrop';
import styles from './desert-scene.module.css';

function PropArt({kind, flipped=false}: {kind:string;flipped?:boolean}) {
 const id = useId(), crop = crops[oasisKinds.indexOf(kind)];
 if (!crop) return <span className={styles.seedling} aria-hidden="true">🌱</span>;
 const [x,y,w,h]=crop;
 return <svg aria-hidden="true" viewBox={crop.join(' ')} preserveAspectRatio="xMidYMax meet" style={{transform:flipped?'scaleX(-1)':undefined}}><defs><clipPath id={id}><rect x={x} y={y} width={w} height={h}/></clipPath></defs><image href="/oasis/props.png" width="1448" height="1086" clipPath={`url(#${id})`}/></svg>;
}
type Gesture={id:string;pointer:number;revision:number;startX:number;startY:number;x:number;y:number;moved:boolean;rect:DOMRect};
export default function DesertScene({space,companion,companions,readOnly=false,visible=true,onChange}:Props) {
 const [runtimeView,setRuntimeView]=useState<RuntimeView|null>(null);
 const [runtimeRefresh,setRuntimeRefresh]=useState(0);
 const [arranging,setArranging]=useState(false);
 const runtimeEnabled=visible&&!readOnly&&space.mode==='private'&&(process.env.NEXT_PUBLIC_LIFE_RUNTIME_ENABLED==='true'||process.env.NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW==='true');
 const [selected,setSelected]=useState<string|null>(null),[placing,setPlacing]=useState<string|null>(null),[template,setTemplate]=useState<Template|null>(null);
 const [category,setCategory]=useState('全部'),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 const [ghost,setGhost]=useState<{x:number;y:number}|null>(null),[moving,setMoving]=useState<Gesture|null>(null),[season,setSeason]=useState<Season|null>(null);
 const settingsPanel=useRef<HTMLDetailsElement>(null);
 const plantPanel=useRef<HTMLDivElement>(null);
 const activityPanel=useRef<HTMLDivElement>(null),journalPanel=useRef<HTMLDivElement>(null);
 const journalEnabled=visible&&space.mode==='private'&&process.env.NEXT_PUBLIC_LIFE_JOURNAL==='true';
 const goActivity=()=>focusSceneSection(activityPanel.current);
 const backToScene=()=>focusSceneSection(board.current);
 const board=useRef<HTMLDivElement>(null),gesture=useRef<Gesture|null>(null),lock=useRef(false),alive=useRef(true),shown=useRef(visible),suppress=useRef(false);
 useEffect(()=>{shown.current=visible;},[visible]);
 const present=companions??(companion?[companion]:[]),disabled=busy||uncertain||readOnly||!visible;
 const placed=space.items.filter(i=>!i.stored),stored=space.items.filter(i=>i.stored),item=placed.find(i=>i.id===selected);
 function cancel(){gesture.current=null;setMoving(null);setPlacing(null);setGhost(null);setTemplate(null);}
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{
  const cancelGesture=()=>{gesture.current=null;setMoving(null);setPlacing(null);setGhost(null);setTemplate(null);};
  const stopDrag=()=>{gesture.current=null;setMoving(null);};
  const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')cancelGesture();};
  window.addEventListener('keydown',escape);window.addEventListener('blur',stopDrag);window.addEventListener('resize',stopDrag);
  if(!visible)cancelGesture();
  return()=>{window.removeEventListener('keydown',escape);window.removeEventListener('blur',stopDrag);window.removeEventListener('resize',stopDrag);};
 },[visible]);
 useEffect(()=>{
  const leave=()=>{if(readOnly||!visible||document.visibilityState==='hidden'){gesture.current=null;setMoving(null);setPlacing(null);setGhost(null);setTemplate(null);if(readOnly||!visible){setSelected(null);setArranging(false);}}};
  leave();document.addEventListener('visibilitychange',leave);return()=>document.removeEventListener('visibilitychange',leave);
 },[visible,readOnly]);
 async function act(command:Record<string,unknown>){
  if(disabled||lock.current||!alive.current||!shown.current)return;
  if(command.action!=='care'&&!arranging)return;
  lock.current=true;setBusy(true);setError('');cancel();
  try{const result=await api.living.action(space.id,crypto.randomUUID(),space.revision,command);if(alive.current){onChange(result);setMessage(command.action==='care'?'照料已保存':'布置已保存，下次回来还在。');}}
  catch(e){if(alive.current){setError(errorText(e));try{const latest=await api.living.space(space.id);if(alive.current){onChange(latest);setUncertain(false);setSelected(null);}}catch{if(alive.current)setUncertain(true);}}}
  finally{lock.current=false;if(alive.current)setBusy(false);}
 }
 async function refresh(){if(lock.current)return;lock.current=true;setBusy(true);cancel();try{const latest=await api.living.space(space.id);if(alive.current){onChange(latest);setUncertain(false);setError('');}}catch(e){if(alive.current)setError(errorText(e));}finally{lock.current=false;if(alive.current)setBusy(false);}}
 function choose(kind:string){cancel();setSelected(null);setPlacing(kind);setGhost({x:.5,y:.5});setMessage('点一下沙地，就放在这里。');board.current?.scrollIntoView?.({block:'center',behavior:'smooth'});}
 function move(target:LivingItem,x:number,y:number){if(x<0||x>1||y<0||y>1){setMessage('再往里面放一点吧。');return;}void act({action:'move',item_id:target.id,x:Math.round(x*1000)/1000,y:Math.round(y*1000)/1000});}
 function down(e:PointerEvent<HTMLButtonElement>,target:LivingItem){
  suppress.current=false;if(!arranging||disabled||template||placing||e.button!==0)return;
  const rect=board.current?.getBoundingClientRect();if(!rect)return;
  e.preventDefault();setSelected(target.id);e.currentTarget.setPointerCapture?.(e.pointerId);
  gesture.current={id:target.id,pointer:e.pointerId,revision:space.revision,startX:e.clientX,startY:e.clientY,x:target.x,y:target.y,moved:false,rect};
 }
 function drag(e:PointerEvent<HTMLButtonElement>){
  const d=gesture.current,rect=board.current?.getBoundingClientRect();if(!d||d.pointer!==e.pointerId)return null;
  if(!visible||!rect||d.revision!==space.revision||rect.top!==d.rect.top||rect.left!==d.rect.left||rect.width!==d.rect.width||rect.height!==d.rect.height){gesture.current=null;setMoving(null);return null;}
  const target=space.items.find(i=>i.id===d.id)!;const dx=e.clientX-d.startX,dy=e.clientY-d.startY;
  const next={...d,x:target.x+dx/(rect.width*.82),y:target.y+dy/(rect.height*.49),moved:d.moved||Math.hypot(dx,dy)>5};gesture.current=next;if(next.moved){suppress.current=true;setMoving(next);}return next;
 }
 function up(e:PointerEvent<HTMLButtonElement>){const d=drag(e);gesture.current=null;setMoving(null);if(d?.moved){const target=space.items.find(i=>i.id===d.id);if(target)move(target,d.x,d.y);}}
 const display=template?templates[template].map(([kind,x,y],i)=>({id:`preview-${i}`,kind,x:(x-9)/82,y:(y-44)/49,flipped:false})):placed;
 const position=(kind:string,x:number,y:number):CSSProperties=>({left:`${9+82*x}%`,top:`${44+49*y}%`,width:`${widths[oasisKinds.indexOf(kind)]??12}%`,zIndex:Math.round(44+49*y)});
 const locateActivityItem = (id: string)=>{
   if(disabled||template||placing||moving||!placed.some(item=>item.id===id))return;
   setSelected(id);
   const target=Array.from(board.current?.querySelectorAll<HTMLButtonElement>('[data-living-item-id]')??[]).find(node=>node.dataset.livingItemId===id);
   target?.focus({preventScroll:true});target?.scrollIntoView({block:'center'});
  };
 return <section className={styles.editor} aria-label="沙漠绿洲布置">
  <header className={styles.header}><div><small>属于你们的一小片沙漠</small><h2>把日子，安放在绿洲里</h2><p>吹吹风、喝杯茶，慢慢布置你们的小天地。</p></div><button className="button ghost" disabled={busy} onClick={()=>void refresh()}>刷新状态</button></header>
  <div className={styles.seasonBar}><span>{season ? `${seasonNames[season]}的绿洲` : '基础景色'}</span><button type="button" onClick={()=>{if(settingsPanel.current){settingsPanel.current.open=true;settingsPanel.current.scrollIntoView({block:'start',behavior:'smooth'});settingsPanel.current.querySelector('summary')?.focus();}}}>{readOnly?'查看四季':'四季设置'}</button></div>
  {visible&&space.mode==='private'&&<SceneNavigation onPlants={()=>focusSceneSection(plantPanel.current)} onActivity={runtimeEnabled?goActivity:undefined} onJournal={journalEnabled?()=>focusSceneSection(journalPanel.current):undefined} onSeason={()=>focusSceneSection(settingsPanel.current)}/>}
  {!readOnly&&<div className={styles.toolbar}><button type="button" aria-pressed={arranging} disabled={disabled} onClick={()=>{cancel();setSelected(null);setArranging(!arranging);setMessage('');}}>{arranging?'完成布置':'布置场景'}</button><span className={styles.help}>{arranging?'每次调整都会保存；完成布置后，工具就收起来。':'先看看伙伴和风景，想挪动物件时再开始布置。'}</span></div>}
  {!readOnly&&arranging&&<div className={styles.toolbar}><button disabled={disabled} onClick={()=>{cancel();setTemplate('water');}}>预览水边小憩</button><button disabled={disabled} onClick={()=>{cancel();setTemplate('camp');}}>预览星光营地</button><button disabled={disabled||!space.can_undo} onClick={()=>void act({action:'undo'})}>撤销一步</button></div>}
  {template&&<div className={styles.preview} role="status"><strong>方案预览 · {template==='water'?'水边小憩':'星光营地'}</strong><span>应用后，已有物件会进入收纳；可整套撤销。</span><button disabled={disabled} onClick={()=>void act({action:'layout',template})}>应用这套布置</button><button onClick={cancel}>取消预览</button></div>}
  {error&&<p role="alert" className="form-error">{error}</p>}{uncertain&&<p>保存结果暂时无法确认，请先点“刷新状态”核对。</p>}
  {!readOnly&&arranging&&placed.length>0&&!template&&<label className={styles.picker}>物件重叠了？从这里选 <select aria-label="选择绿洲物件" disabled={disabled||!!placing} value={selected??''} onChange={e=>setSelected(e.target.value||null)}><option value="">选择物件</option>{placed.map((i,n)=><option key={i.id} value={i.id}>{n+1}. {kindMeta[i.kind]?.name}</option>)}</select></label>}
  {arranging&&<p className={styles.help}>{placing?`正在放置${kindMeta[placing].name} · 点沙地选位置`:'直接拖动物件；点选后，也可以点空地或用方向键移动。'}{placing&&<button onClick={cancel}>取消放置</button>}</p>}
  <div ref={board} tabIndex={-1} data-season={season??'base'} className={styles.board} role="group" aria-label="绿洲沙地" aria-busy={busy} onPointerMove={e=>{if(placing&&board.current)setGhost(groundPoint(e.clientX,e.clientY,board.current.getBoundingClientRect()));}} onClick={e=>{if(!arranging||disabled||template||e.target!==e.currentTarget)return;const point=groundPoint(e.clientX,e.clientY,e.currentTarget.getBoundingClientRect());if(!point){setMessage('请放在前面的沙地上。');return;}if(placing)void act({action:'place',kind:placing,...point});else if(item)move(item,point.x,point.y);}}>
   <OasisBackdrop season={season}/><span className={styles.sceneLabel}>OASIS / {season ? seasonNames[season] : '我们的小天地'}</span>
   {!display.length&&!placing&&(!runtimeEnabled||arranging)&&<div className={styles.empty}>{readOnly?'这里还没有布置物件。':arranging?'先试试上方的「水边小憩」':'点「布置场景」，添点喜欢的东西吧。'}{arranging&&<small>或从下方挑一件喜欢的，点沙地放下。</small>}</div>}
   {display.map(target=>{const m=moving?.id===target.id?moving:null;return <button key={target.id} data-living-item-id={template?undefined:target.id} className={`${styles.object} ${selected===target.id?styles.selected:''}`} style={{...position(target.kind,m?.x??target.x,m?.y??target.y),touchAction:arranging?'none':'pan-y',cursor:arranging?'grab':'pointer'}} aria-label={`选择${kindMeta[target.kind]?.name??target.kind}`} aria-pressed={selected===target.id} disabled={disabled||!!template||!!placing} onPointerDown={e=>down(e,target as LivingItem)} onPointerMove={drag} onPointerUp={up} onPointerCancel={()=>{gesture.current=null;setMoving(null);}} onLostPointerCapture={()=>{gesture.current=null;setMoving(null);}} onClick={e=>{e.stopPropagation();if(suppress.current){suppress.current=false;return;}setSelected(target.id);}} onKeyDown={e=>{const delta:Record<string,[number,number]>={ArrowLeft:[-.02,0],ArrowRight:[.02,0],ArrowUp:[0,-.02],ArrowDown:[0,.02]};if(arranging&&delta[e.key]&&!disabled&&!template){e.preventDefault();const [dx,dy]=delta[e.key];move(target as LivingItem,target.x+dx,target.y+dy);}}}><PropArt kind={target.kind} flipped={target.flipped}/><span className={styles.objectName}>{kindMeta[target.kind]?.name}</span></button>;})}
   {placing&&ghost&&<div className={`${styles.object} ${styles.ghost}`} style={position(placing,ghost.x,ghost.y)}><PropArt kind={placing}/></div>}
   {runtimeEnabled&&<SceneLifeNow onSettings={goActivity} view={runtimeView} space={space} companions={present} editing={arranging||disabled||!!template||!!placing||!!moving||!!selected} onLocate={locateActivityItem} onRefresh={()=>setRuntimeRefresh(n=>n+1)} onUpdated={snapshot=>{setRuntimeView({snapshot,stale:false});setRuntimeRefresh(n=>n+1);}}/>}
   {visible&&present.length>0&&<SceneCompanions key={present.map(p=>p.id).sort().join(':')} companions={present} space={space} view={runtimeView} editing={arranging||disabled||!!template||!!placing||!!moving||!!selected}/>}
  </div>
  {runtimeEnabled&&<SceneActivityFeedback view={runtimeView} space={space} companions={present} locatingDisabled={disabled||!!template||!!placing||!!moving} onLocate={locateActivityItem}/>}
  <p className={styles.status} role="status">{busy?'正在保存…':moving?'松手保存位置':message||`${placed.length} 件摆在这里 · ${stored.length} 件收纳中`}</p>
  {!readOnly&&item&&!template&&!placing&&<div className={styles.toolbar} role="toolbar" aria-label="物件操作"><strong>{kindMeta[item.kind]?.name}</strong>{arranging&&<>{([['←',-.04,0],['↑',0,-.04],['↓',0,.04],['→',.04,0]] as const).map(([label,dx,dy])=><button key={label} disabled={disabled||item.x+dx<0||item.x+dx>1||item.y+dy<0||item.y+dy>1} onClick={()=>move(item,item.x+dx,item.y+dy)}>{label}</button>)}<button disabled={disabled} onClick={()=>void act({action:'turn',item_id:item.id})}>转向</button><button disabled={disabled} onClick={()=>void act({action:'store',item_id:item.id})}>收纳</button></>}<button onClick={()=>setSelected(null)}>收起操作</button></div>}
  {!readOnly&&visible&&item&&!template&&!placing&&<TreeGrowthCard item={item} observedAt={space.observed_at} disabled={disabled} refreshing={busy} onCare={()=>void act({action:'care',item_id:item.id})} onRefresh={()=>void refresh()}/> }
  {!readOnly&&arranging&&<div className={styles.catalog}><h3>添一点喜欢的东西</h3><div className={styles.tabs}>{['全部','植物','休憩','装饰'].map(c=><button key={c} aria-pressed={category===c} onClick={()=>setCategory(c)}>{c}</button>)}</div><div className={styles.grid}>{oasisKinds.filter(k=>category==='全部'||(category==='植物'?['palm','cactus','flowerpot','tree']:category==='休憩'?['shade','cushion','tea_table','tent','bench']:['rock','pond','string_lights','sign']).includes(k)).map(kind=><button key={kind} disabled={disabled||!!template} aria-label={`放置${kindMeta[kind].name}`} aria-pressed={placing===kind} onClick={()=>choose(kind)}><PropArt kind={kind}/><strong>{kindMeta[kind].name}</strong>{kind==='tree'&&<small>可以照料长大</small>}</button>)}</div></div>}
  {stored.length>0&&<details className={styles.storage}><summary>收纳箱 · {stored.length} 件</summary><div className={styles.grid}>{stored.map(i=><div key={i.id} className={i.kind==='tree'?styles.storedTree:undefined}><PropArt kind={i.kind} flipped={i.flipped}/><span>{kindMeta[i.kind]?.name}</span>{i.kind==='tree'&&<details><summary>{i.stage==='mature'?'已长成 · 已收纳':'已收纳 · 暂停成长'}</summary><TreeGrowthCard item={i} observedAt={space.observed_at}/></details>}{!readOnly&&arranging&&<button disabled={disabled||!!template} onClick={()=>void act({action:'restore',item_id:i.id,x:i.x,y:i.y})}>摆回原位</button>}</div>)}</div></details>}
  {visible&&space.mode==='private'&&<SceneSection sectionRef={plantPanel} title="植物照料" onBack={backToScene}><TreeOverview key={space.id} space={space} onLocate={readOnly?undefined:locateActivityItem} onRefresh={()=>void refresh()} busy={busy} locatingDisabled={disabled||!!template||!!placing||!!moving}/></SceneSection>}
  {journalEnabled&&<SceneSection sectionRef={journalPanel} title="生活记录" onBack={backToScene}><LifeJournal spaceId={space.id} revision={space.revision} visible={visible} companionId={Number(space.companion_id)} sceneType={space.scene_type} items={space.items} onLocate={readOnly?undefined:locateActivityItem} locatingDisabled={disabled||!!template||!!placing||!!moving}/></SceneSection>}
  <details ref={settingsPanel} tabIndex={-1} aria-label="四季区域" className={styles.settings}><summary>四季与纪念装饰</summary><button type="button" aria-label="从四季回到场景" onClick={backToScene}>↑ 回到场景</button><p>四季由你选择，确认后更换景色，布置和成长进度保持原样。</p>{space.mode==='private'&&<SeasonSettingsPanel spaceId={space.id} onSeason={setSeason} readOnly={readOnly} renderPreview={current=><OasisSeasonPreview season={current}/>}/>}<SpaceDecorations spaceId={space.id} kind="private"/></details>
  {!readOnly&&space.mode==='private'&&process.env.NEXT_PUBLIC_LIFE_SIMULATION==='true'&&<LifeSimulation spaceId={space.id}/>}{runtimeEnabled&&<SceneSection sectionRef={activityPanel} title="活动设置" onBack={backToScene}><LifeRuntimePanel spaceId={space.id} onSnapshot={setRuntimeView} refreshVersion={runtimeRefresh} historyScene={{space,companions:present,onLocate:locateActivityItem,locatingDisabled:disabled||!!template||!!placing||!!moving}}/></SceneSection>}
 </section>;
}
