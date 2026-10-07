const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'../../../../../..');
const html=fs.readFileSync(root+'/backend/app/static/index.html','utf8');
function el(tag='div'){return {tag,style:{},value:'',textContent:'',disabled:false,children:[],listeners:{},append(...c){this.children.push(...c)},replaceChildren(){this.children=[]},querySelectorAll(){return this.children.filter(c=>c.tag==='button')},addEventListener(e,fn){this.listeners[e]=fn}}}
const elements=new Map();const document={querySelector(s){if(!elements.has(s))elements.set(s,el());return elements.get(s)},createElement:el};
const pending=[];let posts=0;
const context=vm.createContext({document,TextDecoder,FormData,AbortController,fetch:async(u,o)=>{if(o?.method==='POST'){posts++;return await new Promise(resolve=>pending.push(resolve))}return new Response('[]',{headers:{'content-type':'application/json'}})}});
vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
vm.runInContext('currentCharacter={id:1,name:"验收角色"}',context);
document.querySelector('#chatInput').value='第一条';
const first=vm.runInContext('sendMessage()',context);
const disabledDuringFirst=document.querySelector('#chatSend').disabled;
document.querySelector('#chatInput').value='第二条';
document.querySelector('#chatInput').listeners.keydown({key:'Enter'});
const result={check:'enter_does_not_bypass_send_lock',passed:posts===1,detail:{sendButtonDisabled:disabledDuringFirst,actualConcurrentPosts:posts}};
for(const resolve of pending)resolve(new Response('event: chunk\ndata: {"delta":"回复"}\n\nevent: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}}));
first.then(()=>{fs.writeFileSync(root+'/docs/PRD/版本/V1.0/验收证据/阶段2-2/修复复验页面探针.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result))});
