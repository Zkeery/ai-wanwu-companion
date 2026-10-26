import * as T from 'three';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLivingWorld } from '../lib/living-world-engine';
import { parseGathering } from '../lib/gatherings';
import type { PublicSharedMahjongSnapshot } from '../lib/shared-mahjong';

const gpu = vi.hoisted(() => ({ scene: null as T.Scene | null }));
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class Renderer {
    domElement = document.createElement('canvas'); shadowMap = { enabled: false, type: 0 }; outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 1;
    setPixelRatio() {} setSize() {} setClearColor() {} dispose() {} forceContextLoss() {} setAnimationLoop() {}
    render(scene: T.Scene) { scene.updateMatrixWorld(true); gpu.scene = scene; }
  }
  return { ...actual, WebGLRenderer: Renderer };
});
const worlds: ReturnType<typeof createLivingWorld>[] = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1500);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('engine may not fetch'); }));
  vi.stubGlobal('Audio', vi.fn(() => { throw Error('audio remains off'); }));
  vi.stubGlobal('AudioContext', vi.fn(() => { throw Error('audio remains off'); }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ fillRect() {}, strokeRect() {}, fillText() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, closePath() {} }) as unknown as CanvasRenderingContext2D);
  vi.spyOn(T.TextureLoader.prototype, 'load').mockImplementation(() => new T.Texture());
});
afterEach(() => { worlds.splice(0).forEach(w => w.dispose()); expect(fetch).not.toHaveBeenCalled(); expect(Audio).not.toHaveBeenCalled(); expect(AudioContext).not.toHaveBeenCalled(); document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function group(id = 'saved-shared-space', me = 'owner-a') {
  return parseGathering({ id, me, title: '隔离共同住处', revision: 1, scene_type: 'home', closed: false, is_manager: true,
    members: [{ id: 'owner-a', name: '合成A', manager: true }, { id: 'owner-b', name: '合成B', manager: false }],
    companions: [1, 2, 3, 4].map((id, index) => ({ id, name: `合成伙伴${id}`, owner_id: index < 2 ? 'owner-a' : 'owner-b', activity: 'observe', area: 'outdoor', x: .2 + index * .15, y: .5,
      avatar3d: { version: 1, kind: 'cup', body: '#e5e3d9', accent: '#6c9477', detail: '#38343b', seed: id, source: 'procedural_existing_features' } })),
    items: [], votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
function snapshot(): PublicSharedMahjongSnapshot {
  return { gathering_id: 'saved-shared-space', server_now_ms: 1500, can_start: false, can_new_round: false, start_blocked_reason: 'game_in_progress', game: {
    game_id: 'aa000000-0000-4000-a000-000000000001', gathering_id: 'saved-shared-space', rules_version: 'sichuan-blood-battle-v1', revision: 1, status: 'playing', phase: 'draw', turn_character_id: 1,
    wall_remaining: 56, phase_started_at_ms: 1000, next_due_at_ms: 2000, observed_at_ms: 1500, can_advance: false, advance_due: false,
    players: [1, 2, 3, 4].map((id, i) => ({ character_id: id, seat_id: `mahjong-${i}`, hand_count: 13, melds: [], discards: [], won: false, missing_suit: null, score: 0 })),
    last_event: null, score_transfers: [], settlement: null,
  } };
}
function setup() {
  const host = document.createElement('div'), labels = document.createElement('div'); Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } }); document.body.append(host, labels);
  const random = vi.fn(() => .5), world = createLivingWorld(host, labels, group(), vi.fn(), undefined, { realistic: true, persistentWorld: true, localLeisurePreview: true, localRoomTransitions: true, localCompanionDoors: true, localReferenceVilla: true, localQuietAudio: true, localMahjongGame: true, localMahjongRandom: random }); worlds.push(world);
  return { world, host, random, data: () => gpu.scene?.getObjectByName('home-mahjong-game-view')?.userData.snapshot };
}

const speechAudit = vi.hoisted(() => ({ say: vi.fn() }));
vi.mock('../lib/living-home-local-speech', () => ({ createHomeLocalSpeech: () => ({ say: speechAudit.say, pause() {}, off() {}, dispose() {}, async enable() { return false; }, getSnapshot: () => ({ enabled:false, speaking:false, status:'off', available:false, voiceName:null, currentCaption:null }) }) }));

beforeEach(() => { speechAudit.say.mockReset(); });
it('shows shared discard captions with audio disabled and requests the same event only once', () => {
 const f=setup(); f.world.setMotion(true); f.world.update(group(),1,'outdoor'); f.world.setHouseView('exterior');
 const initial=snapshot(); f.world.updateSharedMahjong(initial);
 const next=snapshot(); next.game!.revision=2; next.game!.phase='discard'; next.game!.players[0].discards=[{id:4,face:'二万'}]; next.game!.players[0].hand_count=12; next.game!.last_event={seq:1,kind:'discard',character_id:1,tile:{id:4,face:'二万'},text:'二万'};
 f.world.updateSharedMahjong(next);
 expect([...document.querySelectorAll<HTMLElement>('.living3d-bubble')].some(x=>!x.hidden&&x.textContent==='二万')).toBe(true);
 f.world.updateSharedMahjong(next); const later=structuredClone(next); later.game!.revision=3; f.world.updateSharedMahjong(later);
 expect(speechAudit.say).toHaveBeenCalledTimes(1); expect(speechAudit.say.mock.calls[0][0]).toMatchObject({text:'二万',actorId:1});
});
it('never requests historical speech on initial load, hidden updates, or cross-owner scope reset', () => {
 const f=setup(); f.world.setMotion(true); f.world.update(group(),1,'outdoor'); f.world.setHouseView('exterior');
 const value=snapshot(); value.game!.revision=2;value.game!.last_event={seq:2,kind:'discard',character_id:1,tile:{id:8,face:'三万'},text:'三万'};
 f.world.updateSharedMahjong(value);expect(speechAudit.say).not.toHaveBeenCalled();
 f.world.update(group('saved-shared-space','owner-b'),null,'outdoor');f.world.updateSharedMahjong(value);expect(speechAudit.say).not.toHaveBeenCalled();
 const hidden=vi.spyOn(document,'hidden','get').mockReturnValue(true); const next=structuredClone(value);next.game!.revision=3;next.game!.last_event!.seq=3;f.world.updateSharedMahjong(next);hidden.mockRestore();f.world.updateSharedMahjong(next);expect(speechAudit.say).not.toHaveBeenCalled();
});
