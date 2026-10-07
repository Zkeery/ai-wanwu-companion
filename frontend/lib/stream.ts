import { ApiError, checkResponse } from './api';
import { authHeaders, getToken } from './auth';
import { object, parseMessage, parseProposal, type Message, type Proposal } from './contracts';
import { reserveChat, clearPendingChat } from './chat-recovery';

export type ChatDone = { message: Message; proposal: Proposal | null };
/** Decode arbitrary network chunks, including CRLF, split UTF-8, and multiline SSE data. */
export async function consumeChat(response: Response, onDelta: (text: string) => void, signal?: AbortSignal, requestToken: string | null = getToken()): Promise<ChatDone> {
  await checkResponse(response, requestToken);
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('没有收到聊天回复，请重试');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', result: ChatDone | null = null;
  const cancelReader = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancelReader, { once: true });
  function handle(block: string) {
    let event = '', data = '';
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trimStart();
    }
    if (!event || !data || result) return;
    const value = object(JSON.parse(data));
    if (event === 'chunk') { if (typeof value.delta !== 'string') throw new Error('回复格式异常'); onDelta(value.delta); }
    if (event === 'error') { const e = object(value.error); throw new Error(typeof e.message === 'string' ? e.message : '回复未完成，请重试'); }
    if (event === 'done') result = { message: parseMessage(value.message), proposal: parseProposal(value.proposal) };
  }
  try {
    while (!result) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        handle(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (result) break;
      }
      if (done) { if (buffer.trim()) handle(buffer); break; }
    }
    if (!result) throw new Error('连接已中断，回复尚未完成。请查看已保存的历史后再试');
    return result;
  } finally {
    signal?.removeEventListener('abort', cancelReader);
    // Transport teardown may never settle; a persisted done must release the UI.
    cancelReader();
    reader.releaseLock();
  }
}
export async function sendChat(id: number, message: string, signal: AbortSignal, onDelta: (text: string) => void): Promise<ChatDone> {
  const requestToken = getToken();
  const requestId = reserveChat(id, message);
  const response = await fetch(`/api/v1/characters/${id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ message, request_id: requestId }), signal });
  let done;
  try { done = await consumeChat(response, onDelta, signal, requestToken); }
  catch (error) {
    // Only explicit pre-stream rejections release the key. Network / server
    // uncertainty and an in-progress request must keep their recovery identity.
    if (error instanceof ApiError && ([400, 401, 403, 404, 422, 429].includes(error.status) ||
        (error.status === 409 && ['scene_required', 'character_not_ready'].includes(error.code)))) clearPendingChat(id);
    throw error;
  }
  clearPendingChat(id);
  return done;
}
