export type CreationOrigin = { kind: 'theme'; theme: 'fruit' } | { kind: 'team'; theme: 'fruit'; teamId: string };
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export function parseOrigin(value: unknown): CreationOrigin | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.theme !== 'fruit') return null;
  if (v.kind === 'theme') return { kind: 'theme', theme: 'fruit' };
  if (v.kind === 'team' && typeof v.teamId === 'string' && uuid.test(v.teamId)) return { kind: 'team', theme: 'fruit', teamId: v.teamId };
  return null;
}
export function originFromQuery(theme: unknown, team: unknown): CreationOrigin | null {
  return parseOrigin(team === undefined ? { kind: 'theme', theme } : { kind: 'team', theme, teamId: team });
}
export function previewId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value); return Number.isSafeInteger(id) ? id : null;
}
export function originPath(origin: CreationOrigin): string {
  return origin.kind === 'team' ? `/teams/${encodeURIComponent(origin.teamId)}` : `/themes/${origin.theme}`;
}
export function creationHref(origin: CreationOrigin): string {
  return `/companions/new?theme=${origin.theme}${origin.kind === 'team' ? `&team=${encodeURIComponent(origin.teamId)}` : ''}`;
}
export function returnHref(origin: CreationOrigin, characterId?: number): string {
  return `${originPath(origin)}?resume=1${characterId && Number.isSafeInteger(characterId) && characterId > 0 ? `&preview=${characterId}` : ''}`;
}
const prefix = 'creation-position:';
export function rememberPosition(origin: CreationOrigin, offset = 0): void {
  try { sessionStorage.setItem(prefix + originPath(origin), JSON.stringify({ y: Math.max(0, window.scrollY), offset })); } catch { /* Navigation still works without position storage. */ }
}
export function readPosition(origin: CreationOrigin): { y: number; offset: number } | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(prefix + originPath(origin)) || 'null');
    return v && Number.isFinite(v.y) && v.y >= 0 && v.y <= 1000000 && Number.isInteger(v.offset) && v.offset >= 0 && v.offset <= 10000 ? { y: v.y, offset: v.offset } : null;
  } catch { return null; }
}
export function clearPositions(): void {
  try { Object.keys(sessionStorage).filter(k => k.startsWith(prefix)).forEach(k => sessionStorage.removeItem(k)); } catch { /* Optional navigation state. */ }
}
export function clearPreviewQuery(): void {
  const url = new URL(window.location.href); url.searchParams.delete('preview');
  window.history.replaceState(window.history.state, '', url);
}
