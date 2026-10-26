import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import SharedMahjongPanel from '@/components/shared-mahjong-panel';
import { parseGathering } from '@/lib/gatherings';
import type { useSharedMahjong } from '@/lib/use-shared-mahjong';
import { sharedMahjongFixture } from './shared-mahjong-fixtures';
const gathering = () => parseGathering({ id: 'panel-group', title: '牌桌', scene_type: 'home', revision: 1, me: 'owner', is_manager: true, closed: false, members: [{ id: 'owner', name: '甲', manager: true }],
  companions: [1, 2, 3, 4].map(id => ({ id, name: `伙伴${id}`, owner_id: id === 1 ? 'owner' : `other-${id}`, activity: 'observe', x: .5, y: .5 })),
  items: [], votes: [], events: [], stories: [], story_enabled: false, goal: null, season: { current_season: null } });
const state = (): ReturnType<typeof useSharedMahjong> => ({ snapshot: sharedMahjongFixture(), busy: false, error: '', needsRefresh: false, refresh: vi.fn(async () => {}), start: vi.fn(async () => {}), newRound: vi.fn(async () => {}) });
it('shows public counts by default and reveals only the callers explicitly opened hand', () => {
  const value = state(); render(<SharedMahjongPanel gathering={gathering()} state={value} />);
  expect(screen.queryByText('一万')).toBeNull(); expect(screen.getAllByText('13 张手牌 · 牌背')).toHaveLength(4);
  fireEvent.click(screen.getByRole('button', { name: '查看我的手牌' })); expect(screen.getByText('一万')).toBeInTheDocument();
  expect(screen.getByLabelText('伙伴1的本人手牌')).toBeInTheDocument(); expect(screen.queryByLabelText('伙伴2的本人手牌')).toBeNull();
});
it('requires an explicit click for a first round and never offers it during a game', () => {
  const value = state(); value.snapshot = { ...value.snapshot!, game: null, can_start: true, start_blocked_reason: null };
  const view = render(<SharedMahjongPanel gathering={gathering()} state={value} />); expect(value.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '开始本局麻将' })); expect(value.start).toHaveBeenCalledTimes(1);
  view.rerender(<SharedMahjongPanel gathering={gathering()} state={state()} />); expect(screen.queryByRole('button', { name: '开始本局麻将' })).toBeNull();
});
it('does not automatically reopen an ended game and disables all new writes while unknown', () => {
  const value = state(); value.snapshot!.game!.status = 'ended'; value.snapshot!.can_new_round = true; value.needsRefresh = true;
  render(<SharedMahjongPanel gathering={gathering()} state={value} />); expect(value.newRound).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '明确开始下一局' })).toBeDisabled(); expect(screen.getByText(/上次操作尚未确认/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '核对牌局' })); expect(value.refresh).toHaveBeenCalledTimes(1);
});
it('shows spectator hands only as backs and keeps concealed kongs concealed', () => {
  const value = state(); value.snapshot!.game!.own_hands = []; value.snapshot!.game!.players[1].melds.push({ kind: 'kong', concealed: true, tile_count: 4, tiles: [] });
  render(<SharedMahjongPanel gathering={gathering()} state={value} />); expect(screen.queryByRole('button', { name: '查看我的手牌' })).toBeNull(); expect(screen.getByText('副露：暗杠（4 张牌背）')).toBeInTheDocument();
});
