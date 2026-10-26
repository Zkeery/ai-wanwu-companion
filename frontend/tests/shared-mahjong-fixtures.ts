import type { SharedMahjongSnapshot } from '@/lib/shared-mahjong';
export const mahjongGroupId = 'fc5096f1-6d9b-4f5e-a62b-f24f0802bedc';
export const mahjongTime = 1792728000000;
export function sharedMahjongFixture(): SharedMahjongSnapshot {
  return { gathering_id: mahjongGroupId, server_now_ms: mahjongTime, can_start: false, can_new_round: false, start_blocked_reason: 'game_in_progress',
    game: { game_id: '40a9d169-c25d-4073-9f0b-8c96749dc82f', gathering_id: mahjongGroupId, rules_version: 'sichuan-blood-battle-v1', revision: 1, status: 'playing', phase: 'draw', turn_character_id: 1,
      wall_remaining: 55, phase_started_at_ms: mahjongTime, next_due_at_ms: mahjongTime + 1000, observed_at_ms: mahjongTime, can_advance: true, advance_due: false,
      players: [1, 2, 3, 4].map((id, index) => ({ character_id: id, seat_id: `mahjong-${index}`, hand_count: 13, melds: [], discards: [], won: false, missing_suit: null, score: 0 })),
      own_hands: [{ character_id: 1, tiles: [{ id: 0, face: '一万' }] }], last_event: { seq: 1, kind: 'draw', character_id: 1, tile: null, text: '摸牌' }, score_transfers: [], settlement: null } };
}
