// Local transport regression: no model, credentials, or project database used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { parse } from 'node:url';
import { once } from 'node:events';
import config from '../next.config.ts';
import { proxyRequest } from 'next/dist/server/lib/router-utils/proxy-request.js';

const received = [];
const timers = new Set();
const upstream = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  received.push({ method: req.method, key: req.headers['idempotency-key'], body });
  const timer = setTimeout(() => {
    timers.delete(timer);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'done' }));
  }, 31_000);
  timers.add(timer);
});
const proxy = createServer((req, res) => {
  const timeout = req.url === '/configured' ? config.experimental.proxyTimeout : undefined;
  void proxyRequest(req, res, parse(`http://127.0.0.1:${upstream.address().port}/photos`, true), undefined, undefined, timeout).catch(() => {});
});
try {
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const start = Date.now();
  const results = await Promise.all(['/default', '/configured'].map(async path => {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}${path}`, {
      method: 'POST', headers: { 'Idempotency-Key': 'synthetic-receipt' },
      body: 'synthetic-photo', signal: AbortSignal.timeout(45_000),
    });
    return { path, status: response.status, body: await response.text() };
  }));
  assert.equal(results[0].status, 500, 'default proxy must reproduce the 30s failure');
  assert.equal(results[1].status, 201, 'configured proxy must preserve the delayed response');
  assert.deepEqual(JSON.parse(results[1].body), { status: 'done' });
  assert.equal(received.length, 2, 'one upstream request per attempt, no resubmission');
  for (const request of received) assert.deepEqual(request, { method: 'POST', key: 'synthetic-receipt', body: 'synthetic-photo' });
  console.log(JSON.stringify({ passed: true, elapsedMs: Date.now() - start, defaultStatus: 500, configuredStatus: 201, upstreamRequests: received.length }));
} finally {
  for (const timer of timers) clearTimeout(timer);
  proxy.closeAllConnections(); proxy.close();
  upstream.closeAllConnections(); upstream.close();
}
