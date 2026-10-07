import { request } from './api';
import { object, array } from './contracts';

export function text(v: unknown): string { if (typeof v !== 'string') throw new Error('共同生活数据格式不正确'); return v; }
export function number(v: unknown): number { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('共同生活数据格式不正确'); return v; }
export function boolean(v: unknown): boolean { if (typeof v !== 'boolean') throw new Error('共同生活数据格式不正确'); return v; }
export function record(v: unknown) { const r = object(v); return { id: text(r.id), message: text(r.message), at: number(r.at) }; }
export function gatheringEvent(v: unknown) {
  const r = object(v);
  return { ...record(v), kind: r.kind == null ? null : text(r.kind),
    activity: r.activity == null ? null : text(r.activity),
    characters: r.characters == null ? [] : array(r.characters, number),
    origin: r.origin == null ? null : text(r.origin) };
}
export function parseSummary(v: unknown) { const r = object(v); return { id: text(r.id), title: text(r.title), scene_type: text(r.scene_type), member_count: number(r.member_count) }; }
export function parseGathering(v: unknown) {
  const r = object(v), season = object(r.season);
  return {
    id: text(r.id), title: text(r.title), scene_type: text(r.scene_type), revision: number(r.revision),
    closed: boolean(r.closed), is_manager: boolean(r.is_manager), me: text(r.me), invitation: r.invitation == null ? null : text(r.invitation),
    dialogue_enabled: r.dialogue_enabled === undefined ? false : boolean(r.dialogue_enabled),
    members: array(r.members, value => { const m = object(value); return { id: text(m.id), name: text(m.name), manager: boolean(m.manager) }; }),
    companions: array(r.companions, value => { const c = object(value); return { id: number(c.id), name: text(c.name), owner_id: text(c.owner_id), activity: text(c.activity), x: number(c.x), y: number(c.y), dialogue_allowed: c.dialogue_allowed === undefined ? false : boolean(c.dialogue_allowed) }; }),
    items: array(r.items, value => { const i = object(value); return { id: text(i.id), kind: text(i.kind), x: number(i.x), y: number(i.y), mine: boolean(i.mine), contributor_name: text(i.contributor_name), growth_status: i.growth_status == null ? null : text(i.growth_status) }; }),
    votes: array(r.votes, value => { const v = object(value), choices = object(v.choices); return { id: text(v.id), kind: text(v.kind), status: text(v.status), deadline: number(v.deadline), electorate: array(v.electorate, text), choices: Object.fromEntries(Object.entries(choices).map(([k, v]) => [k, boolean(v)])) }; }),
    events: array(r.events, gatheringEvent), story_enabled: boolean(r.story_enabled),
    stories: array(r.stories, value => { const s = object(value); return { id: text(s.id), status: text(s.status), message: text(s.message), recover_at: number(s.recover_at) }; }),
    goal: r.goal == null ? null : text(object(r.goal).status),
    season: season.current_season == null ? null : text(season.current_season),
  };
}
export type Gathering = ReturnType<typeof parseGathering>;
export function activityEvidence(g: Gathering, id: number) {
  const companion = g.companions.find(c => c.id === id);
  if (!companion) return null;
  return [...g.events].reverse().find(event => event.characters.includes(id) && (
    companion.activity === 'arriving' ? event.kind === 'visit' : event.kind === 'activity' && event.activity === companion.activity
  )) ?? null;
}
export function companionPosition(g: Gathering, id: number) {
  const companion = g.companions.find(c => c.id === id);
  if (!companion) return null;
  const peers = [companion], seen = new Set([id]);
  for (let index = 0; index < peers.length; index++) {
    for (const candidate of g.companions) {
      if (!seen.has(candidate.id) && Math.abs(candidate.x - peers[index].x) <= 0.3 && Math.abs(candidate.y - peers[index].y) <= 0.3) {
        seen.add(candidate.id); peers.push(candidate);
      }
    }
  }
  peers.sort((a, b) => a.x - b.x || a.y - b.y || a.id - b.id);
  const rank = peers.findIndex(c => c.id === id), columns = Math.min(peers.length, 5), rows = Math.ceil(peers.length / 5);
  const column = rank % 5, row = Math.floor(rank / 5);
  const xStep = columns > 1 ? Math.min(0.24, 0.8 / (columns - 1)) : 0;
  const xSpan = xStep * (columns - 1), ySpan = rows > 1 ? 0.5 : 0;
  const centerX = peers.reduce((sum, c) => sum + c.x, 0) / peers.length;
  const centerY = peers.reduce((sum, c) => sum + c.y, 0) / peers.length;
  const x = Math.max(0.1, Math.min(0.9 - xSpan, centerX - xSpan / 2)) + column * xStep;
  const y = Math.max(0.12, Math.min(0.78 - ySpan, centerY - ySpan / 2)) + row * 0.5;
  return { left: `${10 + x * 78}%`, top: `${8 + y * 68}%` };
}
export const gatherings = {
  list: async () => array(await request('/gatherings'), parseSummary),
  read: async (id: string, signal?: AbortSignal) => parseGathering(await request(`/gatherings/${id}`, { signal })),
  create: async (payload: Record<string, unknown>) => parseGathering(await request('/gatherings', { method: 'POST', body: JSON.stringify(payload) })),
  preview: async (token: string) => { const p = object(await request('/gatherings/invitations/preview', { method: 'POST', body: JSON.stringify({ token }) })); const s = object(p.season); return { ...parseSummary(p), season: s.current_season == null ? '尚未选择四季' : text(s.current_season) }; },
  join: async (payload: Record<string, unknown>) => parseGathering(await request('/gatherings/invitations/join', { method: 'POST', body: JSON.stringify(payload) })),
  command: async (g: Gathering, command: Record<string, unknown>, requestId: string) => parseGathering(await request(`/gatherings/${g.id}/commands`, { method: 'POST', body: JSON.stringify({ request_id: requestId, expected_revision: g.revision, command }) })),
  personal: async () => { const p = object(await request('/gatherings/personal')); return { inventory: array(p.inventory, v => { const i = object(v); return { id: text(i.id), kind: text(i.kind) }; }), notifications: array(p.notifications, record), memories: array(p.memories, record) }; },
};
export const sceneNames: Record<string, string> = { home: '家庭庭院', desert: '沙漠绿洲', forest: '林间营地' };
export const seasonNames: Record<string, string> = { spring: '春天', summer: '夏天', autumn: '秋天', winter: '冬天' };
export const itemNames: Record<string, string> = { tree: '树', bench: '长椅', shade: '遮阳棚', cushion: '坐垫', flower: '花丛', mushroom: '蘑菇', pond: '水池', campfire: '营火', fireflies: '萤火虫' };
