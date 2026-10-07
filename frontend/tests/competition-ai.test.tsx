import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import CompetitionAI from '@/components/competition-ai';
import { competitionAI, type AIStatus } from '@/lib/competition-ai';
import { parseMatch } from '@/lib/activities';
import { TOKEN_KEY } from '@/lib/auth';

vi.mock('@/lib/competition-ai', async original => ({ ...await original<typeof import('@/lib/competition-ai')>(), competitionAI: { read: vi.fn(), generate: vi.fn() } }));
const participant = { id: 4, name: '小苹果', owner_id: 'owner', status: 'registered', score: 0, targets: [], layout: [] };
const match = parseMatch({ id: 'match', kind: 'observe', status: 'registration', me: 'owner', is_organizer: true, invitation: null, phase_end: null, end_at: null, observed_at: 100, participants: { 4: participant, 5: { ...participant, id: 5, name: '小石头', owner_id: 'another' } }, votes: {}, events: [], rewards: {} });
const available: AIStatus = { available: true, grants: [{ id: 'grant', character_id: 4, phase: 'strategy', cap_micro: 1145600 }], tasks: [] };
const done: AIStatus = { available: true, grants: [], tasks: [{ id: 'task', request_id: 'request', character_id: 4, phase: 'strategy', state: 'done' }] };
beforeEach(() => { vi.resetAllMocks(); localStorage.setItem(TOKEN_KEY, 'token'); vi.mocked(competitionAI.read).mockResolvedValue(available); vi.mocked(competitionAI.generate).mockResolvedValue(done); });

it('reads only on mount and discloses the cap and owner-only action', async () => {
  render(<CompetitionAI match={match} refresh={vi.fn()} />);
  expect(await screen.findByText(/本次费用上限 ¥1.1456/)).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /准备策略/ })).toHaveLength(1);
  expect(screen.queryByText('小石头：')).toBeNull();
  expect(competitionAI.generate).not.toHaveBeenCalled();
});
it('does not generate without a usable grant or enabled service', async () => {
  vi.mocked(competitionAI.read).mockResolvedValue({ available: false, grants: [], tasks: [] });
  render(<CompetitionAI match={match} refresh={vi.fn()} />);
  expect(await screen.findByText(/真实策略暂未开放/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /准备策略/ })).toBeNull();
  expect(competitionAI.generate).not.toHaveBeenCalled();
});
it('locks double clicks, checks current authorization, and refreshes after one POST', async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  render(<CompetitionAI match={match} refresh={refresh} />);
  const button = await screen.findByRole('button', { name: '为小苹果准备策略' });
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(competitionAI.generate).toHaveBeenCalledTimes(1);
  expect(competitionAI.read).toHaveBeenCalledTimes(2);
  expect(await screen.findByText('小苹果：已保存')).toBeInTheDocument();
});
it('resolves a lost response by GET and never repeats a charged request', async () => {
  vi.mocked(competitionAI.generate).mockRejectedValue(new Error('网络中断'));
  const refresh = vi.fn().mockResolvedValue(undefined);
  render(<CompetitionAI match={match} refresh={refresh} />);
  fireEvent.click(await screen.findByRole('button', { name: '为小苹果准备策略' }));
  await screen.findByRole('alert');
  vi.mocked(competitionAI.read).mockResolvedValue({ ...done, tasks: [{ ...done.tasks[0], state: 'unknown' }] });
  fireEvent.click(screen.getByRole('button', { name: '核对策略与额度' }));
  expect(await screen.findByText(/小苹果：结果待核对/)).toBeInTheDocument();
  expect(competitionAI.generate).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: /准备策略/ })).toBeNull();
});
it('keeps the original id if the first POST never reached the server', async () => {
  vi.mocked(competitionAI.generate).mockRejectedValueOnce(new Error('断网')).mockResolvedValueOnce(done);
  render(<CompetitionAI match={match} refresh={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '为小苹果准备策略' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '为小苹果准备策略' }));
  await screen.findByText('小苹果：已保存');
  const calls = vi.mocked(competitionAI.generate).mock.calls;
  expect(calls[0][4]).toBe(calls[1][4]);
});
it('does not send when a previous task is discovered during preflight', async () => {
  vi.mocked(competitionAI.read).mockResolvedValueOnce(available).mockResolvedValue(done);
  render(<CompetitionAI match={match} refresh={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '为小苹果准备策略' }));
  await screen.findByText('小苹果：已保存');
  expect(competitionAI.generate).not.toHaveBeenCalled();
});
it('ignores the old result after unmount or account change', async () => {
  let resolve!: (s: AIStatus) => void;
  vi.mocked(competitionAI.generate).mockImplementation(() => new Promise(r => { resolve = r; }));
  const refresh = vi.fn();
  const view = render(<CompetitionAI match={match} refresh={refresh} />);
  fireEvent.click(await screen.findByRole('button', { name: '为小苹果准备策略' }));
  await waitFor(() => expect(competitionAI.generate).toHaveBeenCalledTimes(1));
  localStorage.setItem(TOKEN_KEY, 'new-account'); view.unmount();
  await act(async () => resolve(done));
  expect(refresh).not.toHaveBeenCalled();
});
it('offers reflection only after completion and retains server-backed thoughts', async () => {
  const completed = parseMatch({ id: 'match', kind: 'observe', status: 'completed', me: 'owner', is_organizer: true, invitation: null, phase_end: 280, end_at: 280, observed_at: 280, participants: { 4: { ...participant, status: 'completed', score: 18, ai_strategy: { order: [], text: '沿着边缘走。', origin: 'real_provider' } } }, votes: {}, events: [], rewards: {} });
  vi.mocked(competitionAI.read).mockResolvedValue({ ...available, grants: [{ ...available.grants[0], phase: 'reflection' }] });
  render(<CompetitionAI match={completed} refresh={vi.fn()} />);
  expect(await screen.findByRole('button', { name: '为小苹果生成赛后感受' })).toBeEnabled();
  expect(completed.thoughts[0].text).toBe('沿着边缘走。');
  expect(screen.queryByRole('button', { name: /准备策略/ })).toBeNull();
});

it('never describes a cancelled match as still running', async () => {
  vi.mocked(competitionAI.read).mockResolvedValue({ available: false, grants: [], tasks: [{ ...done.tasks[0], state: 'unknown' }] });
  render(<CompetitionAI match={{ ...match, status: 'cancelled' }} refresh={vi.fn()} />);
  await screen.findByText(/本场已取消，不再生成内容/);
  expect(screen.queryByText(/比赛中，已保存的策略继续执行/)).toBeNull();
  expect(screen.queryByRole('button', { name: /生成赛后|准备策略/ })).toBeNull();
  expect(competitionAI.generate).not.toHaveBeenCalled();
});

it('reads new evidence and keeps historical reflections without inventing a record', () => {
  const raw = { id: 'match', kind: 'observe', status: 'completed', me: 'owner', is_organizer: true, invitation: null, phase_end: 280, end_at: 280, observed_at: 280, participants: { 4: { ...participant, ai_reflection: { score: 18, winner: true, text: '慢慢观察很安心。', origin: 'real_provider', event_id: 'observed_0', evidence: '本场观察了5处树木目标。' } } }, votes: {}, events: [], rewards: {} };
  expect(parseMatch(raw).thoughts[0].evidence).toBe('本场观察了5处树木目标。');
  const old = { score: 18, winner: true, text: '旧的真实感受。', origin: 'real_provider' };
  expect(parseMatch({ ...raw, participants: { 4: { ...participant, ai_reflection: old } } }).thoughts[0].evidence).toBeUndefined();
  expect(() => parseMatch({ ...raw, participants: { 4: { ...participant, ai_reflection: { ...old, evidence: {} } } } })).toThrow();
});
