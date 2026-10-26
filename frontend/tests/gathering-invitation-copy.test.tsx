import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Gatherings from '@/components/gatherings';
import { gatherings, parseGathering } from '@/lib/gatherings';
import { api, ApiError } from '@/lib/api';
import { TOKEN_KEY } from '@/lib/auth';

vi.mock('@/components/team-shared', () => ({ useTeamSession: () => 'synthetic-copy-session' }));
vi.mock('@/components/gathering-world', () => ({ default: () => <div aria-label="共同生活场景" /> }));
vi.mock('@/components/gathering-dialogue', () => ({ default: () => null }));
vi.mock('@/components/space-decorations', () => ({ default: () => null }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { characters: vi.fn() } }));
vi.mock('@/lib/gatherings', async original => ({ ...await original<typeof import('@/lib/gatherings')>(), gatherings: { list: vi.fn(), personal: vi.fn(), read: vi.fn(), preview: vi.fn(), create: vi.fn(), command: vi.fn(), join: vi.fn() } }));

beforeEach(() => {
  vi.resetAllMocks(); history.replaceState(null, '', '/gatherings');
  localStorage.setItem(TOKEN_KEY, 'synthetic-copy-session');
  vi.mocked(gatherings.list).mockResolvedValue([{ id: 'existing-home', title: '已加入的家', scene_type: 'home', member_count: 2 }]);
  vi.mocked(gatherings.personal).mockResolvedValue({ inventory: [], notifications: [], memories: [] });
  vi.mocked(api.characters).mockResolvedValue([]);
  vi.mocked(gatherings.read).mockResolvedValue(parseGathering({ id: 'existing-home', title: '已加入的家', scene_type: 'home', revision: 1, closed: false, is_manager: false, me: 'owner', invitation: null,
    members: [{ id: 'owner', name: '我', manager: false }], companions: [], items: [], votes: [], events: [], stories: [], goal: null, story_enabled: false, season: {} }));
});
afterEach(() => localStorage.clear());

it('distinguishes a home invitation from an account login code and lets an existing member open their home without joining again', async () => {
  render(<Gatherings />);
  const input = screen.getByLabelText('住处邀请链接或邀请码');
  expect(input).toHaveAttribute('autocapitalize', 'none');
  expect(input).toHaveAttribute('autocorrect', 'off');
  expect(input).toHaveAttribute('spellcheck', 'false');
  expect(input).toHaveAccessibleDescription(/账号登录码不要填在这里.*无需再次加入/);
  fireEvent.click(await screen.findByRole('button', { name: /已加入的家/ }));
  expect(await screen.findByRole('heading', { name: '已加入的家', level: 1 })).toBeInTheDocument();
  expect(gatherings.read).toHaveBeenCalledWith('existing-home');
  expect(gatherings.preview).not.toHaveBeenCalled();
  expect(gatherings.join).not.toHaveBeenCalled();
  expect(gatherings.create).not.toHaveBeenCalled();
  expect(gatherings.command).not.toHaveBeenCalled();
});

it('keeps a rejected home invitation separate from login and does not echo its value or submit a join', async () => {
  vi.mocked(gatherings.preview).mockRejectedValueOnce(new ApiError('邀请已失效', 404, 'not_found'));
  render(<Gatherings />);
  const input = screen.getByLabelText('住处邀请链接或邀请码');
  fireEvent.change(input, { target: { value: 'SyntheticMixedCase_Home-Code' } });
  fireEvent.submit(input.closest('form')!);
  expect(await screen.findByText(/住处邀请无效或已失效/)).toHaveTextContent('账号登录码不能填在这里');
  expect(screen.getByText(/住处邀请无效或已失效/)).not.toHaveTextContent('SyntheticMixedCase_Home-Code');
  expect(gatherings.preview).toHaveBeenCalledExactlyOnceWith('SyntheticMixedCase_Home-Code');
  expect(gatherings.join).not.toHaveBeenCalled();
  expect(gatherings.command).not.toHaveBeenCalled();
});

it('uses the same clear error for a stale invitation deep link while keeping existing homes available', async () => {
  history.replaceState(null, '', '/gatherings?invite=synthetic-stale-home');
  vi.mocked(gatherings.preview).mockRejectedValue(new ApiError('邀请已失效', 404, 'not_found'));
  render(<Gatherings />);
  expect(await screen.findByText(/住处邀请无效或已失效/)).toHaveTextContent('从下方住处列表直接进入');
  expect(await screen.findByRole('button', { name: /已加入的家/ })).toBeEnabled();
  await waitFor(() => expect(gatherings.preview).toHaveBeenCalledTimes(1));
  expect(gatherings.join).not.toHaveBeenCalled();
});

it('keeps unrelated connection failures unchanged instead of calling a valid invitation expired', async () => {
  vi.mocked(gatherings.preview).mockRejectedValueOnce(new Error('网络暂时中断'));
  render(<Gatherings />);
  const input = screen.getByLabelText('住处邀请链接或邀请码');
  fireEvent.change(input, { target: { value: 'synthetic-home-invite' } });
  fireEvent.submit(input.closest('form')!);
  expect(await screen.findByText('网络暂时中断')).toBeInTheDocument();
  expect(screen.queryByText(/住处邀请无效或已失效/)).not.toBeInTheDocument();
  expect(gatherings.join).not.toHaveBeenCalled();
});
