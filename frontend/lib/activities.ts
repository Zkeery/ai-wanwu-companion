import { request } from './api';
import { array, object } from './contracts';
import { text, number, boolean } from './gatherings';

export const activityNames: Record<string, string> = { observe: '自然观察', garden: '庭院布置', leaves: '秋日拾叶' };
export const decorationNames: Record<string, string> = { memorial_pot: '纪念花盆', memorial_ornament: '纪念摆件', leaf_wreath: '落叶花环', colorful_pot: '彩色花盆', warm_lights: '暖光灯串', swing: '小秋千' };
export const phaseNames: Record<string, string> = { registration: '等待报名', running: '伙伴正在比赛', voting: '参赛用户投票', completed: '已完成', cancelled: '已取消' };
export function parseMatch(value: unknown) {
  const m = object(value);
  return { id: text(m.id), kind: text(m.kind), status: text(m.status), me: text(m.me), is_organizer: boolean(m.is_organizer), invitation: m.invitation == null ? null : text(m.invitation),
    phase_end: m.phase_end == null ? null : number(m.phase_end), end_at: m.end_at == null ? null : number(m.end_at), observed_at: number(m.observed_at),
    participants: Object.values(object(m.participants)).map(v => { const p = object(v); return { id: number(p.id), owner_id: text(p.owner_id), name: text(p.name), status: text(p.status), score: number(p.score), winner: p.winner == null ? false : boolean(p.winner), targets: array(p.targets, number), layout: array(p.layout, v => { const i = object(v); return { kind: text(i.kind), x: number(i.x), y: number(i.y) }; }) }; }),
    thoughts: Object.values(object(m.participants)).flatMap(v => { const p = object(v); return ['ai_strategy', 'ai_reflection'].flatMap(key => { if (p[key] == null) return []; const saved = object(p[key]); return [{ id: number(p.id), name: text(p.name), phase: key, text: text(saved.text), origin: text(saved.origin), evidence: saved.evidence == null ? undefined : text(saved.evidence) }]; }); }),
    votes: Object.fromEntries(Object.entries(object(m.votes)).map(([k, v]) => [k, number(v)])), events: array(m.events, text),
    rewards: Object.fromEntries(Object.entries(object(m.rewards)).map(([k, v]) => { const r = object(v); return [k, { base: number(r.base), bonus: number(r.bonus), first_decoration: r.first_decoration == null ? null : text(r.first_decoration) }]; })),
  };
}
export type Match = ReturnType<typeof parseMatch>;
export function parseInventory(value: unknown) { const w = object(value); return { balance: number(w.balance), shop: Object.fromEntries(Object.entries(object(w.shop)).map(([k, v]) => [k, number(v)])), decorations: array(w.decorations, v => { const d = object(v); return { id: text(d.id), kind: text(d.kind), space_id: d.space_id == null ? null : text(d.space_id), space_kind: d.space_kind == null ? null : text(d.space_kind) }; }) }; }
export const activities = {
  list: async () => array(await request('/activities'), v => { const m = object(v); return { id: text(m.id), kind: text(m.kind), status: text(m.status) }; }),
  read: async (id: string) => parseMatch(await request(`/activities/${id}`)),
  create: async (requestId: string, kind: string, name: string) => parseMatch(await request('/activities', { method: 'POST', body: JSON.stringify({ request_id: requestId, kind, display_name: name }) })),
  command: async (id: string, command: Record<string, unknown>, requestId: string) => parseMatch(await request(`/activities/${id}/commands`, { method: 'POST', body: JSON.stringify({ request_id: requestId, command }) })),
  preview: async (token: string) => { const p = object(await request('/activities/invitations/preview', { method: 'POST', body: JSON.stringify({ token }) })); return { id: text(p.id), kind: text(p.kind), duration: number(p.duration), participants: number(p.participants) }; },
  join: async (token: string, name: string, accept: boolean, requestId: string) => { const r = await request('/activities/invitations/join', { method: 'POST', body: JSON.stringify({ request_id: requestId, token, display_name: name, accept }) }); return accept ? parseMatch(r) : null; },
  inventory: async () => parseInventory(await request('/activities/inventory')),
  exchange: async (kind: string, requestId: string) => request('/activities/exchange', { method: 'POST', body: JSON.stringify({ request_id: requestId, kind }) }),
  place: async (id: string, spaceId: string | null, spaceKind: string, requestId: string) => request('/activities/decorations', { method: 'POST', body: JSON.stringify({ request_id: requestId, decoration_id: id, space_id: spaceId, space_kind: spaceKind, x: 50, y: 50 }) }),
  inSpace: async (spaceId: string, kind: string) => array(await request(`/activities/decorations/${kind}/${spaceId}`), v => { const i = object(v); return { id: text(i.id), kind: text(i.kind), mine: boolean(i.mine), x: number(i.x), y: number(i.y) }; }),
};
