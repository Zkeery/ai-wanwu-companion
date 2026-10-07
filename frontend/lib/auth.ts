import { clearCollectionPosition } from './collection-position';
import { clearPositions } from './creation-origin';
export const TOKEN_KEY = 'aiwwb-token';
export const AUTH_CHANGED = 'companion-auth-changed';
export const SESSION_EXPIRED = 'companion-session-expired';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function setToken(token: string): void {
  try { if (getToken() !== token) { clearPositions(); clearCollectionPosition(); } localStorage.setItem(TOKEN_KEY, token); window.dispatchEvent(new Event(AUTH_CHANGED)); }
  catch { throw new Error('浏览器无法保存登录状态，请允许本站使用本地存储后重试'); }
}

export function clearToken(): void {
  try { clearPositions(); clearCollectionPosition(); localStorage.removeItem(TOKEN_KEY); window.dispatchEvent(new Event(AUTH_CHANGED)); } catch { /* ignore */ }
}

export function expireSession(requestToken: string | null): void {
  // A response from a previous session must not revoke a newer login.
  if (getToken() !== requestToken) return;
  clearToken();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SESSION_EXPIRED));
}

export function authHeaders(token: string | null = getToken()): Record<string, string> {
  // Some hosting gateways reserve Authorization for their own authentication.
  const header = process.env.NEXT_PUBLIC_AUTH_HEADER === 'X-Companion-Authorization'
    ? 'X-Companion-Authorization' : 'Authorization';
  return token ? { [header]: `Bearer ${token}` } : {};
}
