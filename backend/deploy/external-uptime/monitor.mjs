import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 32768;
const MAX_ATTEMPTS_PER_DAY = 24;
export const MAX_GAP_MS = 20 * 60 * 1000;
const CODE = { down: 'PUBLIC_SERVICE_UNREACHABLE', up: 'PUBLIC_SERVICE_RECOVERED', gap: 'EXTERNAL_CHECK_DELAYED' };

export function initialState(now) {
  return { version: 1, sequence: 0, failures: 0, successes: 0, down: false,
    lastRun: now, pending: null, attempts: [], events: [], drillComplete: false };
}

export function encryptState(state, keyHex, context) {
  if (!/^[a-f0-9]{64}$/i.test(keyHex || '')) throw new Error('CONFIG_INVALID');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') });
}

export function decryptState(text, keyHex, context) {
  try {
    const envelope = JSON.parse(text);
    if (envelope.version !== 1) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.body, 'base64')), decipher.final()]).toString());
    if (state.version !== 1 || !Number.isSafeInteger(state.sequence) || state.sequence < 0 ||
        !Number.isFinite(state.lastRun) || !Array.isArray(state.attempts) || !Array.isArray(state.events) ||
        !Number.isSafeInteger(state.failures) || !Number.isSafeInteger(state.successes) || typeof state.down !== 'boolean') throw new Error();
    return state;
  } catch { throw new Error('STATE_UNREADABLE_REVIEW_REQUIRED'); }
}

export async function boundedText(response, maximum = MAX_BYTES) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('RESPONSE_INVALID');
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) throw new Error('RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

export function validateOrigin(origin) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port) throw new Error('CONFIG_INVALID');
  return url.origin;
}

export async function probe(origin, fetcher = fetch) {
  const base = validateOrigin(origin);
  const targets = [{ path: '/partner', status: 200, type: 'text/html', kind: 'FRONTEND' },
    { path: '/partner/api/v1/auth/me', status: 401, type: 'application/json', kind: 'API' }];
  const results = await Promise.all(targets.map(async target => {
    try {
      const response = await fetcher(base + target.path, { redirect: 'manual', signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'WanwuPartnerExternalMonitor/1', 'Cache-Control': 'no-cache' } });
      if (response.status !== target.status || !(response.headers.get('content-type') || '').includes(target.type)) {
        await response.body?.cancel().catch(() => {});
        return { kind: target.kind, healthy: false, code: target.kind + '_HTTP_UNEXPECTED' };
      }
      const body = await boundedText(response);
      const valid = target.kind === 'FRONTEND' ? /<html[\s>]/i.test(body) && body.includes('万物伙伴') : Boolean(JSON.parse(body)?.error);
      return { kind: target.kind, healthy: valid, code: valid ? 'OK' : target.kind + '_BODY_UNEXPECTED' };
    } catch { return { kind: target.kind, healthy: false, code: target.kind + '_UNREACHABLE_OR_INVALID' }; }
  }));
  return { healthy: results.every(item => item.healthy), codes: results.filter(item => !item.healthy).map(item => item.code) };
}

export function evaluate(previous, result, now) {
  if (previous.pending) throw new Error('DELIVERY_REVIEW_REQUIRED');
  if (now <= previous.lastRun) throw new Error('CLOCK_OR_DUPLICATE_RUN_REVIEW_REQUIRED');
  const next = structuredClone(previous);
  const delayed = now - previous.lastRun > MAX_GAP_MS;
  if (delayed) { next.failures = 0; next.successes = 0; }
  next.lastRun = now;
  next.failures = result.healthy ? 0 : next.failures + 1;
  next.successes = result.healthy ? next.successes + 1 : 0;
  let eventCode = delayed ? CODE.gap : null;
  if (!next.down && next.failures >= 2) { next.down = true; eventCode = CODE.down; }
  else if (next.down && next.successes >= 2) { next.down = false; eventCode = CODE.up; }
  next.events.push({ at: now, healthy: result.healthy, codes: result.codes, eventCode });
  next.events = next.events.slice(-20); // Complete earlier encrypted snapshots remain in Git history.
  next.attempts = next.attempts.filter(at => now - at < 86400000);
  return { state: next, eventCode };
}

export function notificationPayload(webhook, secret, event, now) {
  if (!/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-f0-9-]+$/i.test(webhook || '') || !secret) throw new Error('CONFIG_INVALID');
  if (![...Object.values(CODE)].includes(event.code)) throw new Error('EVENT_INVALID');
  const timestamp = String(Math.floor(now / 1000));
  const sign = createHmac('sha256', timestamp + '\n' + secret).update('').digest('base64');
  return { timestamp, sign, msg_type: 'text', content: { text:
    '[万物伙伴运维通知]\n' + (event.drill ? '合成演练\n' : '') + '状态码：' + event.code + '\n事件：' + event.id + '\n来源：独立外部检测' } };
}

export async function sendNotification(config, event, now, fetcher = fetch) {
  const payload = notificationPayload(config.webhook, config.secret, event, now);
  const response = await fetcher(config.webhook, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body = JSON.parse(await boundedText(response, 8192));
  if (response.status !== 200 || (body.code ?? body.StatusCode) !== 0) throw new Error('DELIVERY_FAILED_REVIEW_REQUIRED');
}

export async function applySample(previous, result, now, deps, drill = false) {
  const { state, eventCode } = evaluate(previous, result, now);
  if (!eventCode) { await deps.save(state); return state; }
  if (state.attempts.length >= MAX_ATTEMPTS_PER_DAY) {
    state.pending = { reason: 'RATE_LIMIT_REVIEW_REQUIRED', at: now };
    await deps.save(state); throw new Error('RATE_LIMIT_REVIEW_REQUIRED');
  }
  state.sequence += 1;
  const id = createHash('sha256').update(deps.context + ':' + state.sequence + ':' + now + ':' + eventCode).digest('hex').slice(0,16);
  state.pending = { id, code: eventCode, at: now, drill, delivery: 'intent_saved' };
  state.attempts.push(now);
  await deps.save(state); // Must be durable BEFORE the one allowed HTTP send. Unknown outcomes never retry.
  try { await deps.send({ id, code: eventCode, drill }, now); }
  catch { throw new Error('DELIVERY_UNKNOWN_OR_FAILED_REVIEW_REQUIRED'); }
  state.pending = null;
  state.events.push({ at: now, delivered: id, code: eventCode, drill });
  await deps.save(state); // Failure here leaves intent saved and blocks subsequent sends.
  return state;
}

export function githubStore({ repository, token, key, file, fetcher = fetch }) {
  if (!/^Zkeery\/wanwu-partner-uptime-monitor$/.test(repository || '') || !token || !/^[a-f0-9]{64}$/i.test(key || '') || !['state.enc','drill.enc'].includes(file)) throw new Error('CONFIG_INVALID');
  const context = repository + ':' + file;
  let sha;
  async function request(method, data) {
    const response = await fetcher('https://api.github.com/repos/' + repository + '/contents/' + file + (method === 'GET' ? '?ref=monitor-state' : ''), {
      method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'WanwuPartnerExternalMonitor/1' },
      ...(data ? { body: JSON.stringify(data) } : {}) });
    if (method === 'GET' && response.status === 404) return null;
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error('STATE_STORE_REVIEW_REQUIRED'); }
    return JSON.parse(await boundedText(response, 131072));
  }
  return { context,
    async load() {
      const result = await request('GET');
      if (!result) return null;
      if (!result.sha || result.encoding !== 'base64' || typeof result.content !== 'string') throw new Error('STATE_STORE_REVIEW_REQUIRED');
      sha = result.sha;
      return decryptState(Buffer.from(result.content, 'base64').toString(), key, context);
    },
    async save(state) {
      const content = Buffer.from(encryptState(state, key, context)).toString('base64');
      const result = await request('PUT', { message: 'Record encrypted monitor state', branch: 'monitor-state', content, ...(sha ? { sha } : {}) });
      if (!result?.content?.sha) throw new Error('STATE_STORE_REVIEW_REQUIRED');
      sha = result.content.sha;
    } };
}

export async function runMonitor(mode, env = process.env, runtime = {}) {
  const fetcher = runtime.fetcher || fetch;
  const clock = runtime.clock || Date.now;
  if (!['bootstrap','check','drill'].includes(mode)) throw new Error('MODE_INVALID');
  if (env.GITHUB_ACTIONS !== 'true' || (mode !== 'check' && env.GITHUB_EVENT_NAME !== 'workflow_dispatch') ||
      !['schedule','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) || env.GITHUB_REF !== 'refs/heads/main') throw new Error('EXECUTION_CONTEXT_INVALID');
  const config = { webhook: env.FEISHU_WEBHOOK, secret: env.FEISHU_SIGNING_SECRET };
  validateOrigin(env.WANWU_TARGET_ORIGIN);
  notificationPayload(config.webhook, config.secret, { code: CODE.down, id: 'validation', drill: true }, clock());
  const store = githubStore({ repository: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN, key: env.STATE_ENCRYPTION_KEY, file: mode === 'drill' ? 'drill.enc' : 'state.enc', fetcher });
  let state = await store.load();
  if (mode === 'bootstrap') {
    if (state) throw new Error('ALREADY_INITIALIZED_NO_RESET');
    const result = await probe(env.WANWU_TARGET_ORIGIN, fetcher);
    if (!result.healthy) throw new Error('BOOTSTRAP_PROBE_FAILED');
    state = initialState(clock()); state.events.push({ at: state.lastRun, healthy: true, codes: [], eventCode: 'INITIALIZED' });
    await store.save(state); return;
  }
  const deps = { context: store.context, save: state => store.save(state), send: (event, now) => sendNotification(config, event, now, fetcher) };
  if (mode === 'drill') {
    if (state) throw new Error('DRILL_ALREADY_ATTEMPTED_NO_RETRY');
    state = initialState(clock()); await store.save(state);
    for (const healthy of [false, false, true, true]) {
      state = await applySample(state, { healthy, codes: healthy ? [] : ['SYNTHETIC_UNREACHABLE'] }, Math.max(clock(), state.lastRun + 1), deps, true);
    }
    state.drillComplete = true; await store.save(state); return;
  }
  if (!state) throw new Error('STATE_MISSING_NO_AUTO_RESET');
  const result = await probe(env.WANWU_TARGET_ORIGIN, fetcher);
  await applySample(state, result, clock(), deps);
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMonitor(process.argv[2] || 'check').then(() => console.log('MONITOR_EXECUTION_COMPLETE')).catch(() => {
    console.error('MONITOR_REVIEW_REQUIRED'); process.exitCode = 1;
  });
}
