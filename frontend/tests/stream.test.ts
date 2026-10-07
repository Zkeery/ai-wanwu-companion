// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { consumeChat } from '@/lib/stream';
import { parseProposal, parseScene, imageUrl } from '@/lib/contracts';
const message = { id: 3, role: 'assistant', content: '你好，小花园', created_at: '2026-09-18T12:00:00' };
function response(text: string, fragment = false) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) { if (fragment) for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); else controller.enqueue(bytes); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
describe('SSE contract', () => {
  it('handles split Chinese UTF-8, CRLF, comments and done', async () => {
    let output = '';
    const result = await consumeChat(response(': hello\r\n\r\nevent: chunk\r\ndata: {"delta":"你好"}\r\n\r\nevent: done\r\ndata: '+JSON.stringify({ message, proposal: { id: 'token', action: 'light_rain' } })+'\r\n\r\n', true), d => output += d);
    expect(output).toBe('你好'); expect(result.message).toEqual(message); expect(result.proposal?.id).toBe('token');
  });
  it('rejects a truncated successful HTTP stream', async () => { await expect(consumeChat(response('event: chunk\ndata: {"delta":"partial"}\n\n'), () => {})).rejects.toThrow('连接已中断'); });
  it('handles terminal server errors', async () => { await expect(consumeChat(response('event: error\ndata: {"error":{"message":"模型暂不可用"}}\n\n'), () => {})).rejects.toThrow('模型暂不可用'); });
  it('rejects HTML proxy errors without leaking HTML', async () => { await expect(consumeChat(new Response('<html>private detail</html>', { status: 502 }), () => {})).rejects.toThrow('暂时连接不上'); });
  it('ignores anything after the done event', async () => { const result = await consumeChat(response('event: done\ndata: '+JSON.stringify({ message, proposal: null })+'\n\nevent: error\ndata: {"error":{"message":"late"}}\n\n'), () => {}); expect(result.message.id).toBe(3); });
});
describe('boundary validation', () => {
  it('rejects unsupported proposals', () => { expect(() => parseProposal({ id: 'x', action: 'cloud' })).toThrow(); });
  it('rejects malformed scene elements', () => { expect(() => parseScene({ elements: { rain: '1' }, can_undo: false })).toThrow(); });
  it('prevents external and traversal image paths', () => { for (const p of ['../secret','https://external/a','/private']) expect(imageUrl(p)).toBeNull(); expect(imageUrl('characters/a b.png')).toBe('/uploads/characters/a%20b.png'); });
});

describe('terminal state never waits for transport cleanup', () => {
  it('returns persisted done even if cancellation never resolves', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('event: done\ndata: ' + JSON.stringify({ message, proposal: null }) + '\n\n')); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    });
    const result = await consumeChat(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }), () => {});
    expect(result.message).toEqual(message); expect(cancelled).toBe(true); expect(stream.locked).toBe(false);
  }, 1000);
  it('an abort releases a stalled read even when transport cancel hangs', async () => {
    const abort = new AbortController();
    const stream = new ReadableStream({ cancel() { return new Promise<void>(() => {}); } });
    const result = consumeChat(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }), () => {}, abort.signal);
    const rejection = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    await Promise.resolve(); abort.abort(new DOMException('回复等待超时', 'TimeoutError')); await rejection;
    expect(stream.locked).toBe(false);
  }, 1000);
  it('ignores malformed trailing events after a valid done', async () => {
    const result = await consumeChat(response('event: done\ndata: ' + JSON.stringify({ message, proposal: null }) + '\n\nevent: chunk\ndata: broken-json\n\n'), () => {});
    expect(result.message.id).toBe(message.id);
  });
});
