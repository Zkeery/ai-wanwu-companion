import { checkResponse, request } from './api';
import { authHeaders, getToken } from './auth';
import { array, object } from './contracts';
export type TeamSummary = { id: string; title: string; theme_id: string; is_creator: boolean; invitation_active: boolean; member_count: number };
export type TeamWork = { id: string; name: string; introduction: string; author_name: string; is_mine: boolean; image_url: string; submitted_at: string };
export type TeamDetail = TeamSummary & { members: { id: string; display_name: string; is_me: boolean; is_creator: boolean; submission_count: number }[]; submissions: TeamWork[] };
export type InvitePreview = { title: string; theme_id: string; creator_name: string; member_count: number };
function str(v: unknown): string { if (typeof v !== 'string') throw new Error('小队信息暂时无法核对'); return v; }
function bool(v: unknown): boolean { if (typeof v !== 'boolean') throw new Error('小队状态暂时无法核对'); return v; }
function count(v: unknown): number { if (!Number.isInteger(v) || Number(v) < 0) throw new Error('小队人数暂时无法核对'); return Number(v); }
export function parseTeam(value: unknown): TeamSummary {
  const v = object(value); return { id: str(v.id), title: str(v.title), theme_id: str(v.theme_id), is_creator: bool(v.is_creator), invitation_active: bool(v.invitation_active), member_count: count(v.member_count) };
}
export function parseTeamDetail(value: unknown): TeamDetail {
  const v = object(value), team = parseTeam(v);
  return { ...team, members: array(v.members, x => { const m = object(x); return { id: str(m.id), display_name: str(m.display_name), is_me: bool(m.is_me), is_creator: bool(m.is_creator), submission_count: count(m.submission_count) }; }), submissions: array(v.submissions, x => {
    const w = object(x), id = str(w.id), url = str(w.image_url);
    if (url !== `/api/v1/teams/${team.id}/submissions/${id}/image` || !/^[a-f0-9-]+$/.test(team.id + id)) throw new Error('小队图片地址无法核对');
    return { id, name: str(w.name), introduction: str(w.introduction), author_name: str(w.author_name), is_mine: bool(w.is_mine), image_url: url, submitted_at: str(w.submitted_at) };
  }) };
}
const path = (id: string) => `/teams/${encodeURIComponent(id)}`;
const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export const teamsApi = {
  list: async () => array(await request('/teams'), parseTeam),
  detail: async (id: string) => parseTeamDetail(await request(path(id))),
  create: async (body: { request_id: string; title: string; theme_id: string; display_name: string }) => parseTeamDetail(await request('/teams', json('POST', body))),
  invite: async (id: string) => str(object(await request(path(id) + '/invitation', json('POST'))).token),
  revoke: (id: string) => request(path(id) + '/invitation', json('DELETE')),
  preview: async (token: string): Promise<InvitePreview> => { const v = object(await request('/team-invitations/preview', json('POST', { token }))); return { title: str(v.title), theme_id: str(v.theme_id), creator_name: str(v.creator_name), member_count: count(v.member_count) }; },
  join: async (token: string, display_name: string) => { const v = object(await request('/team-invitations/join', json('POST', { token, display_name }))); return { team_id: str(v.team_id), already_member: bool(v.already_member) }; },
  submit: async (id: string, cid: number) => parseTeamDetail(await request(path(id) + `/submissions/${cid}`, json('PUT'))),
  withdraw: (id: string, sid: string) => request(path(id) + `/submissions/${encodeURIComponent(sid)}`, json('DELETE')),
  leave: (id: string) => request(path(id) + '/membership', json('DELETE')),
  dissolve: (id: string) => request(path(id), json('DELETE')),
};
export async function teamImage(url: string, signal: AbortSignal): Promise<Blob> {
  if (!/^\/api\/v1\/teams\/[a-f0-9-]+\/submissions\/[a-f0-9-]+\/image$/.test(url)) throw new Error('图片地址无效');
  const token = getToken();
  const r = await fetch(url, { headers: authHeaders(), cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  await checkResponse(r, token);
  return r.blob();
}
