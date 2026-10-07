import { request } from './api';
import { object } from './contracts';
import { kindMeta } from './living-ui';

export const actionNames = { turn: '转向了', layout: '换了一套绿洲布置', place: '放置了', move: '移动了', care: '照料了', store: '收纳了', restore: '摆出了', atmosphere: '调整了氛围', undo: '撤销了上一步布置' } as const;
export type JournalEvent = { revision: number; request_id: string; created_at: number; source: 'user'; action: keyof typeof actionNames; target_kind: string | null; target_item_id?: string | null; weather: 'rain' | 'clear' | 'quiet' | null };
export const journalCategories = { all: '全部', care: '照料', layout: '布置', atmosphere: '氛围' } as const;
export type JournalCategory = keyof typeof journalCategories;
export type JournalPage = { space_id: string; events: JournalEvent[]; next_before_revision: number | null; category?: JournalCategory };
export function eventCategory(event: JournalEvent): Exclude<JournalCategory, 'all'> { return event.action === 'care' ? 'care' : event.action === 'atmosphere' ? 'atmosphere' : 'layout'; }
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
export function parseJournal(value: unknown, spaceId: string, before?: number, category: JournalCategory = 'all'): JournalPage {
  const page = object(value);
  const invalid = () => { throw new Error('生活记录暂时无法核对'); };
  if (page.category !== undefined ? page.category !== category : category !== 'all') return invalid();
  if (page.space_id !== spaceId || !Array.isArray(page.events) || page.events.length > 20 || !(page.next_before_revision === null || positive(page.next_before_revision))) return invalid();
  let previous = before ?? Infinity;
  for (const raw of page.events) {
    const e = object(raw);
    if (!positive(e.revision) || e.revision >= previous || typeof e.request_id !== 'string' || e.source !== 'user' || typeof e.created_at !== 'number' || !Number.isSafeInteger(e.created_at) || e.created_at < 0 || e.created_at > 253402300799 || typeof e.action !== 'string' || !Object.hasOwn(actionNames, e.action)) return invalid();
    const needsTarget = !['atmosphere', 'undo', 'layout'].includes(e.action);
    if (needsTarget ? typeof e.target_kind !== 'string' || !Object.hasOwn(kindMeta, e.target_kind) : e.target_kind !== null) return invalid();
    if (e.target_item_id != null && (!needsTarget || typeof e.target_item_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(e.target_item_id))) return invalid();
    if (e.action === 'atmosphere' ? !['rain', 'clear', 'quiet'].includes(String(e.weather)) : e.weather !== null) return invalid();
    if (category !== 'all' && eventCategory(e as JournalEvent) !== category) return invalid();
    previous = e.revision;
  }
  if (page.next_before_revision !== null && (page.events.length !== 20 || page.next_before_revision !== previous)) return invalid();
  return page as JournalPage;
}
export function eventLabel(e: JournalEvent): string {
  if (e.action === 'atmosphere') return { rain: '开启了小雨', clear: '让庭院放晴', quiet: '让庭院安静下来' }[e.weather!];
  return actionNames[e.action] + (e.target_kind ? kindMeta[e.target_kind].name : '');
}
export async function readJournal(spaceId: string, before?: number, signal?: AbortSignal, category: JournalCategory = 'all'): Promise<JournalPage> {
  const params = new URLSearchParams();
  if (before) params.set('before_revision', String(before));
  if (category !== 'all') params.set('category', category);
  return parseJournal(await request(`/living/spaces/${encodeURIComponent(spaceId)}/activity${params.size ? `?${params}` : ''}`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000),
  }), spaceId, before, category);
}
