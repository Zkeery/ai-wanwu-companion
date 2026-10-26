import * as T from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeMahjongGameView } from '../lib/living-home-mahjong-game-view';
import { sharedMahjongAnimation } from '../lib/living-shared-mahjong';
import type { PublicSharedMahjongSnapshot } from '../lib/shared-mahjong';

const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ fillRect() {}, strokeRect() {}, fillText() {} }) as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('public table is offline'); }));
});
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function snapshot(): PublicSharedMahjongSnapshot {
  return { gathering_id: 'space-one', server_now_ms: 1500, can_start: false, can_new_round: false, start_blocked_reason: 'game_in_progress', game: {
    game_id: 'aa000000-0000-4000-a000-000000000001', gathering_id: 'space-one', rules_version: 'sichuan-blood-battle-v1', revision: 1, status: 'playing', phase: 'draw',
    turn_character_id: 1, wall_remaining: 56, phase_started_at_ms: 1000, next_due_at_ms: 2000, observed_at_ms: 1500, can_advance: false, advance_due: false,
    players: Array.from({ length: 4 }, (_, index) => ({ character_id: index + 1, seat_id: `mahjong-${index}`, hand_count: 13, melds: [], discards: [], won: false, missing_suit: null, score: 0 })),
    last_event: null, score_transfers: [], settlement: null,
  } };
}
function setup() {
  const scene = new T.Scene(), world = new T.Group(), table = new T.Group(); table.name = 'home-mahjong-table'; world.add(table); scene.add(world);
  const legacy = new T.Group(); legacy.name = 'home-mahjong-legacy-tiles'; table.add(legacy);
  const view = createHomeMahjongGameView(scene); cleanup.push(() => view.dispose());
  return { table, world, view, legacy, data: () => table.getObjectByName('home-mahjong-game-view')?.userData.snapshot };
}
describe('server owned shared mahjong public canvas', () => {
  it('draws exact counts with no hidden face strings or textured hand geometry', () => {
    const f = setup(), s = snapshot(), before = JSON.stringify(s); f.view.updatePublic(f.world, s);
    expect(f.data()).toMatchObject({ logicalTileCount: 108, hiddenHandCount: 52, faceCount: 0, standingCount: 52, wallRemaining: 56 });
    expect(f.data().tiles.every((tile: { text: unknown; hidden: string }) => tile.text === null && tile.hidden === 'hand')).toBe(true);
    const face = f.table.getObjectByName('home-mahjong-game-tile-faces') as T.Mesh;
    expect(face.geometry.getAttribute('position').count).toBe(0); expect(JSON.stringify(s)).toBe(before); expect(f.legacy.visible).toBe(false);
  });
  it('shows only the public discard and public pung and keeps concealed kong anonymous', () => {
    const f = setup(), s = snapshot(), game = s.game!;
    game.players[0] = { ...game.players[0], hand_count: 9, melds: [{ kind: 'kong', concealed: true, tile_count: 4, tiles: [] }] };
    game.players[1] = { ...game.players[1], hand_count: 9, melds: [{ kind: 'pung', concealed: false, tile_count: 3, tiles: [0, 1, 2].map(id => ({ id, face: '一万' })) }], discards: [{ id: 3, face: '三筒' }] };
    f.view.updatePublic(f.world, s);
    expect(f.data()).toMatchObject({ hiddenHandCount: 44, hiddenMeldCount: 4, faceCount: 4, logicalTileCount: 108 });
    expect(f.data().tiles.filter((tile: { faceVisible: boolean }) => tile.faceVisible).map((tile: { text: string }) => tile.text)).toEqual(['一万', '一万', '一万', '三筒']);
  });
  it('keeps every private hand hidden at game end, interruption and after recreation', () => {
    for (const status of ['ended', 'interrupted'] as const) { const f = setup(), s = snapshot(); s.game!.status = status; s.game!.phase = 'ended'; s.game!.players[0].won = true;
      f.view.updatePublic(f.world, s); expect(f.data().faceCount).toBe(0); expect(f.data().hiddenHandCount).toBe(52);
      f.view.reset(); f.view.updatePublic(f.world, s); expect(f.data().tiles.every((tile: { text: unknown }) => tile.text === null)).toBe(true);
    }
  });
  it('rejects a full private payload rather than silently accepting hidden hands', () => {
    const f = setup(), s = snapshot(); (s.game as unknown as Record<string, unknown>).own_hands = [{ character_id: 1, tiles: [{ id: 0, face: '九万' }] }];
    f.view.updatePublic(f.world, s); expect(f.data()).toBeUndefined(); expect(sharedMahjongAnimation(s, 1500)).toBeNull();
  });
  it('reuses geometry on repeated GET metadata and disposes it after a new revision', () => {
    const f = setup(), s = snapshot(); f.view.updatePublic(f.world, s);
    const mesh = f.table.getObjectByName('home-mahjong-game-tile-bodies') as T.Mesh, first = mesh.geometry, disposed = vi.spyOn(first, 'dispose');
    s.server_now_ms += 1000; f.view.updatePublic(f.world, s); expect(mesh.geometry).toBe(first);
    s.game!.revision++; f.view.updatePublic(f.world, s); expect(mesh.geometry).not.toBe(first); expect(disposed).toHaveBeenCalledOnce();
  });
  it('drives gestures from bounded server phase time without inventing a private draw', () => {
    const s = snapshot(); s.game!.last_event = { seq: 1, kind: 'draw', character_id: 1, tile: null, text: '摸牌' };
    const a = sharedMahjongAnimation(s, 1500)!;
    expect(a.phaseProgress).toBe(.5); expect(a.players.every(p => p.hand.length === 0)).toBe(true); expect(a.lastEvent?.tile).toBeNull();
    expect(sharedMahjongAnimation(s, 500)?.phaseProgress).toBe(0); expect(sharedMahjongAnimation(s, 999999)?.phaseProgress).toBe(1); expect(sharedMahjongAnimation(s, NaN)).toBeNull();
    expect(sharedMahjongAnimation({ ...s, game: null }, 1500)).toBeNull();
  });
  it('uses the same supplied public event for the gesture face and spoken caption', () => {
    const s = snapshot(); s.game!.phase = 'discard'; s.game!.last_event = { seq: 2, kind: 'discard', character_id: 1, tile: { id: 3, face: '三筒' }, text: '三筒' };
    const a = sharedMahjongAnimation(s, 1600)!; expect(a.lastEvent).toMatchObject({ id: 2, actorId: 1, kind: 'discard', tile: '三筒', text: '三筒' });
  });
  it('counts a private held draw once without inventing or revealing its face', () => {
    const f = setup(), s = snapshot(); s.game!.phase = 'hold'; s.game!.players[0].hand_count = 14; s.game!.wall_remaining = 55;
    s.game!.last_event = { seq: 4, kind: 'draw', character_id: 1, tile: null, text: '摸牌' };
    f.view.updatePublic(f.world, s, .5); expect(f.data()).toMatchObject({ heldDraw: true, hiddenHandCount: 52, faceCount: 0, logicalTileCount: 108, proxyExcludedCount: 1 });
    expect(f.data().renderedTileCount + f.data().wallRemaining + f.data().proxyExcludedCount).toBe(108);
  });
  it('moves the exact public discarded card from the hand proxy onto the table at the release phase', () => {
    const f = setup(), s = snapshot(); s.game!.phase = 'discard'; s.game!.wall_remaining = 55; s.game!.players[0].discards = [{ id: 7, face: '二万' }];
    s.game!.last_event = { seq: 5, kind: 'discard', character_id: 1, tile: { id: 7, face: '二万' }, text: '二万' };
    f.view.updatePublic(f.world, s, .59); expect(f.data()).toMatchObject({ pendingDiscard: true, faceCount: 0, logicalTileCount: 108, proxyExcludedCount: 1 });
    f.view.updatePublic(f.world, s, .6); expect(f.data()).toMatchObject({ pendingDiscard: false, faceCount: 1, logicalTileCount: 108, proxyExcludedCount: 0 });
    expect(f.data().tiles.filter((tile: { role: string }) => tile.role === 'discard').map((tile: { text: string }) => tile.text)).toEqual(['二万']);
    expect(f.data().renderedTileCount + f.data().wallRemaining).toBe(108);
  });
});
