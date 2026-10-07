// Run with node --test tests/test_ui.cjs. No browser or paid model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../app/static/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function element(tag = 'div') {
  return {
    tag, style: {}, textContent: '', disabled: false, value: '',
    scrollTop: 0, scrollHeight: 0, children: [],
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    querySelectorAll() { return this.children.filter(c => c.tag === 'button'); },
    listeners: {},
    addEventListener(name, handler) { this.listeners[name] = handler; },
  };
}

function setup(post) {
  const elements = new Map();
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    createElement: element,
  };
  const context = vm.createContext({
    document, TextDecoder, FormData, AbortController,
    fetch: async (url, options) => options?.method === 'POST'
      ? post()
      : new Response('[]', { headers: { 'content-type': 'application/json' } }),
  });
  vm.runInContext(script, context);
  return { context, elements };
}

test('HTTP 409 is visible and controls can be used again', async () => {
  const { context, elements } = setup(() => new Response(JSON.stringify({ error: { message: '该对象已生成过角色' } }), { status: 409 }));
  await vm.runInContext('generate(1)', context);
  assert.match(elements.get('#log').textContent, /该对象已生成过角色/);
  assert.equal(elements.get('#file').disabled, false);
});

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function audioSetup(resumeFails = false) {
  const state = { resumes: 0, starts: 0, stops: 0 };
  class AudioContext {
    constructor() { this.state = 'suspended'; this.sampleRate = 10; this.destination = {}; state.ctx = this; }
    async resume() {
      state.resumes++;
      if (resumeFails) throw new Error('blocked');
      this.state = 'running';
      this.onstatechange?.();
    }
    createBuffer() { return {getChannelData: () => new Float32Array(20)}; }
    createBufferSource() { return {connect() {}, start() {state.starts++;}, stop() {state.stops++;}}; }
    createBiquadFilter() { return {frequency: {}, connect() {}}; }
    createGain() { return {gain: {}, connect() {}}; }
  }
  const ui = setup(() => {});
  ui.context.window = {AudioContext};
  vm.runInContext('sceneLoaded = true;', ui.context);
  return {...ui, state};
}

test('a proposal cannot survive switching characters', async () => {
  const {context, elements} = audioSetup();
  vm.runInContext("currentCharacter={id:1}; showSceneProposal({id:'old-token',action:'light_rain'});", context);
  assert.equal(elements.get('#sceneProposal').style.display, 'flex');
  context.fetch = async url => new Response(JSON.stringify(url.endsWith('/scene')
    ? {elements:{rain:0,tree:0,cloud:0,sound:1},can_undo:false,proposal:null} : []));
  await vm.runInContext("openChat({id:2,name:'另一角色'})", context);
  assert.equal(elements.get('#sceneProposal').style.display, 'none');
  assert.equal(vm.runInContext('pendingSceneAction', context), null);
});

test('double confirming posts once with the character-bound proposal token', async () => {
  const {context} = audioSetup();
  const pending = deferred();
  const urls = [];
  context.fetch = async url => { urls.push(url); return pending.promise; };
  vm.runInContext("currentCharacter={id:1}; showSceneProposal({id:'token-1',action:'light_rain'});", context);
  const first = vm.runInContext('confirmSceneAction()', context);
  await vm.runInContext('confirmSceneAction()', context);
  assert.deepEqual(urls, ['/api/v1/characters/1/scene/proposals/token-1/confirm']);
  pending.resolve(new Response(JSON.stringify({elements:{rain:1,tree:0,cloud:1,sound:1},can_undo:true,proposal:null})));
  await first;
  assert.equal(vm.runInContext('pendingSceneAction', context), null);
});

test('refreshing scene restores a pending proposal and rejection persists', async () => {
  const {context, elements} = audioSetup();
  const urls = [];
  vm.runInContext('currentCharacter={id:1};', context);
  context.fetch = async (url, options) => {
    urls.push(url);
    return new Response(JSON.stringify({elements:{rain:0,tree:0,cloud:0,sound:1},can_undo:false,
      proposal: options?.method ? null : {id:'restored', action:'light_rain'}}));
  };
  await vm.runInContext('loadScene()', context);
  assert.equal(elements.get('#sceneProposal').style.display, 'flex');
  await vm.runInContext('rejectSceneAction()', context);
  assert.ok(urls.includes('/api/v1/characters/1/scene/proposals/restored/reject'));
  assert.equal(elements.get('#sceneProposal').style.display, 'none');
});

test('scene click resumes audio before fetching; quiet and leaving stop rain', async () => {
  const {context, elements, state} = audioSetup();
  vm.runInContext('currentCharacter = {id:1};', context);
  let sound = 1;
  context.fetch = async (url, options) => {
    if (!options?.method) return new Response('[]');
    assert.equal(state.ctx.state, 'running');
    assert.ok(state.resumes >= 1);
    return new Response(JSON.stringify({scene_name:'小花园', elements:{rain:1,tree:0,cloud:1,sound},can_undo:true}));
  };
  await vm.runInContext("doSceneAction('light_rain')", context);
  assert.equal(state.starts, 1);
  assert.equal(elements.get('#audioStatus').textContent, '雨声播放中');
  sound = 0;
  await vm.runInContext("doSceneAction('quiet')", context);
  assert.equal(state.stops, 1);
  assert.match(elements.get('#audioStatus').textContent, /场景已静音/);
  sound = 1;
  await vm.runInContext("doSceneAction('light_rain')", context);
  elements.get('#chatBack').onclick();
  assert.equal(state.stops, 2);
});

test('blocked audio resume is visible and can be retried', async () => {
  const {context, elements} = audioSetup(true);
  await vm.runInContext('enableAudio()', context);
  assert.match(elements.get('#audioStatus').textContent, /声音未能开启/);
  assert.notEqual(elements.get('#audioEnable').style.display, 'none');
});

test('late scene response cannot restart rain after leaving chat', async () => {
  const {context, elements, state} = audioSetup();
  const pending = deferred();
  context.fetch = async (url, options) => options?.method ? pending.promise : new Response('[]');
  vm.runInContext('currentCharacter = {id:1};', context);
  const acting = vm.runInContext("doSceneAction('light_rain')", context);
  elements.get('#chatBack').onclick();
  pending.resolve(new Response(JSON.stringify({elements:{rain:1,sound:1}})));
  await acting;
  assert.equal(state.starts, 0);
});

test('Enter cannot submit twice while a reply is pending', async () => {
  const pending = deferred();
  let posts = 0;
  const { context, elements } = setup(() => { posts++; return pending.promise; });
  vm.runInContext('currentCharacter = {id:1};', context);
  elements.get('#chatInput').value = '第一条';
  const first = vm.runInContext('sendMessage()', context);
  elements.get('#chatInput').value = '第二条';
  elements.get('#chatInput').listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(posts, 1);
  assert.equal(elements.get('#chatSend').disabled, true);
  pending.resolve(new Response('event: done\ndata: {"message":{"content":"完成"}}\n\n', {headers:{'content-type':'text/event-stream'}}));
  await first;
  assert.equal(elements.get('#chatSend').disabled, false);
  assert.equal(elements.get('#chatStatus').textContent, '');
  assert.equal(elements.get('#chatHistory').children[1].children[0].textContent, '完成');
});

test('clearing history invalidates an older history query', async () => {
  const pending = deferred();
  const { context, elements } = setup(() => {});
  context.fetch = async (url, options) => options?.method === 'DELETE'
    ? new Response(null, {status:204}) : pending.promise;
  vm.runInContext('currentCharacter = {id:1};', context);
  const loading = vm.runInContext('loadHistory()', context);
  await vm.runInContext('clearHistory()', context);
  pending.resolve(new Response(JSON.stringify([{role:'assistant', content:'旧历史'}])));
  await loading;
  assert.equal(elements.get('#chatHistory').children.length, 0);
  assert.match(elements.get('#chatStatus').textContent, /历史已清空/);
});

test('clearing an active reply aborts it and ignores its late result', async () => {
  const pending = deferred();
  const { context, elements } = setup(() => {});
  let signal;
  context.fetch = async (url, options) => {
    if (options?.method === 'POST') { signal = options.signal; return pending.promise; }
    return new Response(null, {status:204});
  };
  vm.runInContext('currentCharacter = {id:1};', context);
  elements.get('#chatInput').value = '测试';
  const sending = vm.runInContext('sendMessage()', context);
  await vm.runInContext('clearHistory()', context);
  assert.equal(signal.aborted, true);
  pending.resolve(new Response('event: done\ndata: {"message":{"content":"旧回复"}}\n\n', {headers:{'content-type':'text/event-stream'}}));
  await sending;
  assert.equal(elements.get('#chatHistory').children.length, 0);
  assert.match(elements.get('#chatStatus').textContent, /历史已清空/);
});

test('stream ending without done/error is not mistaken for success', async () => {
  const { context, elements } = setup(() => new Response('event: chunk\ndata: {"stage":"正在绘图"}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await vm.runInContext('generate(1)', context);
  assert.match(elements.get('#log').textContent, /连接已中断/);
  assert.doesNotMatch(elements.get('#log').textContent, /完成 ✅/);
  assert.equal(elements.get('#file').disabled, false);
});

test('network failure restores controls', async () => {
  const { context, elements } = setup(() => { throw new Error('网络不可用'); });
  await vm.runInContext('generate(1)', context);
  assert.match(elements.get('#log').textContent, /网络不可用/);
  assert.equal(elements.get('#file').disabled, false);
});

test('model labels are rendered as plain text', () => {
  const { context, elements } = setup(() => {});
  vm.runInContext('renderObjects({objects:[{id:1,label:"<img src=x onerror=alert(1)>"}]})', context);
  const button = elements.get('#objects').children[0];
  assert.equal(button.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(button.children.length, 0);
});
