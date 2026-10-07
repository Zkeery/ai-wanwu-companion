'use strict';
const $=s=>document.querySelector(s), clone=x=>JSON.parse(JSON.stringify(x));
const catalog=[['棕榈','plant',22],['仙人掌','plant',12],['岩石','decor',15],['石边水池','decor',32],['遮阳棚','rest',29],['织纹坐垫','rest',11],['小茶桌','rest',13],['小帐篷','rest',24],['暖光灯串','decor',25],['木路牌','decor',11],['编织长椅','rest',18],['沙漠花盆','plant',10]].map(([name,category,size],kind)=>({name,category,size,kind}));
const KEY='oasis-design-preview-r111-v1', LIMIT=30;
let serial=0;const item=(kind,x,y)=>({id:++serial,kind,x,y,flip:false});
const layouts={water:()=>[item(0,23,56),item(3,35,73),item(4,72,57),item(6,70,72),item(5,80,79),item(1,12,79),item(11,85,57),item(2,46,60),item(10,26,88),item(9,83,90)],camp:()=>[item(0,20,58),item(7,37,60),item(8,70,47),item(6,65,71),item(5,72,80),item(5,54,76),item(11,45,89),item(1,86,65),item(2,13,81),item(9,82,91)],empty:()=>[]};
let state={items:layouts.water(),stored:[]},history=[],selected=null,pending=null,category='all',preview=null,drag=null;
function validItem(i){return i&&Number.isInteger(i.id)&&i.id>0&&Number.isInteger(i.kind)&&i.kind>=0&&i.kind<12&&Number.isFinite(i.x)&&i.x>=9&&i.x<=91&&Number.isFinite(i.y)&&i.y>=44&&i.y<=93&&typeof i.flip==='boolean';}
try{const s=JSON.parse(localStorage.getItem(KEY));if(s&&Array.isArray(s.items)&&Array.isArray(s.stored)&&s.items.length+s.stored.length<=LIMIT&&[...s.items,...s.stored].every(validItem)&&new Set([...s.items,...s.stored].map(i=>i.id)).size===s.items.length+s.stored.length)state=s;}catch{/* A denied or corrupt local draft does not block the preview. */}
serial=Math.max(serial,0,...state.items.map(i=>i.id),...state.stored.map(i=>i.id));
function save(message='本页布置已保存'){try{localStorage.setItem(KEY,JSON.stringify(state));$('#save-state').textContent=message;}catch{$('#save-state').textContent='本次仅保留到页面关闭；浏览器未允许保存。';}}
function remember(previous=state){history.push(clone(previous));if(history.length>20)history.shift();}
function spriteStyle(kind){return `--x:${kind%4/3*100}%;--y:${Math.floor(kind/4)/2*100}%`;}
const crops=[[28,0,339,379],[393,15,289,370],[721,99,349,267],[1080,90,366,285],[3,383,387,322],[393,477,339,224],[754,445,311,254],[1084,383,351,321],[8,733,379,295],[430,703,267,334],[721,778,353,260],[1106,716,327,331]];
let spriteSerial=0;
function sprite(kind){const [x,y,w,h]=crops[kind],id=`crop-${++spriteSerial}`;return `<svg class="sprite" viewBox="${x} ${y} ${w} ${h}" preserveAspectRatio="xMidYMax meet" aria-hidden="true"><defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath></defs><image href="assets/props.png" width="1448" height="1086" clip-path="url(#${id})"/></svg>`;}
function position(el,i){el.style.left=i.x+'%';el.style.top=i.y+'%';el.style.width=catalog[i.kind].size+'%';el.style.zIndex=Math.round(i.y);}
function chosen(){return state.items.find(i=>i.id===selected);}
function draw(preserveObjects=false){
 const items=preview?preview.items:state.items;
 if(!preserveObjects){$('#objects').innerHTML='';for(const i of items){const b=document.createElement('button');b.type='button';b.className='world-object'+(i.id===selected&&!preview?' selected':'')+(i.flip?' flipped':'');b.dataset.id=i.id;b.setAttribute('aria-label',catalog[i.kind].name+'，点击选中或拖动');b.setAttribute('aria-pressed',String(i.id===selected&&!preview));b.innerHTML=sprite(i.kind);position(b,i);$('#objects').append(b);}}else{document.querySelectorAll('.world-object').forEach(b=>{b.classList.toggle('selected',Number(b.dataset.id)===selected);b.setAttribute('aria-pressed',String(Number(b.dataset.id)===selected));});}
 $('#world').classList.toggle('placing',pending!==null);$('#world').classList.toggle('previewing',!!preview);
 $('#catalog').innerHTML=catalog.filter(c=>category==='all'||c.category===category).map(c=>`<button class="catalog-item" data-kind="${c.kind}" aria-label="添加${c.name}" aria-pressed="${pending?.kind===c.kind}">${sprite(c.kind)}<span>${c.name}</span></button>`).join('');
 $('#storage').innerHTML=state.stored.length?state.stored.map(i=>`<button data-restore="${i.id}" aria-label="摆出${catalog[i.kind].name}">${sprite(i.kind)}摆出</button>`).join(''):'<p>收起来的物件，会在这里等你。</p>';
 $('#storage-count').textContent=state.stored.length+' 件';$('#count').textContent=(preview?'方案里':'沙地上')+' '+items.length+' 件物件';
 $('#undo').disabled=!history.length||!!preview;$('#selection').hidden=!chosen()||!!preview;
 if(chosen())$('#selected-name').textContent=catalog[chosen().kind].name;
 $('#cancel-place').hidden=pending===null;$('#preview-bar').hidden=!preview;
 $('#hint').textContent=preview?'先看看这套布置':pending?'点一处沙地，放下'+catalog[pending.kind].name:chosen()?'拖动它，或点沙地换个位置':'选一件喜欢的物件';
 $('#detail').textContent=preview?'确认后应用；不喜欢就取消，原布置会回来。':pending?'半透明形象是放置预览，也可以取消。':chosen()?'位置会记住；选下方工具转向或收纳。':'再点沙地放下；已有物件可以直接拖动。';
 $('#step-number').textContent=pending||chosen()?'2':'1';
 $('#ghost').hidden=pending===null||!!preview;if(pending){const g=$('#ghost');g.style.width=catalog[pending.kind].size+'%';g.style.left='50%';g.style.top='72%';g.querySelector('.sprite').outerHTML=sprite(pending.kind);}
}
function begin(kind,restoreId=null){if(preview)return;if(!restoreId&&state.items.length+state.stored.length>=LIMIT){$('#save-state').textContent='先收拾一下吧，预览最多保留30件物件。';return;}pending={kind,restoreId};selected=null;draw();if(matchMedia('(max-width: 600px)').matches)$('#world').scrollIntoView({block:'center',behavior:'auto'});}
$('#catalog').addEventListener('click',e=>{const b=e.target.closest('[data-kind]');if(b)begin(Number(b.dataset.kind));});
$('.categories').addEventListener('click',e=>{const b=e.target.closest('[data-category]');if(!b)return;category=b.dataset.category;document.querySelectorAll('[data-category]').forEach(c=>c.setAttribute('aria-pressed',String(c===b)));draw();});
$('#storage').addEventListener('click',e=>{const b=e.target.closest('[data-restore]');const i=b&&state.stored.find(i=>i.id===Number(b.dataset.restore));if(i)begin(i.kind,i.id);});
const board=$('#world');
function point(e){const r=board.getBoundingClientRect();return{x:Math.max(9,Math.min(91,(e.clientX-r.left)/r.width*100)),y:Math.max(44,Math.min(93,(e.clientY-r.top)/r.height*100))};}
function applyPoint(p){if(preview)return;if(pending){remember();let i;if(pending.restoreId){i=state.stored.find(i=>i.id===pending.restoreId);state.stored=state.stored.filter(n=>n!==i);}else i=item(pending.kind,p.x,p.y);Object.assign(i,p);state.items.push(i);selected=i.id;pending=null;save('已放好，可继续拖动调整');draw();}else if(chosen()){remember();Object.assign(chosen(),p);save('位置已记住');draw();}}
board.addEventListener('pointerdown',e=>{if(preview||e.button!==0)return;const node=e.target.closest('[data-id]');if(node&&!pending){selected=Number(node.dataset.id);drag={id:selected,startX:e.clientX,startY:e.clientY,before:clone(state),point:point(e),original:clone(chosen()),moved:false};e.preventDefault();draw(true);board.setPointerCapture(e.pointerId);}});
board.addEventListener('pointermove',e=>{const p=point(e);if(pending){$('#ghost').style.left=p.x+'%';$('#ghost').style.top=p.y+'%';}if(drag){const i=chosen();if(!i)return;if(Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY)>5)drag.moved=true;if(drag.moved){i.x=Math.max(9,Math.min(91,drag.original.x+p.x-drag.point.x));i.y=Math.max(44,Math.min(93,drag.original.y+p.y-drag.point.y));position(board.querySelector(`[data-id="${i.id}"]`),i);}}});
board.addEventListener('pointerup',e=>{if(drag){if(drag.moved){remember(drag.before);save('位置已记住');}drag=null;if(board.hasPointerCapture(e.pointerId))board.releasePointerCapture(e.pointerId);draw();return;}if(!e.target.closest('[data-id]')||pending)applyPoint(point(e));});
function cancelDrag(){if(drag){state=drag.before;drag=null;draw();}}board.addEventListener('pointercancel',cancelDrag);board.addEventListener('lostpointercapture',cancelDrag);
board.addEventListener('keydown',e=>{const keys={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};if((e.key==='Enter'||e.key===' ')&&pending){e.preventDefault();applyPoint({x:50,y:72});return;}if(chosen()&&keys[e.key]&&!preview){e.preventDefault();const [x,y]=keys[e.key];applyPoint({x:Math.max(9,Math.min(91,chosen().x+x)),y:Math.max(44,Math.min(93,chosen().y+y))});board.focus();}});
$('#turn').onclick=()=>{if(!chosen())return;remember();chosen().flip=!chosen().flip;save('朝向已切换 · 原型为镜像示意');draw();};
$('#store').onclick=()=>{if(!chosen())return;remember();state.stored.push(chosen());state.items=state.items.filter(i=>i.id!==selected);selected=null;save('已放进收纳篮');draw();};
$('#deselect').onclick=()=>{selected=null;draw();};$('#cancel-place').onclick=()=>{pending=null;draw();};
$('#undo').onclick=()=>{if(preview||!history.length)return;state=history.pop();selected=null;pending=null;save('已撤销上一步');draw();};
function previewTemplate(name){pending=null;selected=null;preview={name,items:layouts[name]()};$('#preview-name').textContent='预览 · '+({water:'清凉水边',camp:'露营小角落',empty:'空白沙地'}[name]);draw();board.scrollIntoView({block:'center',behavior:'auto'});}
document.querySelectorAll('[data-template]').forEach(b=>b.onclick=()=>previewTemplate(b.dataset.template));
$('#cancel-template').onclick=()=>{preview=null;draw();};$('#apply-template').onclick=()=>{if(!preview)return;remember();state={items:preview.items,stored:state.stored};while(state.items.length+state.stored.length>LIMIT)state.items.pop();preview=null;save('这套布置已应用，也可以撤销');draw();};
document.addEventListener('keydown',e=>{if(e.key==='Escape'){cancelDrag();pending=null;selected=null;preview=null;draw();}});
document.querySelector('.mini.water').innerHTML=sprite(3);document.querySelector('.mini.camp').innerHTML=sprite(7);
draw();
board.addEventListener('click',e=>{if(e.detail===0&&!preview){const node=e.target.closest('[data-id]');if(node){selected=Number(node.dataset.id);pending=null;draw();board.focus();}}});
