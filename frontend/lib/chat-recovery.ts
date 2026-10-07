import { api, ApiError } from './api';
import { readChatDraft, writeChatDraft } from './chat-draft';

type Pending = { requestId: string; message: string };
const key = (id: number) => `companion-chat-request:${id}`;
const fallback = new Map<number, Pending>();
export function pendingChat(id: number): Pending | null {
  try {
    const raw = sessionStorage.getItem(key(id));
    if (raw) {
      const value = JSON.parse(raw);
      if (typeof value?.requestId === 'string' && typeof value.message === 'string') return value;
    }
  } catch { /* Keep the current page copy when storage is unavailable. */ }
  return fallback.get(id) ?? null;
}
export function clearPendingChat(id: number): void {
  fallback.delete(id);
  try { sessionStorage.removeItem(key(id)); } catch { /* Current page already cleared. */ }
}
export function reserveChat(id: number, message: string): string {
  const pending = pendingChat(id);
  if (pending) {
    if (pending.message !== message) throw new Error('上条消息尚未核对完成，请先核对聊天结果');
    return pending.requestId;
  }
  const next = { requestId: crypto.randomUUID(), message };
  fallback.set(id, next);
  try { sessionStorage.setItem(key(id), JSON.stringify(next)); } catch { /* In-page recovery still works. */ }
  return next.requestId;
}
export async function recoverPendingChat(id: number): Promise<boolean> {
  const pending = pendingChat(id);
  if (!pending) return false;
  let state;
  try { state = await api.chatRequest(id, pending.requestId); }
  catch (error) {
    // Retain the same key: a late original POST and a manual resend remain idempotent.
    if (error instanceof ApiError && error.status === 404) return true;
    throw error;
  }
  if (state === 'running') return true;
  clearPendingChat(id);
  if (state === 'completed' && readChatDraft(id).trim() === pending.message) writeChatDraft(id, '');
  return false;
}
