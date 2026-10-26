import { afterEach, expect, it, vi } from 'vitest';
import { parseSharedMahjongSnapshot, redactSharedMahjongSnapshot, sharedMahjongApi } from '@/lib/shared-mahjong';
import { mahjongGroupId, sharedMahjongFixture } from './shared-mahjong-fixtures';
afterEach(() => vi.unstubAllGlobals());
it('reads the authoritative public game without forwarding hidden unknown fields', () => {
  const raw = { ...sharedMahjongFixture(), hidden_wall: ['hidden'], seed: 'private-seed', game: { ...sharedMahjongFixture().game!, seed: 'private-seed', full_hands: { 2: ['九万'] } } };
  const snapshot = parseSharedMahjongSnapshot(raw, mahjongGroupId, [1]), publicSnapshot = redactSharedMahjongSnapshot(snapshot);
  expect(snapshot.game?.own_hands).toHaveLength(1); expect(publicSnapshot.game).not.toHaveProperty('own_hands');
  expect(JSON.stringify(publicSnapshot)).not.toContain('private-seed'); expect(JSON.stringify(publicSnapshot)).not.toContain('九万'); expect(publicSnapshot.game?.players).toHaveLength(4);
});
it('rejects another owners hand even if a malformed server response includes it', () => {
  const raw = sharedMahjongFixture(); raw.game!.own_hands.push({ character_id: 2, tiles: [{ id: 13, face: '九万' }] });
  expect(() => parseSharedMahjongSnapshot(raw, mahjongGroupId, [1])).toThrow();
});
it('rejects leaked draw faces and concealed kong faces', () => {
  const drawn = sharedMahjongFixture(); drawn.game!.last_event!.tile = { id: 10, face: '三筒' };
  expect(() => parseSharedMahjongSnapshot(drawn, mahjongGroupId, [1])).toThrow();
  const kong = sharedMahjongFixture(); kong.game!.players[1].melds = [{ kind: 'kong', concealed: true, tile_count: 4, tiles: [{ id: 12, face: '四万' }] }];
  expect(() => parseSharedMahjongSnapshot(kong, mahjongGroupId, [1])).toThrow();
});
it('keeps an empty first game read-only and validates integer millisecond clocks', () => {
  const raw = { ...sharedMahjongFixture(), can_start: true, start_blocked_reason: null, game: null };
  expect(parseSharedMahjongSnapshot(raw, mahjongGroupId, [1]).game).toBeNull();
  expect(() => parseSharedMahjongSnapshot({ ...raw, server_now_ms: 100.5 }, mahjongGroupId, [1])).toThrow();
  expect(() => parseSharedMahjongSnapshot(raw, 'another-space', [1])).toThrow();
});
it('accepts spectator public data with no own hands and keeps all other hands as counts', () => {
  const raw = sharedMahjongFixture(); raw.game!.own_hands = [];
  expect(parseSharedMahjongSnapshot(raw, mahjongGroupId, []).game?.players.every(player => !('hand' in player))).toBe(true);
});
it('sends one revision-bound explicit start command to the free game endpoint', async () => {
  const empty = { ...sharedMahjongFixture(), game: null, can_start: true };
  const fetcher = vi.fn(async () => new Response(JSON.stringify(sharedMahjongFixture()), { status: 200 })); vi.stubGlobal('fetch', fetcher);
  await sharedMahjongApi.command(empty, [1], 'start', 'e0760ea4-9d2e-411b-905a-bb1f9340ba0e');
  expect(fetcher).toHaveBeenCalledTimes(1); const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toContain(`/gatherings/${mahjongGroupId}/mahjong/commands`); expect(init.method).toBe('POST');
  expect(JSON.parse(String(init.body))).toEqual({ request_id: 'e0760ea4-9d2e-411b-905a-bb1f9340ba0e', game_id: null, expected_revision: 0, command: { action: 'start' } });
});
