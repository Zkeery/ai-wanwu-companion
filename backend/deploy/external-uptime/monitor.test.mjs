import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { initialState, encryptState, decryptState, evaluate, applySample, notificationPayload,
  sendNotification, probe, boundedText, githubStore, validateOrigin, runMonitor, MAX_GAP_MS } from './monitor.mjs';

const good = { healthy: true, codes: [] }, bad = { healthy: false, codes: ['SYNTHETIC_UNREACHABLE'] };
const key = 'ab'.repeat(32), context = 'Zkeery/wanwu-partner-uptime-monitor:state.enc';
const config = { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-0000-0000-000000000000', secret: 'fixture-secret-not-real' };
let externalAttempts = 0;
globalThis.fetch = async () => { externalAttempts++; throw new Error('TEST_NETWORK_FORBIDDEN'); };
function fixture() {
  const saved = [], sent = [];
  return { saved, sent, deps: { context, save: async state => saved.push(structuredClone(state)), send: async event => sent.push(event) } };
}

test('encryption authenticates key, context and ciphertext without exposing state', () => {
  const state = initialState(1), encrypted = encryptState(state, key, context);
  assert.deepEqual(decryptState(encrypted,key,context),state);
  assert.ok(!encrypted.includes('failures'));
  assert.throws(() => decryptState(encrypted,'cd'.repeat(32),context));
  assert.throws(() => decryptState(encrypted,key,context.replace('state','drill')));
  const damaged = JSON.parse(encrypted); damaged.body = 'AA' + damaged.body.slice(2);
  assert.throws(() => decryptState(JSON.stringify(damaged),key,context));
});
test('healthy runs stay quiet and persist observations', async () => {
  const f=fixture(); const state=await applySample(initialState(1),good,2,f.deps);
  assert.equal(f.sent.length,0); assert.equal(f.saved.length,1); assert.equal(state.lastRun,2);
});
test('two failures alert once, sustained failure stays quiet, two successes recover once', async () => {
  const f=fixture(); let state=initialState(1);
  for (const [i,sample] of [bad,bad,bad,good,good,good].entries()) state=await applySample(state,sample,i+2,f.deps);
  assert.deepEqual(f.sent.map(x=>x.code),['PUBLIC_SERVICE_UNREACHABLE','PUBLIC_SERVICE_RECOVERED']);
  assert.equal(state.down,false); assert.equal(state.pending,null);
});
test('flapping single failures do not alert', async () => {
  const f=fixture(); let state=initialState(1);
  for (const [i,sample] of [bad,good,bad,good].entries()) state=await applySample(state,sample,i+2,f.deps);
  assert.equal(f.sent.length,0);
});
test('durable intent precedes HTTP and failed or unknown delivery blocks retries', async () => {
  const f=fixture();let state=evaluate(initialState(1),bad,2).state; let attempts=0;
  f.deps.send=async()=>{attempts++;assert.ok(f.saved.at(-1).pending);throw new Error('fixture failure');};
  await assert.rejects(()=>applySample(state,bad,3,f.deps));
  state=f.saved.at(-1); assert.equal(attempts,1);
  await assert.rejects(()=>applySample(state,bad,4,f.deps),/DELIVERY_REVIEW_REQUIRED/);
  assert.equal(attempts,1);
});
test('state write failure before intent prevents delivery', async () => {
  const f=fixture();f.deps.save=async()=>{throw new Error('fixture store failure');};
  await assert.rejects(()=>applySample(evaluate(initialState(1),bad,2).state,bad,3,f.deps));assert.equal(f.sent.length,0);
});
test('write failure after successful HTTP leaves pending intent and no auto-resend', async () => {
  const f=fixture();f.deps.save=async s=>{if(f.saved.length)throw new Error('fixture final save failure');f.saved.push(structuredClone(s));};
  await assert.rejects(()=>applySample(evaluate(initialState(1),bad,2).state,bad,3,f.deps));
  assert.equal(f.sent.length,1);assert.ok(f.saved[0].pending);
  await assert.rejects(()=>applySample(f.saved[0],good,4,f.deps));assert.equal(f.sent.length,1);
});
test('notification rate limit persists review state without sending', async () => {
  const f=fixture();const previous=evaluate(initialState(1),bad,2).state;previous.attempts=Array(24).fill(2);
  await assert.rejects(()=>applySample(previous,bad,3,f.deps));assert.equal(f.sent.length,0);assert.ok(f.saved.at(-1).pending);
});
test('long scheduler gap is recorded and separately notified without joining stale streak', async () => {
  const f=fixture();const previous=evaluate(initialState(1),bad,2).state;
  const state=await applySample(previous,bad,MAX_GAP_MS+3,f.deps);
  assert.equal(state.failures,1);assert.equal(state.down,false);assert.equal(f.sent[0].code,'EXTERNAL_CHECK_DELAYED');
});
test('duplicate and backwards clock fail closed', () => {
  assert.throws(()=>evaluate(initialState(10),good,10));assert.throws(()=>evaluate(initialState(10),good,9));
});
test('Feishu signature and synthetic label match contract and disclose only codes', () => {
  const p=notificationPayload(config.webhook,config.secret,{id:'fixture-event',code:'PUBLIC_SERVICE_UNREACHABLE',drill:true},1234000);
  assert.equal(p.sign,createHmac('sha256','1234\n'+config.secret).update('').digest('base64'));
  assert.match(p.content.text,/合成演练/); assert.ok(!p.content.text.includes(config.secret));assert.ok(!p.content.text.includes('https://'));
  assert.throws(()=>notificationPayload('https://unapproved.example/',config.secret,{code:'PUBLIC_SERVICE_UNREACHABLE'},0));
});
test('Feishu business failure or HTTP redirect is not success and never retried', async () => {
  let calls=0;const fetcher=async()=>{calls++;return new Response('{"code":19021}',{status:200});};
  await assert.rejects(()=>sendNotification(config,{id:'fixture',code:'PUBLIC_SERVICE_UNREACHABLE',drill:true},1234,fetcher));assert.equal(calls,1);
});
test('public probes enforce TLS, expected status, content and no redirects, without login', async () => {
  const calls=[];const fetcher=async(url,opts)=>{calls.push({url,opts});return url.endsWith('/auth/me')?
    new Response('{"error":{"code":"UNAUTHORIZED"}}',{status:401,headers:{'content-type':'application/json'}}):
    new Response('<html><title>万物伙伴</title></html>',{status:200,headers:{'content-type':'text/html'}});};
  assert.equal((await probe('https://example.com',fetcher)).healthy,true);
  assert.equal(calls.length,2);assert.ok(calls.every(x=>x.opts.redirect==='manual'&&!x.opts.headers.Authorization));
  const redirect=await probe('https://example.com',async()=>new Response('',{status:302}));assert.equal(redirect.healthy,false);
  const refused=await probe('https://example.com',async()=>{throw new Error('fixture connection refused');});assert.equal(refused.healthy,false);
});
test('HTML 200 on API, bad JSON and oversize content fail', async () => {
  for(const response of [()=>new Response('<html/>',{status:200,headers:{'content-type':'text/html'}}),()=>new Response('not JSON',{status:401,headers:{'content-type':'application/json'}})]){
    assert.equal((await probe('https://example.com',async()=>response())).healthy,false);
  }
  await assert.rejects(()=>boundedText(new Response('a'.repeat(40000))));
});
test('origin excludes plaintext, credentials and arbitrary query or paths',()=>{
  for(const value of ['http://example.com','https://a:b@example.com','https://example.com/path','https://example.com/?x=1'])assert.throws(()=>validateOrigin(value));
});
test('dedicated repository scope is enforced and optimistic SHA is carried to state update', async()=>{
  assert.throws(()=>githubStore({repository:'Zkeery/ai-wanwu-companion',token:'fixture',key,file:'state.enc'}));
  let writes=0;const store=githubStore({repository:'Zkeery/wanwu-partner-uptime-monitor',token:'fixture',key,file:'state.enc',fetcher:async(url,opts)=>{
    if(opts.method==='GET')return new Response(JSON.stringify({sha:'initial-sha',encoding:'base64',content:Buffer.from(encryptState(initialState(1),key,context)).toString('base64')}),{status:200});
    const body=JSON.parse(opts.body);assert.equal(body.sha,writes?'next-sha':'initial-sha');assert.equal(body.branch,'monitor-state');writes++;
    return new Response('{"content":{"sha":"next-sha"}}',{status:200});
  }});
  await store.load();await store.save(initialState(2));await store.save(initialState(3));assert.equal(writes,2);
});
test('GitHub conflict prevents blind overwrite and state API does not retry',async()=>{
  let calls=0;const store=githubStore({repository:'Zkeery/wanwu-partner-uptime-monitor',token:'fixture',key,file:'state.enc',fetcher:async()=>{calls++;return new Response('{}',{status:409});}});
  await assert.rejects(()=>store.save(initialState(1)));assert.equal(calls,1);
});
test('synthetic outage and recovery stay in isolated state and produce exactly two labeled messages',async()=>{
  const f=fixture();let state=initialState(1);
  for(const [i,sample] of [bad,bad,good,good].entries())state=await applySample(state,sample,i+2,f.deps,true);
  assert.equal(f.sent.length,2);assert.ok(f.sent.every(x=>x.drill));assert.equal(state.down,false);
});
test('non-Actions execution is rejected before any network activity', async()=>{
  await assert.rejects(()=>runMonitor('check',{}),/EXECUTION_CONTEXT_INVALID/);
});
function githubFixture() {
  const files=new Map(), deliveries=[];let seq=0,clock=1000;
  const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'Zkeery/wanwu-partner-uptime-monitor',
    GITHUB_TOKEN:'fixture',STATE_ENCRYPTION_KEY:key,WANWU_TARGET_ORIGIN:'https://example.com',FEISHU_WEBHOOK:config.webhook,FEISHU_SIGNING_SECRET:config.secret};
  const runtime={clock:()=>++clock,fetcher:async(url,options)=>{
    if(url.startsWith('https://api.github.com/')){
      const name=new URL(url).pathname.split('/').at(-1);
      if(options.method==='GET')return files.has(name)?new Response(JSON.stringify(files.get(name)),{status:200}):new Response('{}',{status:404});
      const body=JSON.parse(options.body);if(files.has(name))assert.equal(body.sha,files.get(name).sha);
      const entry={sha:String(++seq),encoding:'base64',content:body.content};files.set(name,entry);
      return new Response(JSON.stringify({content:{sha:entry.sha}}),{status:200});
    }
    if(url===config.webhook){deliveries.push(JSON.parse(options.body));return new Response('{"code":0}',{status:200});}
    return url.endsWith('/auth/me')?new Response('{"error":"UNAUTHORIZED"}',{status:401,headers:{'content-type':'application/json'}}):
      new Response('<html><title>万物伙伴</title></html>',{status:200,headers:{'content-type':'text/html'}});
  }};
  return {files,deliveries,env,runtime};
}
test('full bootstrap then check preserve production state and reject reset',async()=>{
  const f=githubFixture();await runMonitor('bootstrap',f.env,f.runtime);assert.ok(f.files.has('state.enc'));assert.equal(f.deliveries.length,0);
  await runMonitor('check',f.env,f.runtime);await assert.rejects(()=>runMonitor('bootstrap',f.env,f.runtime),/ALREADY_INITIALIZED/);
  assert.equal(f.deliveries.length,0);
});
test('missing production state and corrupted encrypted state never auto-reset',async()=>{
  const f=githubFixture();await assert.rejects(()=>runMonitor('check',f.env,f.runtime),/STATE_MISSING/);assert.equal(f.files.size,0);
  f.files.set('state.enc',{sha:'broken',encoding:'base64',content:Buffer.from('not encrypted state').toString('base64')});
  await assert.rejects(()=>runMonitor('check',f.env,f.runtime),/STATE_UNREADABLE/);assert.equal(f.files.get('state.enc').sha,'broken');assert.equal(f.deliveries.length,0);
});
test('full isolated drill does not change production snapshot and cannot resend',async()=>{
  const f=githubFixture();await runMonitor('bootstrap',f.env,f.runtime);const production=f.files.get('state.enc').content;
  await runMonitor('drill',f.env,f.runtime);assert.equal(f.deliveries.length,2);assert.ok(f.deliveries.every(x=>x.content.text.includes('合成演练')));
  assert.equal(f.files.get('state.enc').content,production);
  const drill=decryptState(Buffer.from(f.files.get('drill.enc').content,'base64').toString(),key,context.replace('state.enc','drill.enc'));
  assert.equal(drill.drillComplete,true);await assert.rejects(()=>runMonitor('drill',f.env,f.runtime),/DRILL_ALREADY_ATTEMPTED/);assert.equal(f.deliveries.length,2);
});
test('all tests made zero real network attempts',()=>assert.equal(externalAttempts,0));
