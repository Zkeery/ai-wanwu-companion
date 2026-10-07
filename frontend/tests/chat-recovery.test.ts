import { beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/lib/api';
import { clearPendingChat, pendingChat, recoverPendingChat, reserveChat } from '@/lib/chat-recovery';
import { readChatDraft, writeChatDraft } from '@/lib/chat-draft';
import { sendChat } from '@/lib/stream';

beforeEach(() => { vi.restoreAllMocks(); clearPendingChat(77); writeChatDraft(77, ''); });
it('reuses one key and rejects changing an unresolved request', () => {
  const key = reserveChat(77, '种树');
  expect(reserveChat(77, '种树')).toBe(key);
  expect(pendingChat(77)?.requestId).toBe(key);
  expect(() => reserveChat(77, '种花')).toThrow('核对');
});
it('only queries a pending task and does not resend on refresh', async () => {
  const key = reserveChat(77, '种树');
  const query = vi.spyOn(api, 'chatRequest').mockResolvedValue('running');
  expect(await recoverPendingChat(77)).toBe(true);
  expect(query).toHaveBeenCalledExactlyOnceWith(77, key);
  expect(pendingChat(77)?.requestId).toBe(key);
});
it('clears a completed request and only its matching draft', async () => {
  reserveChat(77, '种树'); writeChatDraft(77, '种树');
  vi.spyOn(api, 'chatRequest').mockResolvedValue('completed');
  expect(await recoverPendingChat(77)).toBe(false);
  expect(pendingChat(77)).toBeNull(); expect(readChatDraft(77)).toBe('');
  reserveChat(77, '种树'); writeChatDraft(77, '新写的草稿');
  await recoverPendingChat(77);
  expect(readChatDraft(77)).toBe('新写的草稿');
});
it.each(['failed', 'untracked'] as const)('preserves text after %s and allows a new explicit request', async status => {
  const old = reserveChat(77, '种树'); writeChatDraft(77, '种树');
  vi.spyOn(api, 'chatRequest').mockResolvedValue(status);
  expect(await recoverPendingChat(77)).toBe(false);
  expect(readChatDraft(77)).toBe('种树');
  expect(reserveChat(77, '种树')).not.toBe(old);
});
it('retains the same key when the original POST may not yet be visible', async () => {
  const key = reserveChat(77, '种树');
  vi.spyOn(api, 'chatRequest').mockRejectedValue(new ApiError('未找到', 404, 'not_found'));
  expect(await recoverPendingChat(77)).toBe(true);
  expect(reserveChat(77, '种树')).toBe(key);
});
it('does not discard a pending request on network or authentication errors', async () => {
  const key = reserveChat(77, '种树');
  vi.spyOn(api, 'chatRequest').mockRejectedValue(new ApiError('请登录', 401, 'unauthorized'));
  await expect(recoverPendingChat(77)).rejects.toThrow('请登录');
  expect(pendingChat(77)?.requestId).toBe(key);
});
it('transmits the saved UUID and preserves it after a broken stream', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('event: task\ndata: {}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
  const signal = new AbortController().signal;
  await expect(sendChat(77, '种树', signal, vi.fn())).rejects.toThrow('连接已中断');
  const first = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
  await expect(sendChat(77, '种树', signal, vi.fn())).rejects.toThrow();
  expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).request_id).toBe(first.request_id);
});
it.each([[409, 'scene_required'], [422, 'invalid_request'], [404, 'not_found']])('releases an explicitly rejected request (%s), preserves draft and permits edited text', async (status, code) => {
  writeChatDraft(77, '你好');
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code, message: '请求未受理' } }), { status: Number(status) }));
  await expect(sendChat(77, '你好', new AbortController().signal, vi.fn())).rejects.toThrow('请求未受理');
  expect(pendingChat(77)).toBeNull();
  expect(readChatDraft(77)).toBe('你好');
  expect(reserveChat(77, '我们种树吧')).toBeTruthy();
});
it.each([[500, 'failed'], [409, 'in_progress']])('retains the key on uncertain server state (%s)', async (status, code) => {
  const key = reserveChat(77, '你好');
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code, message: '稍后核对' } }), { status: Number(status) }));
  await expect(sendChat(77, '你好', new AbortController().signal, vi.fn())).rejects.toThrow();
  expect(pendingChat(77)?.requestId).toBe(key);
});
