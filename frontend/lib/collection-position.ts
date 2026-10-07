const KEY = 'companion-collection-position';
const MAX_AGE = 2 * 60 * 60 * 1000;
export type CollectionPosition = { ownerId: string; companionId: number; offset: number; width: number; savedAt: number };
export function clearCollectionPosition(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* Optional navigation state. */ }
}
export function rememberCollectionPosition(ownerId: string, companionId: number, offset: number): void {
  try {
    const value: CollectionPosition = { ownerId, companionId, offset, width: window.innerWidth, savedAt: Date.now() };
    sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch { /* Navigation must still work when storage is unavailable. */ }
}
export function readCollectionPosition(ownerId: string): CollectionPosition | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<CollectionPosition> | null;
    if (!v || v.ownerId !== ownerId || !Number.isSafeInteger(v.companionId) || Number(v.companionId) <= 0 ||
      !Number.isFinite(v.offset) || Math.abs(Number(v.offset)) > 1000000 ||
      !Number.isFinite(v.width) || Number(v.width) <= 0 || Number(v.width) > 100000 ||
      !Number.isFinite(v.savedAt) || Date.now() - Number(v.savedAt) < 0 || Date.now() - Number(v.savedAt) > MAX_AGE) {
      clearCollectionPosition(); return null;
    }
    return v as CollectionPosition;
  } catch { clearCollectionPosition(); return null; }
}
