import { request } from './api';
import { object } from './contracts';

export type SharedMahjongTile = { id: number; face: string };
export type SharedMahjongMeld = { kind: 'pung' | 'kong'; concealed: boolean; tile_count: number; tiles: SharedMahjongTile[] };
export type SharedMahjongPlayer = { character_id: number; seat_id: string; hand_count: number; melds: SharedMahjongMeld[]; discards: SharedMahjongTile[]; won: boolean; missing_suit: '万' | '筒' | '条' | null; score: number };
export type SharedMahjongEvent = { seq: number; kind: 'draw' | 'discard' | 'pung' | 'kong' | 'win' | 'exhausted'; character_id: number; tile: SharedMahjongTile | null; text: string; from_character_id?: number; after_kong?: boolean; robbed_kong?: boolean };
export type SharedMahjongTransfer = { from_character_id: number; to_character_id: number; points: number; reason: 'win' | 'exposed-kong' | 'added-kong' | 'concealed-kong' | 'flower-pig' | 'ready' | 'kong-refund' };
export type SharedMahjongGame = {
  game_id: string; gathering_id: string; rules_version: 'sichuan-blood-battle-v1'; revision: number; status: 'playing' | 'ended' | 'interrupted';
  phase: 'exchange' | 'dingque' | 'draw' | 'hold' | 'discard' | 'claim' | 'win' | 'ended'; turn_character_id: number; wall_remaining: number;
  phase_started_at_ms: number; next_due_at_ms: number; observed_at_ms: number; can_advance: boolean; advance_due: boolean;
  players: SharedMahjongPlayer[]; last_event: SharedMahjongEvent | null; own_hands: { character_id: number; tiles: SharedMahjongTile[] }[];
  score_transfers: SharedMahjongTransfer[]; settlement: { reason: 'three-winners' | 'wall-exhausted'; ready_character_ids: number[]; flower_pig_character_ids: number[] } | null;
};
export type MahjongStartBlockedReason = 'wrong_scene' | 'not_full' | 'no_owned_participant' | 'game_in_progress' | 'invalid_participant' | 'seat_conflict';
export type SharedMahjongSnapshot = { gathering_id: string; server_now_ms: number; can_start: boolean; can_new_round: boolean; start_blocked_reason: MahjongStartBlockedReason | null; game: SharedMahjongGame | null };
export type PublicSharedMahjongSnapshot = Omit<SharedMahjongSnapshot, 'game'> & { game: Omit<SharedMahjongGame, 'own_hands'> | null };
export type SharedMahjongAction = 'start' | 'advance' | 'new_round';

const bad = (): never => { throw new Error('共同牌局状态暂时无法核对，请刷新。'); };
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : bad();
const text = (v: unknown, max = 160): string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v : bad();
const boolean = (v: unknown): boolean => typeof v === 'boolean' ? v : bad();
const choice = <T extends string>(v: unknown, choices: readonly T[]): T => typeof v === 'string' && choices.includes(v as T) ? v as T : bad();
const list = <T,>(v: unknown, parse: (item: unknown) => T, max = 160): T[] => Array.isArray(v) && v.length <= max ? v.map(parse) : bad();
const uuid = (v: unknown): string => typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v) ? v : bad();
const tile = (value: unknown): SharedMahjongTile => { const v = object(value), face = text(v.face, 3); if (!/^[一二三四五六七八九][万筒条]$/.test(face)) return bad(); return { id: integer(v.id, 0, 107), face }; };

export function parseSharedMahjongSnapshot(value: unknown, gatheringId: string, ownedCharacterIds: readonly number[]): SharedMahjongSnapshot {
  const v = object(value); if (v.gathering_id !== gatheringId) return bad();
  const result: SharedMahjongSnapshot = { gathering_id: gatheringId, server_now_ms: integer(v.server_now_ms), can_start: boolean(v.can_start), can_new_round: boolean(v.can_new_round),
    start_blocked_reason: v.start_blocked_reason == null ? null : choice<MahjongStartBlockedReason>(v.start_blocked_reason, ['wrong_scene', 'not_full', 'no_owned_participant', 'game_in_progress', 'invalid_participant', 'seat_conflict']), game: null };
  if (v.game === null) return result;
  const g = object(v.game); if (g.gathering_id !== gatheringId || g.rules_version !== 'sichuan-blood-battle-v1') return bad();
  const players = list(g.players, raw => {
    const p = object(raw);
    return { character_id: integer(p.character_id, 1), seat_id: choice(p.seat_id, ['mahjong-0', 'mahjong-1', 'mahjong-2', 'mahjong-3']), hand_count: integer(p.hand_count, 0, 18),
      melds: list(p.melds, raw => { const m = object(raw), concealed = boolean(m.concealed), tiles = list(m.tiles, tile, 4); if (concealed && tiles.length) return bad();
        return { kind: choice(m.kind, ['pung', 'kong']), concealed, tile_count: integer(m.tile_count, 3, 4), tiles }; }, 4),
      discards: list(p.discards, tile, 108), won: boolean(p.won), missing_suit: p.missing_suit === null ? null : choice(p.missing_suit, ['万', '筒', '条']), score: integer(p.score, -1000000000, 1000000000) };
  }, 4);
  if (players.length !== 4 || new Set(players.map(p => p.character_id)).size !== 4 || new Set(players.map(p => p.seat_id)).size !== 4) return bad();
  const character = (raw: unknown) => { const id = integer(raw, 1); if (!players.some(p => p.character_id === id)) return bad(); return id; };
  const own_hands = list(g.own_hands, raw => { const h = object(raw), id = character(h.character_id); if (!ownedCharacterIds.includes(id)) return bad(); return { character_id: id, tiles: list(h.tiles, tile, 18) }; }, 4);
  if (new Set(own_hands.map(h => h.character_id)).size !== own_hands.length) return bad();
  let last_event: SharedMahjongEvent | null = null;
  if (g.last_event !== null) {
    const e = object(g.last_event), kind = choice(e.kind, ['draw', 'discard', 'pung', 'kong', 'win', 'exhausted']), publicTile = e.tile === null ? null : tile(e.tile);
    if (kind === 'draw' && publicTile !== null) return bad();
    last_event = { seq: integer(e.seq), kind, character_id: character(e.character_id), tile: publicTile, text: text(e.text, 240),
      ...(e.from_character_id == null ? {} : { from_character_id: character(e.from_character_id) }), ...(e.after_kong === undefined ? {} : { after_kong: boolean(e.after_kong) }), ...(e.robbed_kong === undefined ? {} : { robbed_kong: boolean(e.robbed_kong) }) };
  }
  let settlement: SharedMahjongGame['settlement'] = null;
  if (g.settlement !== null) { const s = object(g.settlement); settlement = { reason: choice(s.reason, ['three-winners', 'wall-exhausted']), ready_character_ids: list(s.ready_character_ids, character, 4), flower_pig_character_ids: list(s.flower_pig_character_ids, character, 4) }; }
  result.game = { game_id: uuid(g.game_id), gathering_id: gatheringId, rules_version: 'sichuan-blood-battle-v1', revision: integer(g.revision, 1), status: choice(g.status, ['playing', 'ended', 'interrupted']),
    phase: choice(g.phase, ['exchange', 'dingque', 'draw', 'hold', 'discard', 'claim', 'win', 'ended']), turn_character_id: character(g.turn_character_id), wall_remaining: integer(g.wall_remaining, 0, 108),
    phase_started_at_ms: integer(g.phase_started_at_ms), next_due_at_ms: integer(g.next_due_at_ms), observed_at_ms: integer(g.observed_at_ms), can_advance: boolean(g.can_advance), advance_due: boolean(g.advance_due),
    players, last_event, own_hands, settlement, score_transfers: list(g.score_transfers, raw => { const t = object(raw); return { from_character_id: character(t.from_character_id), to_character_id: character(t.to_character_id), points: integer(t.points, 1),
      reason: choice(t.reason, ['win', 'exposed-kong', 'added-kong', 'concealed-kong', 'flower-pig', 'ready', 'kong-refund']) }; }, 1024) };
  return result;
}

export function redactSharedMahjongSnapshot(snapshot: SharedMahjongSnapshot): PublicSharedMahjongSnapshot {
  if (!snapshot.game) return { ...snapshot, game: null };
  const { own_hands, ...game } = snapshot.game;
  void own_hands;
  return { ...snapshot, game };
}
const path = (id: string) => `/gatherings/${encodeURIComponent(id)}/mahjong`;
export const sharedMahjongApi = {
  read: async (id: string, ownedIds: readonly number[], signal?: AbortSignal) => parseSharedMahjongSnapshot(await request(path(id), { signal }), id, ownedIds),
  command: async (snapshot: SharedMahjongSnapshot, ownedIds: readonly number[], action: SharedMahjongAction, requestId: string, signal?: AbortSignal) => parseSharedMahjongSnapshot(await request(path(snapshot.gathering_id) + '/commands', {
    method: 'POST', signal, body: JSON.stringify({ request_id: requestId, game_id: snapshot.game?.game_id ?? null, expected_revision: snapshot.game?.revision ?? 0, command: { action } }),
  }), snapshot.gathering_id, ownedIds),
};
