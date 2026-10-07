// A pending message survives re-authentication, without re-sending it automatically.
const fallback = new Map<number, string>();
export const CHAT_DRAFT_UPDATED = 'companion-chat-draft-updated';
const key = (id: number) => `companion-chat-draft:${id}`;
export function readChatDraft(id: number): string {
  try { return sessionStorage.getItem(key(id)) ?? fallback.get(id) ?? ''; }
  catch { return fallback.get(id) ?? ''; }
}
export function writeChatDraft(id: number, text: string): void {
  if (text) fallback.set(id, text); else fallback.delete(id);
  try { if (text) sessionStorage.setItem(key(id), text); else sessionStorage.removeItem(key(id)); }
  catch { /* Keep the in-page copy if storage is disabled. */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CHAT_DRAFT_UPDATED, { detail: { id } }));
}
