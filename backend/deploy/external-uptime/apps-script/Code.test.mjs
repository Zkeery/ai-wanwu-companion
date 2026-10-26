import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash, createHmac } from 'node:crypto';

const source = readFileSync(new URL('./Code.gs', import.meta.url), 'utf8');
function setup() {
  const h = { time: 1792330000000, healthy: true, botError: null, network: [], sends: [], triggers: [], locked: false, writeFault: null };
  const values = { WANWU_APPROVED: 'true', WANWU_ENABLED: 'true', WANWU_TARGET_ORIGIN: 'https://101.96.210.187',
    FEISHU_WEBHOOK: 'https://open.feishu.cn/open-apis/bot/v2/hook/' + 'a'.repeat(32), FEISHU_SIGNING_SECRET: 'synthetic-signing-secret' };
  const p = { getProperty: k => values[k] ?? null, getProperties: () => ({...values}),
    setProperty: (k,v) => { values[k] = v; },
    setProperties: changes => { if (h.writeFault?.(changes)) throw Error('synthetic-write-failure'); Object.assign(values, changes); } };
  const response = (status,text) => ({ getResponseCode: () => status, getContentText: () => text });
  const context = vm.createContext({
    Date: { now: () => h.time }, PropertiesService: { getScriptProperties: () => p },
    LockService: { getScriptLock: () => ({ tryLock: limit => { h.lockWaitLimit=limit;if(h.locked)return false;const wait=h.lockedForMs||0;h.time+=Math.min(wait,limit);if(wait>limit){h.lockedForMs=wait-limit;return false;}h.lockedForMs=0;return true; }, releaseLock: () => {} }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, base64Encode: b => Buffer.from(b.map(x=>(x+256)%256)).toString('base64'),
      computeDigest: (kind,s) => [...createHash(kind).update(s).digest()],
      computeHmacSha256Signature: (s,key) => [...createHmac('sha256',key).update(s).digest()] },
    UrlFetchApp: {
      fetchAll: requests => {
        h.network.push(...requests.map(x=>x.url));
        assert.deepEqual(JSON.parse(JSON.stringify(requests.map(x=>x.url))), ['https://101.96.210.187/partner','https://101.96.210.187/partner/api/v1/auth/me']);
        assert.ok(requests.every(x=>x.followRedirects===false && x.validateHttpsCertificates===true));
        return h.healthy ? [response(200,'<html>万物伙伴</html>'),response(401,'{"error":{"code":"authentication_required"}}')] : [response(503,'unavailable'),response(503,'{}')];
      },
      fetch: (url,options) => {
        assert.equal(url,values.FEISHU_WEBHOOK);
        const message = JSON.parse(options.payload);h.sends.push(message);
        const pending = JSON.parse(values.WANWU_DRILL_V1 || values.WANWU_STATE_V1).pending;
        // The drill and production use separate states; whichever has the intent must be durable.
        assert.ok(pending || JSON.parse(values.WANWU_STATE_V1).pending);
        if (h.botError==='timeout') throw Error('sensitive-raw-provider-error');
        return response(200, h.botError ? '{"code":19021}' : '{"code":0}');
      }
    },
    ScriptApp: { getProjectTriggers: () => h.triggers, newTrigger: name => ({
      timeBased() { return this; }, everyMinutes(n) { assert.equal(n,5);return this; },
      create() { const t={getHandlerFunction:()=>name,getUniqueId:()=> 'synthetic-trigger'};h.triggers.push(t);return t; }
    }) },
    fetch: () => assert.fail('real network forbidden')
  });
  vm.runInContext(source,context);
  h.c=context;h.p=p;h.values=values;
  h.boot=()=>{context.initializeWanwuMonitor();context.installWanwuMonitorTrigger();};
  h.tick=(milliseconds=300000)=>{h.time+=milliseconds;return context.runWanwuMonitor({triggerUid:'synthetic-trigger'});};
  return h;
}

test('disabled configuration stops without network or state',()=>{const h=setup();h.values.WANWU_ENABLED='false';assert.throws(()=>h.c.initializeWanwuMonitor(),/CONFIG_DISABLED/);assert.equal(h.network.length,0);});
test('initialization is once and trigger installation is idempotent',()=>{const h=setup();h.boot();assert.throws(()=>h.c.initializeWanwuMonitor(),/ALREADY_INITIALIZED/);assert.equal(h.c.installWanwuMonitorTrigger(),'ALREADY_INSTALLED');assert.equal(h.triggers.length,1);});
test('healthy automatic samples use only anonymous paths and stay quiet',()=>{const h=setup();h.boot();h.tick();h.tick();assert.equal(h.sends.length,0);assert.equal(h.network.length,6);});
test('manual execution cannot masquerade as an automatic trigger',()=>{const h=setup();h.boot();const n=h.network.length;assert.throws(()=>h.c.runWanwuMonitor(),/AUTOMATIC_TRIGGER/);assert.equal(h.network.length,n);});
test('missing state does not initialize or probe',()=>{const h=setup();h.boot();delete h.values.WANWU_STATE_V1;const n=h.network.length;assert.throws(()=>h.tick(),/STATE_MISSING/);assert.equal(h.network.length,n);});
test('corrupt state does not probe',()=>{const h=setup();h.boot();h.values.WANWU_STATE_V1='{';const n=h.network.length;assert.throws(()=>h.tick(),/STATE_CORRUPT/);assert.equal(h.network.length,n);});
test('two failures notify once, two successes recover once',()=>{const h=setup();h.boot();h.healthy=false;h.tick();assert.equal(h.sends.length,0);h.tick();h.tick();assert.equal(h.sends.length,1);h.healthy=true;h.tick();h.tick();h.tick();assert.equal(h.sends.length,2);assert.match(h.sends[0].content.text,/PUBLIC_SERVICE_UNREACHABLE/);assert.match(h.sends[1].content.text,/PUBLIC_SERVICE_RECOVERED/);assert.equal(JSON.parse(h.values.WANWU_STATE_V1).pending,null);});
test('long gap is recorded and does not count stale failure toward outage',()=>{const h=setup();h.boot();h.healthy=false;h.tick();h.tick(1200001);assert.equal(h.sends.length,1);assert.match(h.sends[0].content.text,/EXTERNAL_CHECK_DELAYED/);assert.equal(JSON.parse(h.values.WANWU_STATE_V1).failures,1);});
for (const error of ['timeout','business']) test('notification '+error+' preserves intent and blocks retry',()=>{const h=setup();h.boot();h.healthy=false;h.tick();h.botError=error;assert.throws(()=>h.tick(),/DELIVERY_UNKNOWN/);const n=h.network.length;assert.throws(()=>h.tick(),/PENDING_DELIVERY/);assert.equal(h.network.length,n);assert.equal(h.sends.length,1);assert.ok(JSON.parse(h.values.WANWU_STATE_V1).pending);});
test('intent write failure cannot send',()=>{const h=setup();h.boot();h.healthy=false;h.tick();h.writeFault=c=>Object.keys(c).some(k=>k.endsWith('_intent'));assert.throws(()=>h.tick(),/synthetic-write/);assert.equal(h.sends.length,0);});
test('final state write failure keeps pending and prevents duplicate send',()=>{const h=setup();h.boot();h.healthy=false;h.tick();h.writeFault=c=>Object.keys(c).some(k=>k.endsWith('_delivered'));assert.throws(()=>h.tick(),/synthetic-write/);assert.equal(h.sends.length,1);assert.throws(()=>h.tick(),/PENDING_DELIVERY/);assert.equal(h.sends.length,1);});
test('daily global send cap stops before bot send',()=>{const h=setup();h.boot();h.values.WANWU_SENDS_V1=JSON.stringify(Array(24).fill(h.time));h.healthy=false;h.tick();assert.throws(()=>h.tick(),/DAILY_SEND_LIMIT/);assert.equal(h.sends.length,0);});
test('missing send ledger is not silently reset',()=>{const h=setup();h.boot();delete h.values.WANWU_SENDS_V1;h.healthy=false;h.tick();assert.throws(()=>h.tick(),/SEND_LEDGER/);assert.equal(h.sends.length,0);});
test('storage near quota stops before requests and deletes nothing',()=>{const h=setup();h.boot();h.values.oldEvidence='x'.repeat(130000);const n=h.network.length;assert.throws(()=>h.tick(),/STORAGE_REVIEW/);assert.equal(h.network.length,n);assert.equal(h.values.oldEvidence.length,130000);});
test('lock contention stops before network',()=>{const h=setup();h.boot();h.locked=true;const n=h.network.length;assert.throws(()=>h.tick(),/CONCURRENT/);assert.equal(h.network.length,n);});
test('synthetic drill is isolated and cannot replay',()=>{const h=setup();h.boot();const production=h.values.WANWU_STATE_V1;h.c.runWanwuSyntheticDrill();assert.equal(h.values.WANWU_STATE_V1,production);assert.equal(h.sends.length,2);assert.ok(h.sends.every(x=>x.content.text.includes('合成演练')));assert.throws(()=>h.c.runWanwuSyntheticDrill(),/DRILL_ALREADY/);});
test('notification signature matches Feishu signing contract',()=>{const h=setup();h.boot();h.healthy=false;h.tick();h.tick();const m=h.sends[0];assert.equal(m.sign,createHmac('sha256',m.timestamp+'\n'+h.values.FEISHU_SIGNING_SECRET).update('').digest('base64'));});
test('duplicate project triggers are not deleted or replaced',()=>{const h=setup();h.boot();h.triggers.push(h.triggers[0]);assert.throws(()=>h.c.installWanwuMonitorTrigger(),/TRIGGER_REVIEW/);assert.equal(h.triggers.length,2);});
test('manifest requests only external requests and current-script triggers',()=>{const manifest=JSON.parse(readFileSync(new URL('./appsscript.json',import.meta.url),'utf8'));assert.deepEqual(manifest.oauthScopes,['https://www.googleapis.com/auth/script.external_request','https://www.googleapis.com/auth/script.scriptapp']);});

test('30 days of five-minute samples retain every sample within storage guard',()=>{const h=setup();h.boot();for(let i=0;i<30*288;i++)h.tick();assert.equal(h.sends.length,0);const records=Object.entries(h.values).filter(([k])=>k.startsWith('WANWU_SAMPLES_')).map(([,v])=>JSON.parse(v));assert.equal(records.reduce((sum,r)=>sum+r.data.split(';').filter(Boolean).length,0),30*288);assert.ok(JSON.stringify(h.values).length*3<360000);});

test('scheduled sample waits through a six-second drill lock without duplicate notification',()=>{const h=setup();h.boot();const before=JSON.parse(h.values.WANWU_STATE_V1);h.lockedForMs=6000;h.tick();const after=JSON.parse(h.values.WANWU_STATE_V1);assert.equal(after.lastRun-before.lastRun,306000);assert.equal(after.events.length,1);assert.equal(after.failures,0);assert.equal(h.sends.length,0);assert.equal(h.network.length,4);});
test('thirty-second lock contention remains bounded and preserves prior evidence',()=>{const h=setup();h.boot();const state=h.values.WANWU_STATE_V1,network=h.network.length,start=h.time;h.lockedForMs=30000;assert.throws(()=>h.tick(),/CONCURRENT_CHECK_BLOCKED/);assert.equal(h.values.WANWU_STATE_V1,state);assert.equal(h.network.length,network);assert.ok(h.time-start-300000<=20000);});
