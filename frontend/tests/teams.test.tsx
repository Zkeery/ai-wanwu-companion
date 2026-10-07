import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import Teams from '@/components/teams';
import TeamDetailView from '@/components/team-detail';
import TeamInvitation from '@/components/team-invitation';
import { parseTeamDetail, teamsApi, teamImage, type TeamDetail } from '@/lib/teams';
import { api } from '@/lib/api';
import { setToken } from '@/lib/auth';
const { push, replace } = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace }) }));
const id = '11111111-1111-4111-8111-111111111111', sid = '22222222-2222-4222-8222-222222222222';
const team: TeamDetail = { id, title: '甜甜小队', theme_id: 'fruit', is_creator: true, invitation_active: false, member_count: 1, members: [{ id: 'member', display_name: '小桃', is_me: true, is_creator: true, submission_count: 0 }], submissions: [] };
beforeEach(() => {
  vi.restoreAllMocks(); push.mockReset(); replace.mockReset(); localStorage.clear(); sessionStorage.clear();
  window.history.replaceState(null, '', '/teams');
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
it('rejects private image paths outside the authenticated team endpoint', () => {
  const work = { id: sid, name: '果果', introduction: '可爱', author_name: '小桃', is_mine: true, image_url: `/api/v1/teams/${id}/submissions/${sid}/image`, submitted_at: 'today' };
  expect(parseTeamDetail({ ...team, submissions: [work] }).submissions).toHaveLength(1);
  for (const image_url of ['/uploads/apple.png', 'https://elsewhere/image', `/api/v1/teams/${sid}/submissions/${sid}/image`]) expect(() => parseTeamDetail({ ...team, submissions: [{ ...work, image_url }] })).toThrow();
});
it('fetches team images with auth header, never with token in URL', async () => {
  setToken('test-token');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob(['image']), { status: 200 }));
  const url = `/api/v1/teams/${id}/submissions/${sid}/image`;
  await teamImage(url, new AbortController().signal);
  expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ headers: { Authorization: 'Bearer test-token' }, cache: 'no-store' }));
});
it('does not list private teams before login', () => {
  const list = vi.spyOn(teamsApi, 'list'); render(<Teams />);
  expect(screen.getByRole('button', { name: '注册 / 登录' })).toBeInTheDocument();
  expect(list).not.toHaveBeenCalled();
});
it('creates only after confirmation and locks duplicate clicks', async () => {
  setToken('test-token');
  vi.spyOn(teamsApi, 'list').mockResolvedValue([]); vi.spyOn(api.auth, 'me').mockResolvedValue({ id: 'user', phone: '13900000055' });
  const create = vi.spyOn(teamsApi, 'create').mockResolvedValue(team); vi.spyOn(teamsApi, 'detail').mockResolvedValue(team);
  render(<Teams />); fireEvent.click(await screen.findByRole('button', { name: '创建好友小队' }));
  fireEvent.change(screen.getByLabelText('小队名字'), { target: { value: '甜甜小队' } });
  fireEvent.change(screen.getByLabelText('你在小队里的昵称'), { target: { value: '小桃' } });
  expect(create).not.toHaveBeenCalled();
  const button = screen.getByRole('button', { name: '确认创建小队' }); fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(push).toHaveBeenCalledWith(`/teams/${id}`)); expect(create).toHaveBeenCalledOnce();
});
it('uncertain creation prevents another write until checked', async () => {
  setToken('test-token'); vi.spyOn(teamsApi, 'list').mockResolvedValue([]); vi.spyOn(api.auth, 'me').mockResolvedValue({ id: 'user', phone: '13900000055' });
  const create = vi.spyOn(teamsApi, 'create').mockRejectedValue(new Error('离线')); vi.spyOn(teamsApi, 'detail').mockResolvedValue(team);
  render(<Teams />); fireEvent.click(await screen.findByRole('button', { name: '创建好友小队' }));
  fireEvent.change(screen.getByLabelText('小队名字'), { target: { value: '甜甜小队' } }); fireEvent.change(screen.getByLabelText('你在小队里的昵称'), { target: { value: '小桃' } });
  fireEvent.click(screen.getByRole('button', { name: '确认创建小队' })); fireEvent.click(await screen.findByRole('button', { name: '核对创建结果' }));
  await waitFor(() => expect(push).toHaveBeenCalledWith(`/teams/${id}`)); expect(create).toHaveBeenCalledOnce();
});
it('preview consumes fragment without joining; explicit join is idempotent', async () => {
  setToken('test-token'); window.history.replaceState(null, '', '/teams/join#invite=test-invitation');
  const preview = vi.spyOn(teamsApi, 'preview').mockResolvedValue({ title: '甜甜小队', theme_id: 'fruit', creator_name: '小桃', member_count: 1 });
  const join = vi.spyOn(teamsApi, 'join').mockResolvedValue({ team_id: id, already_member: true });
  render(<TeamInvitation />); await screen.findByText('甜甜小队');
  expect(preview).toHaveBeenCalledWith('test-invitation'); expect(window.location.hash).toBe(''); expect(join).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('你在小队里的昵称'), { target: { value: '小杏' } });
  const button = screen.getByRole('button', { name: '确认加入小队' }); fireEvent.click(button); fireEvent.click(button);
  await screen.findByText('你已经是这个小队的成员了。'); expect(join).toHaveBeenCalledOnce();
  expect(screen.getByRole('link', { name: '进入小队' })).toHaveAttribute('href', `/teams/${id}`);
  expect(replace).toHaveBeenCalledWith(`/teams/${id}`);
  expect(sessionStorage.getItem('pending-team-invitation')).toBeNull();
});
it('opening submit does not submit and only offers ready same-theme companions', async () => {
  vi.spyOn(teamsApi, 'detail').mockResolvedValue(team);
  vi.spyOn(api, 'characters').mockResolvedValue([{ id: 1, name: '水果', status: 'ready', theme_id: 'fruit', image_path: 'fruit.png', persona: '可爱', opening_line: '', created_at: '' }, { id: 2, name: '杯子', status: 'ready', theme_id: null, image_path: 'cup.png', persona: '', opening_line: '', created_at: '' }]);
  const submit = vi.spyOn(teamsApi, 'submit').mockResolvedValue(team);
  render(<TeamDetailView id={id} />); fireEvent.click(await screen.findByRole('button', { name: '提交我的伙伴' }));
  const select = await screen.findByLabelText('选择水果主题伙伴'); expect(screen.queryByRole('option', { name: '杯子' })).not.toBeInTheDocument(); expect(submit).not.toHaveBeenCalled();
  fireEvent.change(select, { target: { value: '1' } }); fireEvent.click(screen.getByRole('button', { name: '确认提交到小队' }));
  await screen.findByText('伙伴已加入小队展示。'); expect(submit).toHaveBeenCalledWith(id, 1);
});
it('failed mutation with failed reconciliation blocks further writes', async () => {
  vi.spyOn(teamsApi, 'detail').mockResolvedValueOnce(team).mockRejectedValueOnce(new Error('离线')).mockResolvedValueOnce(team);
  const invite = vi.spyOn(teamsApi, 'invite').mockRejectedValue(new Error('离线'));
  render(<TeamDetailView id={id} />); fireEvent.click(await screen.findByRole('button', { name: '生成邀请链接' }));
  const check = await screen.findByRole('button', { name: '核对小队状态' }); await waitFor(() => expect(check).not.toBeDisabled());
  expect(screen.getByRole('button', { name: '生成邀请链接' })).toBeDisabled(); fireEvent.click(check);
  await waitFor(() => expect(screen.getByRole('button', { name: '生成邀请链接' })).not.toBeDisabled()); expect(invite).toHaveBeenCalledOnce();
});
it('dissolve requires explicit confirmation and does not delete companions', async () => {
  vi.spyOn(teamsApi, 'detail').mockResolvedValue(team); const dissolve = vi.spyOn(teamsApi, 'dissolve').mockResolvedValue(null);
  render(<TeamDetailView id={id} />); fireEvent.click(await screen.findByRole('button', { name: '解散小队' })); expect(dissolve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认解散' })); await waitFor(() => expect(push).toHaveBeenCalledWith('/teams')); expect(dissolve).toHaveBeenCalledOnce();
});
it('restores pending creation after a page reload without creating a duplicate', async () => {
  setToken('test-token');
  sessionStorage.setItem('team-create:user', JSON.stringify({ request_id: id, title: '甜甜小队', display_name: '小桃', theme_id: 'fruit', pending: true }));
  vi.spyOn(teamsApi, 'list').mockResolvedValue([]); vi.spyOn(api.auth, 'me').mockResolvedValue({ id: 'user', phone: '13900000055' });
  vi.spyOn(teamsApi, 'detail').mockResolvedValue(team); const create = vi.spyOn(teamsApi, 'create');
  render(<Teams />); fireEvent.click(await screen.findByRole('button', { name: '创建好友小队' }));
  expect(screen.getByLabelText('小队名字')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '核对创建结果' }));
  await waitFor(() => expect(push).toHaveBeenCalledWith(`/teams/${id}`)); expect(create).not.toHaveBeenCalled();
});
it('returns to the original team with an eligible companion preview but never auto-submits', async () => {
  window.history.replaceState(null, '', `/teams/${id}?resume=1&preview=10`);
  vi.spyOn(teamsApi, 'detail').mockResolvedValue(team);
  vi.spyOn(api, 'characters').mockResolvedValue([{ id: 10, name: '小果', status: 'ready', theme_id: 'fruit', image_path: 'fruit.png', persona: '可爱', opening_line: '', created_at: '' }]);
  const submit = vi.spyOn(teamsApi, 'submit').mockResolvedValue(team);
  render(<TeamDetailView id={id} initialPreview={10} resume />);
  expect(await screen.findByLabelText('选择水果主题伙伴')).toHaveValue('10');
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: '去创作水果伙伴 →' })).toHaveAttribute('href', `/companions/new?theme=fruit&team=${id}`);
  fireEvent.click(await screen.findByRole('button', { name: '关闭' }));
  expect(window.location.search).not.toContain('preview'); expect(submit).not.toHaveBeenCalled();
});
it('does not substitute another companion for a missing or ineligible returned result', async () => {
  vi.spyOn(teamsApi, 'detail').mockResolvedValue(team);
  vi.spyOn(api, 'characters').mockResolvedValue([{ id: 1, name: '已有水果', status: 'ready', theme_id: 'fruit', image_path: 'fruit.png', persona: '可爱', opening_line: '', created_at: '' }]);
  const submit = vi.spyOn(teamsApi, 'submit');
  render(<TeamDetailView id={id} initialPreview={10} />);
  expect(await screen.findByLabelText('选择水果主题伙伴')).toHaveValue('');
  expect(await screen.findByRole('button', { name: '确认提交到小队' })).toBeDisabled(); expect(submit).not.toHaveBeenCalled();
  expect(screen.getAllByText(/刚才的伙伴暂时无法提交/).length).toBeGreaterThan(0);
});
it('checks membership before loading a returned companion preview', async () => {
  const { ApiError } = await import('@/lib/api');
  vi.spyOn(teamsApi, 'detail').mockRejectedValue(new ApiError('小队不可访问', 404, 'not_found'));
  const characters = vi.spyOn(api, 'characters'), submit = vi.spyOn(teamsApi, 'submit');
  render(<TeamDetailView id={id} initialPreview={10} />);
  await screen.findByText('小队已不可访问'); expect(characters).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: '回到收藏' })).toBeVisible();
});
