'use strict';
const $ = (selector) => document.querySelector(selector);
let state = null;
let busy = false;
let pendingRequest = null;
const icons = {place_bench:'🪑',light_campfire:'🔥',release_fireflies:'✦',plant_tree:'🌳',plant_flower:'🌷',grow_mushroom:'🍄',add_pond:'💧',light_rain:'🌧',quiet:'☾'};
const statusNames = {awaiting_confirmation:'等你确认',completed:'这一轮已完成',cancelled:'没有执行',failed:'已停止',running:'正在查看',finishing:'正在核对'};

async function api(path, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch('/api/' + path, {method:payload ? 'POST' : 'GET', headers:payload ? {'Content-Type':'application/json'} : {}, body:payload ? JSON.stringify(payload) : undefined, signal:controller.signal});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || '暂时无法完成，请刷新核对状态。');
    return data;
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('连接暂时中断，请刷新核对是否已完成。输入已经为你保留。');
    throw error;
  } finally { clearTimeout(timer); }
}
function node(tag, cls, text) {const e = document.createElement(tag); if(cls)e.className=cls; if(text!==undefined)e.textContent=text; return e;}
function showError(message='') {$('#error').hidden=!message; $('#error').textContent=message;}
function pending() {return state?.runs.find(run => run.status === 'awaiting_confirmation');}
function controls() {
  const waiting = Boolean(pending());
  $('#send').disabled=busy || waiting || !state || !$('#message').value.trim();
  $('#message').disabled=busy || waiting || !state;
  $('.suggestions').querySelectorAll('button').forEach(b=>b.disabled=busy || waiting || !state);
  $('#undo').disabled=busy || !state?.can_undo;
  $('#reset').disabled=busy || !state;
  document.querySelectorAll('[data-decision]').forEach(b=>b.disabled=busy);
  $('#composer-hint').textContent=waiting?'先决定这次小变化，再告诉果果新的愿望。':busy?'正在核对花园与保存状态…':'它会先提出建议，等你确认才改变花园。';
}
function drawGarden(elements) {
  const art=[];
  const treePositions=[[158,180],[414,160],[109,221],[463,208],[196,145],[371,141],[478,255]];
  treePositions.slice(0,Math.min(7,elements.tree)).forEach(([x,y])=>art.push(`<use class="garden-object" href="#tree-sprite" x="${x}" y="${y}" width="57" height="82"/>`));
  if(elements.pond)art.push('<g class="garden-object"><ellipse cx="402" cy="318" rx="49" ry="20" fill="#aec1ac"/><ellipse cx="402" cy="316" rx="44" ry="16" fill="url(#water)"/><path d="M375 314q25-10 49 0m-40 7q14-5 27-2" stroke="#b6f4ed" stroke-width="2" opacity=".6" fill="none"/></g>');
  if(elements.bench)art.push('<g class="garden-object" transform="translate(390 256)"><ellipse cx="40" cy="53" rx="51" ry="10" fill="#163c46" opacity=".4"/><path d="m2 25 73-6v13L2 39Z" fill="#c29e87" stroke="#dec4a0" stroke-width="1.5"/><path d="M10 3 71 0v17L10 23Z" fill="#a98076" stroke="#d2b09b" stroke-width="2"/><path d="M14 38v18m50-23v16M15 22v11m50-17v10" stroke="#765f65" stroke-width="5"/></g>');
  const flowerPositions=[[173,290],[206,318],[390,219],[457,275],[135,271],[334,326]];
  flowerPositions.slice(0,elements.flower).forEach(([x,y])=>art.push(`<use class="garden-object" href="#flower-sprite" x="${x}" y="${y}" width="33" height="33"/>`));
  [[240,302],[218,274],[394,290],[470,248]].slice(0,elements.mushroom).forEach(([x,y])=>art.push(`<use class="garden-object" href="#mushroom-sprite" x="${x}" y="${y}" width="30" height="30"/>`));
  if(elements.campfire)art.push('<g class="garden-object" transform="translate(215 287)"><ellipse cx="20" cy="25" rx="50" ry="22" fill="#ffba72" opacity=".14" filter="url(#soft)"/><path d="m2 26 33 8m-30 0 32-9" stroke="#816662" stroke-width="7" stroke-linecap="round"/><path d="M20-18c6 15 26 28 14 43-12 13-32 5-30-9 0-9 9-17 9-26 5 6 5 9 6 12 5-8 3-14 1-20Z" fill="#eaa260"/><path d="M20 1c10 12 17 18 6 26-12 6-15-9-6-26Z" fill="#f6df9d"/></g>');
  if(elements.fireflies)[[168,217],[434,184],[250,212],[440,292],[200,281],[368,208],[352,320]].forEach(([x,y],i)=>art.push(`<g class="firefly" style="animation-delay:${i*.3}s"><circle cx="${x}" cy="${y}" r="8" fill="#d5f6ac" opacity=".13"/><circle cx="${x}" cy="${y}" r="2" fill="#efffd3"/></g>`));
  if(elements.cloud)art.push('<g fill="#8999b8" opacity=".35"><ellipse cx="218" cy="123" rx="45" ry="13"/><ellipse cx="202" cy="115" rx="22" ry="16"/><ellipse cx="230" cy="116" rx="22" ry="14"/></g>');
  $('#garden-objects').innerHTML=art.join('');
  $('#rain').toggleAttribute('hidden',!elements.rain);
  $('#rain').innerHTML=elements.rain?Array.from({length:14},(_,i)=>`<path class="rain-drop" style="animation-delay:${i*.13}s" d="M${155+i*24} ${145+(i%4)*22}l-5 14"/>`).join(''):'';
  const inventory=$('#inventory');inventory.replaceChildren();
  const labels={tree:'树',flower:'花丛',mushroom:'蘑菇',pond:'水池',bench:'长椅',campfire:'营火',fireflies:'萤火虫'};
  let count=0;
  for(const [key,label]of Object.entries(labels)){if(elements[key]){inventory.append(node('span','',`${label} ${elements[key]}`));count+=elements[key];}}
  if(elements.rain)inventory.append(node('span','',elements.sound?'小雨 · 视觉效果':'小雨 · 安静'));
  if(!count&&!elements.rain)inventory.append(node('span','','✧ 还没有布置物件'));
  $('#world-caption').textContent=count?`已经有 ${count} 处小布置，每一处都是你的选择。`:'一座小小的岛，等着我们的第一个愿望。';
}
function render() {
  drawGarden(state.elements);
  const waiting=pending();
  const pill=$('#garden-status');pill.classList.toggle('waiting',Boolean(waiting));pill.replaceChildren(node('i'),document.createTextNode(waiting?'等你确认':'已保存'));
  const list=$('#messages');
  const openIds=new Set([...list.querySelectorAll('details[open]')].map(e=>e.dataset.run));
  list.replaceChildren();
  state.runs.forEach(run=>{
    const wrap=node('article','run');wrap.append(node('div','user-message',run.user_text),node('p','assistant-message',run.response || '正在核对状态…'));
    if(run.status==='awaiting_confirmation'){
      const card=node('div','proposal');const top=node('div','proposal-top');top.append(node('span','proposal-icon',icons[run.action]||'✦'));const description=node('div');description.append(node('h3','',run.action_label),node('small','','仅改变 demo 花园 · 确认后保存'));top.append(description);card.append(top);
      const actions=node('div','proposal-actions');
      [['confirm','好，就这样做','primary'],['reject','先不改','secondary']].forEach(([decision,text,cls])=>{const b=node('button',cls,text);b.dataset.decision=decision;b.addEventListener('click',()=>decide(run,decision));actions.append(b);});
      card.append(actions);wrap.append(card);
    }
    const trace=node('details','trace');trace.dataset.run=run.id;trace.open=openIds.has(run.id);const summary=node('summary');summary.append(document.createTextNode('看看果果做了什么'),node('span','run-status',statusNames[run.status]||'等待核对'));trace.append(summary);const steps=node('ul');run.steps.forEach(s=>steps.append(node('li','',s.title)));steps.append(node('li','',`模拟判断 ${run.model_calls}/3 轮 · 业务工具 ${run.tool_calls}/3 次 · 无付费调用`));trace.append(steps);wrap.append(trace);list.append(wrap);
  });
  controls();
}
async function perform(fn) {
  busy=true;showError();controls();
  try {state=await fn();render();} catch(error){showError(error.message);} finally{busy=false;controls();}
}
function bottom(){const c=$('#conversation');c.scrollTo({top:c.scrollHeight,behavior:'auto'});}
async function send(text) {
  if(busy||pending()||!text.trim())return;
  if(!pendingRequest||pendingRequest.text!==text.trim())pendingRequest={text:text.trim(),request_key:crypto.randomUUID()};
  await perform(async()=>{const result=await api('chat',pendingRequest);pendingRequest=null;$('#message').value='';$('#message').style.height='';return result;});bottom();
}
async function decide(run,decision){await perform(()=>api('decide',{run_id:run.id,proposal_id:run.proposal_id,decision}));bottom();}
$('#chat-form').addEventListener('submit',e=>{e.preventDefault();send($('#message').value);});
$('#message').addEventListener('input',()=>{$('#message').style.height='auto';$('#message').style.height=Math.min($('#message').scrollHeight,110)+'px';controls();});
$('#message').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send($('#message').value);}});
$('.suggestions').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{$('#message').value=b.dataset.prompt;send(b.dataset.prompt);}));
$('#undo').addEventListener('click',()=>perform(()=>api('garden',{action:'undo'})));
$('#reset').addEventListener('click',()=>$('#reset-dialog').showModal());
$('#reset-dialog').addEventListener('close',()=>{if($('#reset-dialog').returnValue==='confirm')perform(()=>api('garden',{action:'reset'}));});
const identity = demoAccount.read();
if (identity) {
  ['#demo-workspace','#demo-introduction','#demo-underbar','#demo-help','#reset'].forEach(selector=>$(selector).hidden=false);
  $('#account-button').textContent='我的小世界 ✧';
  controls(); perform(()=>api('state')).then(() => {
    bottom();
    if(location.hash==='#chat-experience')$('#chat-experience').scrollIntoView({block:'start'});
  });
} else { controls(); }
