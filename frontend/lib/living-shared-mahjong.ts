import type { HomeMahjongGameSnapshot } from './living-home-mahjong-game';
import type { PublicSharedMahjongSnapshot } from './shared-mahjong';

/** Public state drives gestures only. Private hands are never accepted here. */
export function sharedMahjongAnimation(snapshot: PublicSharedMahjongSnapshot | null, nowMs: number): HomeMahjongGameSnapshot | null {
  const game = snapshot?.game;
  if (!game || 'own_hands' in game || !Number.isFinite(nowMs)) return null;
  const span = Math.max(1, game.next_due_at_ms - game.phase_started_at_ms);
  const phaseProgress = Math.max(0, Math.min(1, (nowMs - game.phase_started_at_ms) / span));
  return {
    status: game.status === 'playing' ? 'playing' : game.settlement?.reason === 'three-winners' ? 'won' : 'exhausted',
    rules: 'sichuan', totalTiles: 108, revision: game.revision,
    players: game.players.map(p => ({ actorId: p.character_id, seatId: p.seat_id, hand: [],
      melds: p.melds.map(m => ({ kind: m.kind, concealed: m.concealed, tiles: m.concealed ? [] : m.tiles.map(t => t.face) })),
      discards: p.discards.map(t => t.face), won: p.won, missingSuit: p.missing_suit, score: p.score })),
    turnActorId: game.turn_character_id, phase: game.phase, phaseProgress, wallRemaining: game.wall_remaining,
    lastEvent: game.last_event ? { id: game.last_event.seq, kind: game.last_event.kind,
      actorId: game.last_event.character_id, tile: game.last_event.kind === 'draw' ? null : game.last_event.tile?.face ?? null,
      text: game.last_event.text, fromActorId: game.last_event.from_character_id,
      afterKong: game.last_event.after_kong, robbedKong: game.last_event.robbed_kong } : null,
  };
}
