import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering, type Gathering } from '@/lib/gatherings';
import { HOME_MAHJONG_CALL_TEXTS } from '@/lib/living-home-mahjong-calls';
import { isHomeMahjongWinningHand, type HomeMahjongGameSnapshot, type HomeMahjongGamePreset, type HomeMahjongGameEvent } from '@/lib/living-home-mahjong-game';

const gpu = vi.hoisted(() => ({ instances: [] as Array<{ scene: THREE.Scene | null; camera: THREE.Camera | null; loop: ((time: number) => void) | null }> }));
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class OfflineRenderer {
    domElement = document.createElement('canvas'); shadowMap = { enabled: false, type: 0 }; outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 1;
    scene: THREE.Scene | null = null; camera: THREE.Camera | null = null; loop: ((time: number) => void) | null = null;
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn();
    setAnimationLoop = vi.fn((loop: ((time: number) => void) | null) => { this.loop = loop; });
    render = vi.fn((scene: THREE.Scene, camera: THREE.Camera) => { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); this.scene = scene; this.camera = camera; });
    constructor() { gpu.instances.push(this); }
  }
  return { ...actual, WebGLRenderer: OfflineRenderer };
});

class LocalPlayer {
  src = ''; preload = ''; duration = .25; error = null; paused = true; onended: (() => void) | null = null; onerror: (() => void) | null = null;
  private offset = 0; private started = 0;
  get currentTime() { return this.offset + (this.paused ? 0 : (Date.now() - this.started) / 1000); }
  set currentTime(value: number) { this.offset = value; this.started = Date.now(); }
  play = vi.fn(() => { this.started = Date.now(); this.paused = false; return Promise.resolve(); });
  pause = vi.fn(() => { this.offset = this.currentTime; this.paused = true; });
  load = vi.fn(); removeAttribute = vi.fn((name: string) => { if (name === 'src') this.src = ''; });
  flush() { if (!this.paused && this.currentTime >= this.duration) { this.paused = true; this.offset = this.duration; this.onended?.(); } }
}
const players: LocalPlayer[] = [], worlds: Array<ReturnType<typeof createLivingWorld>> = [];
let hidden = false, hiddenDescriptor: PropertyDescriptor | undefined, visibilityDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); gpu.instances.length = 0; players.length = 0; hidden = false;
  hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden'); visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperties(document, { hidden: { configurable: true, get: () => hidden }, visibilityState: { configurable: true, get: () => hidden ? 'hidden' : 'visible' } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('Audio', vi.fn(function () { const player = new LocalPlayer(); players.push(player); return player; }));
  vi.stubGlobal('AudioContext', vi.fn(() => { throw new Error('table game must use quiet local clips only'); }));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('table game integration must stay offline'); }));
  const context = { fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context as unknown as CanvasRenderingContext2D);
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
});
afterEach(() => {
  worlds.splice(0).forEach(world => world.dispose()); expect(fetch).not.toHaveBeenCalled(); expect(AudioContext).not.toHaveBeenCalled();
  if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor); else delete (document as unknown as Record<string, unknown>).hidden;
  if (visibilityDescriptor) Object.defineProperty(document, 'visibilityState', visibilityDescriptor); else delete (document as unknown as Record<string, unknown>).visibilityState;
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const clipMap = Object.fromEntries([...HOME_MAHJONG_CALL_TEXTS, '碰', '杠', '胡', '自摸', '杠上花'].map((text, index) => [text, '/local-voices/table-' + index + '.wav']));
function snapshot(): Gathering {
  return parseGathering({ id: 'synthetic-mahjong-engine', title: '本地四人麻将规则', scene_type: 'home', revision: 1, closed: false, is_manager: true, me: 'owner', members: [{ id: 'owner', name: '合成主人', manager: true }],
    companions: [4, 5, 6, 7].map((id, index) => ({ id, owner_id: 'owner', name: '合成牌友' + id, activity: 'observe', area: 'outdoor', x: .25 + index * .15, y: .6,
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: id, source: 'procedural_existing_features' } })),
    items: [{ id: 'saved-tree', kind: 'tree', x: .15, y: .22, mine: true, contributor_name: '合成', growth_status: null }, { id: 'saved-bench', kind: 'bench', x: .75, y: .65, mine: true, contributor_name: '合成', growth_status: null }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
type Flags = NonNullable<Parameters<typeof createLivingWorld>[5]>;
function setup(group = snapshot(), flags: Flags = {}) {
  const host = document.createElement('div'), labels = document.createElement('div'); Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } }); document.body.append(host, labels);
  const options: Flags = { realistic: true, localLeisurePreview: true, localRoomTransitions: true, localCompanionDoors: true, localReferenceVilla: true, localQuietAudio: true,
    localMahjongGame: true, localMahjongRules: 'basic', localSpeechClips: clipMap, initialLeisure: [{ activity: 'mahjong', actorIds: [4, 5, 6, 7] }], ...flags };
  const world = createLivingWorld(host, labels, group, vi.fn(), vi.fn(), options); worlds.push(world);
  return { world, host, labels, renderer: gpu.instances.at(-1)!, group };
}
type Fixture = ReturnType<typeof setup>;
function step(f: Fixture, delta = 100) { vi.setSystemTime(Date.now() + delta); players.forEach(player => player.flush()); expect(f.renderer.loop).toBeTypeOf('function'); f.renderer.loop!(Date.now()); }
function actor(f: Fixture, id: number) { const root = f.renderer.scene!.children.find(object => object.userData.characterId === id); expect(root).toBeDefined(); return root!; }
function ancestorActor(object: THREE.Object3D) { for (let current: THREE.Object3D | null = object; current; current = current.parent) if (typeof current.userData.characterId === 'number') return current.userData.characterId as number; return null; }
function visibleCaption(f: Fixture, text: string) { return Array.from(f.labels.querySelectorAll<HTMLElement>('.living3d-bubble')).some(node => !node.hidden && node.textContent === text); }
function setHidden(value: boolean) { hidden = value; document.dispatchEvent(new Event('visibilitychange')); }
function game(f: Fixture): HomeMahjongGameSnapshot { const state = f.world.getLocalMahjong(); expect(state.rules ?? 'basic').toBe('basic'); return state; }
function until(f: Fixture, predicate: (state: HomeMahjongGameSnapshot) => boolean, limit = 500) {
  for (let frame = 0; frame < limit; frame++) { step(f); const state = game(f); if (state.status !== 'waiting') assertPrivateTable(f, state); if (predicate(state)) return state; }
  throw new Error('MAHJONG_ENGINE_STALL ' + JSON.stringify({ game: game(f), dataset: { ...f.host.dataset }, held: held(f).map(tile => ({ name: tile.name, actorId: ancestorActor(tile) })) }));
}
function tokens(f: Fixture) { const result: THREE.Object3D[] = []; f.renderer.scene!.traverse(object => { if (object.userData.homeMahjongTile === true) result.push(object); }); return result; }
function held(f: Fixture) { return tokens(f).filter(tile => tile.visible && ancestorActor(tile) !== null); }
function exact(object: THREE.Object3D) { return { parent: object.parent, position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray(), matrix: object.matrix.toArray(), auto: object.matrixAutoUpdate }; }
function playCount() { return players.reduce((total, player) => total + player.play.mock.calls.length, 0); }
function tileFor(f: Fixture, event: HomeMahjongGameEvent) { const player = game(f).players.find(player => player.actorId === event.actorId)!; return f.renderer.scene!.getObjectByName('home-mahjong-tile-' + player.seatId.split('-').at(-1))!; }
function conservation(state: HomeMahjongGameSnapshot) { return state.wallRemaining + state.players.reduce((total, player) => total + player.hand.length + player.discards.length + player.melds.reduce((sum, meld) => sum + meld.tiles.length, 0), 0); }
function wallFor(hands: readonly (readonly string[])[], prefix: readonly string[] = []) {
  const counts = new Map<string, number>(HOME_MAHJONG_CALL_TEXTS.map(tile => [tile, 4]));
  for (const tile of [...hands.flat(), ...prefix]) { const count = counts.get(tile); expect(count).toBeGreaterThan(0); counts.set(tile, count! - 1); }
  const wall = [...prefix, ...HOME_MAHJONG_CALL_TEXTS.flatMap(tile => Array<string>(counts.get(tile)!).fill(tile))]; expect(wall).toHaveLength(84); return wall;
}
function normalPreset(): HomeMahjongGamePreset {
  const hand = ['一万', '四万', '七万', '一筒', '四筒', '七筒', '东风', '南风', '西风', '北风', '红中', '发财', '白板'], hands = Array.from({ length: 4 }, () => [...hand]); return { hands, wall: wallFor(hands), turn: 0 };
}
function kongFlowerPreset(): HomeMahjongGamePreset {
  const hands = [
    ['白板', '白板', '白板', '白板', '一万', '二万', '三万', '一筒', '二筒', '三筒', '一条', '二条', '三条'],
    ['四万', '四筒', '六筒', '二万', '四万', '九条', '八筒', '一条', '一万', '五筒', '一筒', '八条', '四万'],
    ['三条', '北风', '红中', '五条', '红中', '八万', '二万', '七条', '五条', '七万', '南风', '三条', '西风'],
    ['五万', '八条', '发财', '东风', '北风', '六筒', '发财', '八条', '东风', '九万', '二筒', '九条', '五筒'],
  ];
  // Valid 136-tile fixture: normal draws use the front, kong replacements use the tail.
  const wall = [
    '东风', '一筒', '一筒', '九条', '七万', '六条', '北风', '西风', '九万', '八筒', '七筒', '红中', '九万', '三筒',
    '九筒', '四筒', '六万', '二筒', '八万', '九筒', '三万', '七条', '七筒', '四筒', '七条', '红中', '一万', '四条',
    '二筒', '七万', '南风', '二条', '六条', '八万', '七筒', '四条', '五条', '五筒', '七筒', '南风', '三万', '五万',
    '发财', '发财', '九条', '四筒', '三筒', '三万', '七万', '一条', '六筒', '八筒', '三条', '九万', '五条', '北风',
    '六万', '三筒', '南风', '一万', '西风', '二万', '八万', '一条', '四条', '六条', '八筒', '六万', '四万', '二条',
    '五筒', '四条', '九筒', '六筒', '九筒', '五万', '西风', '六条', '二条', '六万', '五万', '八条', '七条', '东风',
  ];
  return { hands, wall, turn: 0 };
}
function assertOnlyTurnMoves(f: Fixture, state: HomeMahjongGameSnapshot) {
  const carried = held(f); expect(carried.length).toBeLessThanOrEqual(1); if (carried[0]) expect(ancestorActor(carried[0])).toBe(state.turnActorId);
  if (state.status === 'playing' && (state.phase === 'hold' && state.lastEvent?.kind === 'draw' || state.phase === 'discard' && state.phaseProgress < .6)) expect(carried).toHaveLength(1);
  for (const player of state.players) if (player.actorId !== state.turnActorId && state.status === 'playing') {
    const root = actor(f, player.actorId), left = root.getObjectByName('left-arm')!, right = root.getObjectByName('right-arm')!;
    expect(left.rotation.x).toBeCloseTo(-.42, 8); expect(left.rotation.z).toBeCloseTo(.18, 8); expect(right.rotation.x).toBeCloseTo(-.42, 8); expect(right.rotation.z).toBeCloseTo(-.18, 8);
  }
}
function assertFace(f: Fixture, event: HomeMahjongGameEvent) {
  expect(event.tile).not.toBeNull(); const tile = tileFor(f, event); expect(tile).toBeDefined(); expect(tile.userData.mahjongFace).toBe(event.tile);
  const overlay = tile.getObjectByName('home-mahjong-face-overlay') as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>; expect(overlay).toBeDefined(); expect(overlay.parent).toBe(tile); expect(overlay.userData.mahjongFace).toBe(event.tile); expect(overlay.material.map).toBeInstanceOf(THREE.CanvasTexture);
  const state = game(f); if (event.kind === 'draw' || state.phase === 'discard' && state.phaseProgress < .6) { expect(overlay.visible).toBe(false); expect(effectivelyVisible(overlay)).toBe(false); expect(tile.userData.mahjongFaceExposed).toBe(false); }
  return tile;
}

type PresentedTile = { actorId: number; role: 'hand' | 'meld' | 'discard'; text: string | null; standing: boolean; faceVisible: boolean; hidden: 'hand' | 'meld' | null; height: number };
function effectivelyVisible(object: THREE.Object3D) { for (let current: THREE.Object3D | null = object; current; current = current.parent) if (!current.visible) return false; return true; }
function assertPrivateTable(f: Fixture, state: HomeMahjongGameSnapshot) {
  expect(conservation(state)).toBe(136);
  const view = f.renderer.scene!.getObjectByName('home-mahjong-game-view'); expect(view).toBeDefined();
  const rendered = view!.userData.snapshot, displayed = rendered.tiles as PresentedTile[], proxies = held(f);
  expect(rendered.logicalTileCount).toBe(136); expect(rendered.wallRemaining).toBe(state.wallRemaining); expect(rendered.phase).toBe(state.phase); expect(rendered.turnActorId).toBe(state.turnActorId);
  expect(displayed).toHaveLength(rendered.renderedTileCount); expect(rendered.renderedTileCount).toBe(rendered.faceCount + rendered.hiddenHandCount + rendered.hiddenMeldCount);
  expect(rendered.renderedTileCount + proxies.length + state.wallRemaining).toBe(136); expect(proxies.length).toBe(rendered.proxyExcludedCount);
  expect(displayed.filter(tile => tile.faceVisible)).toHaveLength(rendered.faceCount); expect(displayed.filter(tile => tile.hidden === 'hand')).toHaveLength(rendered.hiddenHandCount); expect(displayed.filter(tile => tile.hidden === 'meld')).toHaveLength(rendered.hiddenMeldCount);
  expect(displayed.filter(tile => tile.standing)).toHaveLength(rendered.standingCount); expect(rendered.standingCount).toBe(rendered.hiddenHandCount);
  for (const tile of displayed) { if (tile.hidden) { expect(tile.text).toBeNull(); expect(tile.faceVisible).toBe(false); } else { expect(HOME_MAHJONG_CALL_TEXTS).toContain(tile.text); expect(tile.faceVisible).toBe(true); } expect(tile.standing).toBe(tile.hidden === 'hand'); }
  const winner = state.status === 'won' && state.lastEvent?.kind === 'win' ? state.lastEvent.actorId : null;
  for (const player of state.players) {
    const hand = displayed.filter(tile => tile.actorId === player.actorId && tile.role === 'hand'), excluded = state.phase === 'hold' && state.lastEvent?.kind === 'draw' && state.lastEvent.actorId === player.actorId ? 1 : 0;
    expect(hand).toHaveLength(player.hand.length - excluded);
    if (player.actorId === winner) { expect(hand.map(tile => tile.text)).toEqual(player.hand); expect(hand.every(tile => tile.faceVisible && !tile.standing && tile.hidden === null)).toBe(true); }
    else expect(hand.every(tile => tile.text === null && !tile.faceVisible && tile.standing && tile.hidden === 'hand')).toBe(true);
    const meld = displayed.filter(tile => tile.actorId === player.actorId && tile.role === 'meld');
    expect(meld.map(tile => ({ text: tile.text, hidden: tile.hidden, faceVisible: tile.faceVisible }))).toEqual(player.melds.flatMap(group => group.tiles.map(text => ({ text: group.concealed ? null : text, hidden: group.concealed ? 'meld' : null, faceVisible: !group.concealed }))));
    const pending = state.phase === 'discard' && state.phaseProgress < .6 && state.lastEvent?.kind === 'discard' && state.lastEvent.actorId === player.actorId;
    expect(displayed.filter(tile => tile.actorId === player.actorId && tile.role === 'discard').map(tile => tile.text)).toEqual(pending ? player.discards.slice(0, -1) : player.discards);
  }
  const faces = view!.getObjectByName('home-mahjong-game-tile-faces') as THREE.Mesh<THREE.BufferGeometry>, bodies = view!.getObjectByName('home-mahjong-game-tile-bodies') as THREE.Mesh<THREE.BufferGeometry>;
  expect(faces.geometry.getAttribute('position').count).toBe(rendered.faceCount * 4); expect(faces.geometry.index?.count ?? 0).toBe(rendered.faceCount * 6);
  const points = bodies.geometry.getAttribute('position'); expect(points.count).toBe((rendered.renderedTileCount + Number(state.wallRemaining > 0)) * 24); expect(bodies.geometry.index?.count ?? 0).toBe((rendered.renderedTileCount + Number(state.wallRemaining > 0)) * 36);
  const standingIndex = displayed.findIndex(tile => tile.standing);
  if (standingIndex >= 0) { const box = new THREE.Box3(); for (let index = standingIndex * 24; index < (standingIndex + 1) * 24; index++) box.expandByPoint(new THREE.Vector3().fromBufferAttribute(points, index)); const size = box.getSize(new THREE.Vector3()); expect(size.y).toBeCloseTo(displayed[standingIndex].height, 5); expect(size.y).toBeGreaterThan(Math.min(size.x, size.z) * 1.5); }
  for (const proxy of proxies) { const overlay = proxy.getObjectByName('home-mahjong-face-overlay')!; expect(overlay).toBeDefined(); expect(overlay.visible).toBe(false); expect(effectivelyVisible(overlay)).toBe(false); expect(proxy.userData.mahjongFaceExposed).toBe(false); }
  if (state.status === 'won') for (const proxy of tokens(f)) { expect(ancestorActor(proxy)).toBeNull(); expect(proxy.visible).toBe(false); expect(proxy.userData.mahjongFaceExposed).toBe(true); const overlay = proxy.getObjectByName('home-mahjong-face-overlay'); if (overlay) expect(overlay.visible).toBe(true); }
}

describe('actual opt-in four-person local mahjong table engine', () => {
  it('leaves the game disabled by default and rejects all four preview gates before reading an invalid preset', async () => {
    const group = snapshot(), invalidPreset = { hands: [], wall: [] }, cases: Array<{ group: Gathering; flags: Flags }> = [
      { group, flags: { localMahjongGame: false } }, { group, flags: { realistic: false } }, { group, flags: { localLeisurePreview: false } }, { group: { ...group, id: 'production-mahjong-table' }, flags: {} }, { group: { ...group, scene_type: 'forest' }, flags: {} },
    ];
    for (const row of cases) {
      const f = setup(row.group, { localMahjongPreset: invalidPreset, ...row.flags }); f.world.setMotion(true); for (let frame = 0; frame < 20; frame++) step(f);
      expect(game(f)).toMatchObject({ status: 'waiting', players: [], wallRemaining: 0, lastEvent: null }); expect(f.host.dataset.mahjongGameStatus).toBe('disabled'); expect(f.renderer.scene!.getObjectByName('home-mahjong-game-view')).toBeUndefined(); expect(playCount()).toBe(0);
      if (row.flags.localMahjongGame !== false) expect(await f.world.setLifeAudio(true)).toBe(false); f.world.dispose();
    }
    expect(Audio).not.toHaveBeenCalled();
  });

  it('advances three actual draw/discard turns with one actor moving, conserved hand/wall counts and matching real faces, clips and captions', async () => {
    const group = snapshot(), original = JSON.stringify(group), f = setup(group, { localMahjongPreset: normalPreset() }); expect(await f.world.setLifeAudio(true)).toBe(true); f.world.setMotion(true);
    let previous = game(f); expect(previous.status).toBe('playing'); expect(previous.players.map(player => player.hand.length)).toEqual([13, 13, 13, 13]); expect(previous.wallRemaining).toBe(84); expect(Object.isFrozen(previous.players[0].hand)).toBe(true);
    const events: HomeMahjongGameEvent[] = [], publicDiscards = new Set<number>(); let priorPlays = playCount();
    for (let frame = 0; frame < 400 && (events.length < 6 || publicDiscards.size < 3); frame++) {
      step(f); const state = game(f); for (const player of state.players) { expect(actor(f, player.actorId).visible).toBe(true); expect(actor(f, player.actorId).userData.roomRestSeat).toBeDefined(); expect(actor(f, player.actorId).userData.homeJourney?.active).not.toBe(true); }
      expect(conservation(state)).toBe(136); assertOnlyTurnMoves(f, state); assertPrivateTable(f, state); const event = state.lastEvent;
      if (event && event.id !== previous.lastEvent?.id) {
        expect(['draw', 'discard']).toContain(event.kind); const before = previous.players.find(player => player.actorId === event.actorId)!, after = state.players.find(player => player.actorId === event.actorId)!; const tile = assertFace(f, event);
        if (event.kind === 'draw') { expect(after.hand.length).toBe(before.hand.length + 1); expect(state.wallRemaining).toBe(previous.wallRemaining - 1); expect(playCount()).toBe(priorPlays); expect(ancestorActor(tile)).toBe(event.actorId); }
        else { expect(after.hand.length).toBe(before.hand.length - 1); expect(after.discards.length).toBe(before.discards.length + 1); expect(after.discards.at(-1)).toBe(event.tile); expect(state.wallRemaining).toBe(previous.wallRemaining); expect(playCount()).toBe(priorPlays + 1); expect(players.some(player => !player.paused && player.src === clipMap[event.text])).toBe(true); expect(visibleCaption(f, event.text)).toBe(true); }
        expect(f.host.dataset.mahjongGameEvent).toBe(event.kind); expect(f.host.dataset.mahjongGameText).toBe(event.kind === 'draw' ? '摸牌' : event.text); events.push(event); priorPlays = playCount();
      }
      const view = f.renderer.scene!.getObjectByName('home-mahjong-game-view')!; expect(view).toBeDefined(); expect(view.userData.snapshot.logicalTileCount).toBe(136); previous = state;
      if (event?.kind === 'discard' && state.phase === 'discard' && state.phaseProgress >= .6) {
        const proxy = tileFor(f, event), overlay = proxy.getObjectByName('home-mahjong-face-overlay')!;
        expect(proxy.visible).toBe(false); expect(ancestorActor(proxy)).toBeNull(); expect(overlay.visible).toBe(true); expect(proxy.userData.mahjongFaceExposed).toBe(true); expect(effectivelyVisible(overlay)).toBe(false);
        expect(view.userData.snapshot.tiles.some((tile: PresentedTile) => tile.actorId === event.actorId && tile.role === 'discard' && tile.text === event.tile && tile.faceVisible && tile.hidden === null)).toBe(true); publicDiscards.add(event.id);
      }
    }
    expect(events.map(event => event.kind)).toEqual(['draw', 'discard', 'draw', 'discard', 'draw', 'discard']); expect(events.filter(event => event.kind === 'draw').map(event => event.actorId)).toEqual([4, 5, 6]); expect(publicDiscards.size).toBe(3); expect(playCount()).toBe(3); expect(JSON.stringify(group)).toBe(original);
    console.info('MAHJONG_ENGINE_TURNS ' + JSON.stringify(events));
  }, 20_000);

  it('freezes rules and owned token transforms on pause, hidden pages and time jumps, then resumes only future events without duplicate clips', async () => {
    const f = setup(snapshot(), { localMahjongPreset: normalPreset() }); await f.world.setLifeAudio(true); f.world.setMotion(true); until(f, state => state.phase === 'hold' && state.lastEvent?.kind === 'draw');
    const frozen = JSON.stringify(game(f)), token = held(f)[0], transform = exact(token), worldMatrix = token.matrixWorld.toArray(), plays = playCount(); f.world.setMotion(false); expect(JSON.stringify(game(f))).toBe(frozen); vi.setSystemTime(Date.now() + 60_000); f.world.update(f.group, null, 'outdoor'); expect(JSON.stringify(game(f))).toBe(frozen); expect(exact(token)).toEqual(transform); expect(token.matrixWorld.toArray()).toEqual(worldMatrix);
    f.world.setMotion(true); expect(JSON.stringify(game(f))).toBe(frozen); setHidden(true); for (let frame = 0; frame < 10; frame++) step(f, 1000); expect(JSON.stringify(game(f))).toBe(frozen); expect(playCount()).toBe(plays); setHidden(false); step(f); expect(JSON.stringify(game(f))).toBe(frozen);
    step(f, 3_600_000); expect(JSON.stringify(game(f))).toBe(frozen); expect(playCount()).toBe(plays); const eventId = game(f).lastEvent!.id; until(f, state => !!state.lastEvent && state.lastEvent.id > eventId && state.lastEvent.kind === 'discard'); expect(playCount()).toBe(plays + 1);
  }, 15_000);

  it('returns a borrowed token when a player leaves, clears owned game meshes and resets group/viewer scopes without changing Gathering data', async () => {
    const group = snapshot(), original = JSON.stringify(group), f = setup(group, { localMahjongPreset: normalPreset() }), originals = new Map(tokens(f).map(tile => [tile, exact(tile)])); await f.world.setLifeAudio(true); f.world.setMotion(true); until(f, state => state.phase === 'hold' && state.lastEvent?.kind === 'draw');
    const carried = held(f)[0]; expect(carried).toBeDefined(); const owner = ancestorActor(carried), reduced = { ...group, revision: 2, companions: group.companions.filter(companion => companion.id !== owner) }; f.world.update(reduced, null, 'outdoor');
    expect(game(f)).toMatchObject({ status: 'waiting', players: [], lastEvent: null, wallRemaining: 0 }); expect(held(f)).toHaveLength(0); expect(exact(carried)).toEqual(originals.get(carried)); expect(f.renderer.scene!.getObjectByName('home-mahjong-game-view')).toBeUndefined();
    const count = playCount(); for (let frame = 0; frame < 30; frame++) step(f); expect(playCount()).toBe(count);
    for (const next of [{ ...reduced, id: group.id + '-next' }, { ...reduced, id: group.id + '-next', me: 'other-viewer' }]) { f.world.update(next, null, 'outdoor'); expect(game(f)).toMatchObject({ status: 'waiting', players: [], lastEvent: null }); expect(f.renderer.scene!.getObjectByName('home-mahjong-game-view')).toBeUndefined(); expect(held(f)).toHaveLength(0); expect(players.every(player => player.paused)).toBe(true); }
    const stale = f.renderer.loop; f.world.dispose(); stale?.(Date.now() + 100); expect(playCount()).toBe(count); expect(f.host.dataset.mahjongGameStatus).toBeUndefined(); expect(JSON.stringify(group)).toBe(original);
  }, 15_000);

  it('derives a real kong replacement win from a valid 136-tile preset and synchronizes the kong/flower clips, winner caption and actual tile face', async () => {
    const preset = kongFlowerPreset(), f = setup(snapshot(), { localMahjongPreset: preset }); expect(preset.hands.flat().length + preset.wall.length).toBe(136); expect(isHomeMahjongWinningHand(preset.hands[0])).toBe(false); await f.world.setLifeAudio(true); f.world.setMotion(true);
    const events: HomeMahjongGameEvent[] = []; let lastId = 0;
    for (let frame = 0; frame < 250 && game(f).status !== 'won'; frame++) {
      step(f); const state = game(f), event = state.lastEvent; expect(conservation(state)).toBe(136); assertOnlyTurnMoves(f, state); assertPrivateTable(f, state);
      if (event && event.id !== lastId) { lastId = event.id; events.push(event); assertFace(f, event); if (event.kind !== 'draw') { expect(players.some(player => !player.paused && player.src === clipMap[event.text])).toBe(true); expect(visibleCaption(f, event.text)).toBe(true); } }
    }
    const state = game(f), winner = state.players.find(player => player.actorId === 4)!; expect(state.status).toBe('won'); expect(events.map(event => event.kind)).toEqual(['draw', 'kong', 'draw', 'win']); expect(events[2]).toMatchObject({ actorId: 4, tile: '东风', afterKong: true }); expect(state.lastEvent).toMatchObject({ kind: 'win', actorId: 4, tile: '东风', text: '杠上花', afterKong: true });
    expect(winner.melds).toEqual([{ kind: 'kong', tiles: ['白板', '白板', '白板', '白板'], concealed: true }]); expect(winner.hand).toHaveLength(11); expect(isHomeMahjongWinningHand(winner.hand, winner.melds.length)).toBe(true); expect(state.wallRemaining).toBe(82); expect(playCount()).toBe(2); expect(f.host.dataset.mahjongGameText).toBe('杠上花'); console.info('MAHJONG_ENGINE_KONG_FLOWER ' + JSON.stringify({ events, winner }));
  }, 20_000);

  it('focuses the reference villa table in front of the gatehouse with an unobstructed real camera ray while retaining the classic focus offset', () => {
    const f = setup(snapshot(), { localMahjongPreset: normalPreset() }); expect(f.world.focusLocalLeisure('mahjong')).toBe(true);
    const scene = f.renderer.scene!, camera = f.renderer.camera!, table = scene.getObjectByName('home-mahjong-table')!, gatehouse = scene.getObjectByName('home-reference-villa-front-gatehouse')!; expect(gatehouse).toBeDefined();
    const center = table.getWorldPosition(new THREE.Vector3()), target = new THREE.Vector3(center.x, .8, center.z), origin = camera.getWorldPosition(new THREE.Vector3()), direction = target.clone().sub(origin).normalize(), distance = origin.distanceTo(target);
    expect(origin.z).toBeLessThan(8.49); expect(origin.y).toBeCloseTo(4.2, 8); expect(origin.z).toBeCloseTo(center.z + 2, 8); expect(camera.getWorldDirection(new THREE.Vector3()).dot(direction)).toBeGreaterThan(.999);
    const meshes: THREE.Mesh[] = []; gatehouse.traverse(object => { if (object instanceof THREE.Mesh) meshes.push(object); }); expect(meshes.length).toBeGreaterThan(0);
    const hits = new THREE.Raycaster(origin, direction, 0, distance - .01).intersectObjects(meshes, false); expect(hits.map(hit => ({ name: hit.object.name, distance: hit.distance }))).toEqual([]);
    const classic = setup(snapshot(), { localReferenceVilla: false, localMahjongPreset: normalPreset() }); expect(classic.world.focusLocalLeisure('mahjong')).toBe(true); const oldCenter = classic.renderer.scene!.getObjectByName('home-mahjong-table')!.getWorldPosition(new THREE.Vector3()), oldCamera = classic.renderer.camera!.getWorldPosition(new THREE.Vector3()); expect(oldCamera.y).toBeCloseTo(3.6, 8); expect(oldCamera.z).toBeCloseTo(oldCenter.z + 4.2, 8);
  });
});
