import { expect, it, vi } from 'vitest';
import { consumeCreation, GenerationFailedError, creationApi, parsePhoto, validatePhoto } from '@/lib/creation';

const character = { id: 7, name: '小杯', persona: '温柔', opening_line: '你好', image_path: null, status: 'ready', created_at: '' };
it('caps legacy candidates after validating the entire response', () => {
  const objects = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, label: `物品${i + 1}` }));
  expect(parsePhoto({ id: 1, status: 'done', objects }).objects).toEqual(objects.slice(0, 5));
  expect(() => parsePhoto({ id: 1, status: 'done', objects: [...objects.slice(0, 5), { id: 6, label: 1 }] })).toThrow('对象描述格式不正确');
});
function stream(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
it('parses split UTF-8 and CRLF generation events and accepts only ready done', async () => {
  const stages: string[] = [];
  const result = await consumeCreation(stream('event: started\r\ndata: {"character_id":7}\r\n\r\nevent: chunk\r\ndata: {"stage":"正在绘图"}\r\n\r\nevent: done\r\ndata: ' + JSON.stringify(character) + '\r\n\r\n'), s => stages.push(s), new AbortController().signal);
  expect(result).toEqual(character); expect(stages).toEqual(['正在绘图']);
});
it('does not turn a disconnected stream or generating done into success', async () => {
  await expect(consumeCreation(stream('event: chunk\ndata: {"stage":"正在绘图"}\n\n'), vi.fn(), new AbortController().signal)).rejects.toThrow('连接已中断');
  await expect(consumeCreation(stream('event: done\ndata: ' + JSON.stringify({ ...character, status: 'generating' }) + '\n\n'), vi.fn(), new AbortController().signal)).rejects.toThrow('尚未生成完成');
});
it('surfaces generation error events', async () => {
  await expect(consumeCreation(stream('event: error\ndata: {"error":{"message":"生成失败"}}\n\n'), vi.fn(), new AbortController().signal)).rejects.toThrow('生成失败');
});
it('uses multipart and a stable idempotency key without a JSON content type', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 1, status: 'done', objects: [{ id: 2, label: '杯子' }] })));
  vi.stubGlobal('fetch', fetcher);
  try { await creationApi.upload(new File(['image'], 'cup.png'), 'request-key', new AbortController().signal); const init = fetcher.mock.calls[0][1]; expect(init.body).toBeInstanceOf(FormData); expect(init.headers).toEqual({ 'Idempotency-Key': 'request-key' }); }
  finally { vi.unstubAllGlobals(); }
});
it('rejects oversized, empty and unsupported input before sending', () => {
  expect(validatePhoto(new File([], 'empty.png'))).toContain('有内容');
  expect(validatePhoto(new File(['x'], 'file.txt'))).toContain('请选择');
  expect(validatePhoto(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.png'))).toContain('10MB');
});

it('distinguishes a confirmed persisted failure from a legacy or uncertain error', async () => {
  await expect(consumeCreation(stream('event: error\ndata: {"status":"failed","character_id":7,"error":{"code":"generate_failed","message":"服务响应超时"}}\n\n'), vi.fn(), new AbortController().signal)).rejects.toBeInstanceOf(GenerationFailedError);
  try { await consumeCreation(stream('event: error\ndata: {"error":{"message":"旧错误"}}\n\n'), vi.fn(), new AbortController().signal); }
  catch (error) { expect(error).not.toBeInstanceOf(GenerationFailedError); }
});
it('reveals a saved generation without waiting for a stalled stream teardown', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: done\ndata: ' + JSON.stringify(character) + '\n\n')); }, cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  const result = await consumeCreation(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), vi.fn(), new AbortController().signal);
  expect(result).toEqual(character); expect(cancelled).toBe(true); expect(body.locked).toBe(false);
}, 1000);
it('releases a hanging generation read on timeout and never treats it as a result', async () => {
  const c = new AbortController();
  const body = new ReadableStream({ cancel() { return new Promise<void>(() => {}); } });
  const result = consumeCreation(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), vi.fn(), c.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
  await Promise.resolve(); c.abort(new DOMException('超时', 'TimeoutError')); await rejected; expect(body.locked).toBe(false);
}, 1000);
it('ignores malformed events after the saved generation done', async () => {
  await expect(consumeCreation(stream('event: done\ndata: '+JSON.stringify(character)+'\n\nevent: error\ndata: broken-json\n\n'), vi.fn(), new AbortController().signal)).resolves.toEqual(character);
});
