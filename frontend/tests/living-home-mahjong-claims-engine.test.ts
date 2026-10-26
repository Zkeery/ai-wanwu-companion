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
  played: string[] = [];
  src = ''; preload = ''; duration = .25; error = null; paused = true; onended: (() => void) | null = null; onerror: (() => void) | null = null;
  private offset = 0; private started = 0;
  get currentTime() { return this.offset + (this.paused ? 0 : (Date.now() - this.started) / 1000); }
  set currentTime(value: number) { this.offset = value; this.started = Date.now(); }
  play = vi.fn(() => { this.played.push(this.src); this.started = Date.now(); this.paused = false; return Promise.resolve(); });
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
const clipMap: Record<string, string> = Object.fromEntries(HOME_MAHJONG_CALL_TEXTS.map(text => {
  const rank = '一二三四五六七八九'.indexOf(text[0]) + 1, suit = ({ 万: 'wan', 筒: 'tong', 条: 'tiao' } as Record<string, string>)[text[1]];
  const honor = ({ 东风: 'east', 南风: 'south', 西风: 'west', 北风: 'north', 红中: 'red', 发财: 'green', 白板: 'white' } as Record<string, string>)[text];
  return [text, '/local-voices/mahjong-' + (suit ? suit + '-' + rank : honor) + '.wav'];
}));
Object.assign(clipMap, { 吃: '/local-voices/mahjong-chow.wav', 碰: '/local-voices/mahjong-pung.wav', 杠: '/local-voices/mahjong-kong.wav', 胡: '/local-voices/mahjong-hu.wav', 自摸: '/local-voices/mahjong-self-draw.wav', 杠上花: '/local-voices/mahjong-kong-draw-win.wav', 抢杠胡: '/local-voices/mahjong-rob-kong-win.wav' });
function snapshot(): Gathering {
  return parseGathering({ id: 'synthetic-mahjong-claims-engine', title: '本地吃碰补杠真实规则', scene_type: 'home', revision: 1, closed: false, is_manager: true, me: 'owner', members: [{ id: 'owner', name: '合成主人', manager: true }],
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
function tokens(f: Fixture) { const result: THREE.Object3D[] = []; f.renderer.scene!.traverse(object => { if (object.userData.homeMahjongTile === true) result.push(object); }); return result; }
function held(f: Fixture) { return tokens(f).filter(tile => tile.visible && ancestorActor(tile) !== null); }
function exact(object: THREE.Object3D) { return { parent: object.parent, position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray(), matrix: object.matrix.toArray(), auto: object.matrixAutoUpdate }; }
function playCount() { return players.reduce((total, player) => total + player.play.mock.calls.length, 0); }
function tileFor(f: Fixture, event: HomeMahjongGameEvent) { const player = game(f).players.find(player => player.actorId === event.actorId)!; return f.renderer.scene!.getObjectByName('home-mahjong-tile-' + player.seatId.split('-').at(-1))!; }
function conservation(state: HomeMahjongGameSnapshot) { return state.wallRemaining + state.players.reduce((total, player) => total + player.hand.length + player.discards.length + player.melds.reduce((sum, meld) => sum + meld.tiles.length, 0), 0); }
const presets: Record<'chow' | 'addedKong' | 'robKong', HomeMahjongGamePreset> = {
  chow: {
    hands: [
      ["四筒","四筒","五筒","五筒","六筒","六筒","四条","四条","五条","五条","六条","六条","五万"],
      ["四万","六万","五万","七万","八万","九万","一筒","二筒","三筒","一条","二条","三条","白板"],
      ["五万","七万","八万","九万","七筒","八筒","九筒","七条","八条","九条","东风","南风","西风"],
      ["五万","一万","一万","二万","二万","三万","三万","七万","七万","八万","八万","北风","红中"],
    ],
    wall: [
      "七筒","九条","九条","二条","四万","二筒","发财","二筒","七条","三筒","一条","三万","四筒","东风",
      "二万","二条","一筒","九筒","白板","九万","四条","七条","发财","二万","九万","发财","三条","九条",
      "五筒","七条","四万","八筒","西风","七筒","五条","四筒","红中","西风","八筒","四条","九筒","一万",
      "东风","发财","六筒","五筒","二筒","八条","南风","三条","北风","七筒","六筒","红中","六条","北风",
      "八条","白板","三筒","红中","西风","一筒","南风","八条","三万","一筒","一条","六条","二条","北风",
      "五条","六万","东风","三筒","白板","一万","三条","一条","南风","六万","四万","九筒","八筒","六万",
    ],
    turn: 0,
  },
  addedKong: {
    hands: [
      ["四筒","四筒","五筒","五筒","六筒","六筒","四条","四条","五条","五条","六条","六条","五万"],
      ["五万","五万","一万","二万","三万","七万","八万","九万","七筒","八筒","九筒","八筒","白板"],
      ["四万","六万","一筒","二筒","三筒","四筒","五筒","六筒","一条","二条","东风","东风","白板"],
      ["一万","一万","二万","二万","三万","三万","七万","七万","八万","八万","九万","九万","北风"],
    ],
    wall: [
      "七筒","八条","红中","西风","五万","九条","三筒","五筒","二条","九万","红中","五条","一条","一筒",
      "南风","七万","东风","四万","八万","五条","七条","三条","二万","二条","一条","西风","一筒","北风",
      "七条","发财","南风","二筒","九条","七筒","四筒","九筒","三条","九筒","九条","发财","白板","东风",
      "四万","七筒","六筒","二筒","八条","南风","红中","西风","北风","八筒","红中","七条","发财","八条",
      "西风","三筒","四条","六条","一筒","发财","八条","三万","二筒","二条","七条","三条","北风","六条",
      "六万","九条","三筒","白板","一万","四条","三条","南风","六万","四万","一条","九筒","六万","八筒",
    ],
    turn: 0,
  },
  robKong: {
    hands: [
      ["四筒","四筒","五筒","五筒","六筒","六筒","四条","四条","五条","五条","六条","六条","五万"],
      ["五万","五万","一万","二万","三万","七万","八万","九万","七筒","八筒","九筒","八筒","白板"],
      ["四万","六万","一筒","二筒","三筒","四筒","五筒","六筒","一条","二条","东风","东风","白板"],
      ["一万","一万","二万","二万","三万","三万","七万","七万","八万","八万","九万","九万","北风"],
    ],
    wall: [
      "七筒","三条","红中","西风","五万","九条","三筒","五筒","二条","九万","红中","六条","一条","一筒",
      "南风","七万","东风","四万","八万","五条","七条","三条","二万","二条","一条","西风","一筒","北风",
      "八条","发财","南风","二筒","九条","七筒","四筒","九筒","三条","九筒","九条","发财","白板","东风",
      "四万","七筒","六筒","二筒","八条","南风","红中","西风","北风","八筒","红中","七条","发财","八条",
      "西风","三筒","四条","六条","一筒","发财","八条","三万","二筒","二条","七条","四条","北风","七条",
      "六万","九条","三筒","白板","一万","五条","三条","南风","六万","四万","一条","九筒","六万","八筒",
    ],
    turn: 0,
  },
};
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

type Transition = { before: HomeMahjongGameSnapshot; after: HomeMahjongGameSnapshot; event: HomeMahjongGameEvent };
function assertRealTable(f: Fixture, state: HomeMahjongGameSnapshot) {
  expect(conservation(state)).toBe(136); assertOnlyTurnMoves(f, state);
  for (const player of state.players) { const root = actor(f, player.actorId); expect(root.visible).toBe(true); expect(root.userData.roomRestSeat?.seatId).toBe(player.seatId); expect(root.userData.homeJourney?.active).not.toBe(true); }
  assertPrivateTable(f, state);
}
function advance(f: Fixture, transitions: Transition[]) {
  const before = game(f), priorPlays = playCount(); step(f); const after = game(f); assertRealTable(f, after); const event = after.lastEvent;
  if (!event || event.id === before.lastEvent?.id) { expect(playCount()).toBe(priorPlays); return null; }
  assertFace(f, event); expect(f.host.dataset.mahjongGameEvent).toBe(event.kind); expect(f.host.dataset.mahjongGameText).toBe(event.kind === 'draw' ? '摸牌' : event.text);
  if (event.kind === 'draw') expect(playCount()).toBe(priorPlays);
  else { expect(playCount()).toBe(priorPlays + 1); expect(players.some(player => !player.paused && player.src === clipMap[event.text])).toBe(true); expect(visibleCaption(f, event.text)).toBe(true); }
  const transition = { before, after, event }; transitions.push(transition); return transition;
}
function runTo(f: Fixture, transitions: Transition[], predicate: (transition: Transition) => boolean, limit = 800) {
  for (let frame = 0; frame < limit; frame++) { const transition = advance(f, transitions); if (transition && predicate(transition)) return transition; }
  throw new Error('MAHJONG_CLAIMS_ENGINE_STALL ' + JSON.stringify({ state: game(f), events: transitions.map(item => item.event), dataset: { ...f.host.dataset } }));
}
function legalFixture(preset: HomeMahjongGamePreset) {
  const counts = new Map<string, number>(); for (const tile of [...preset.hands.flat(), ...preset.wall]) counts.set(tile, (counts.get(tile) ?? 0) + 1);
  expect(preset.hands.map(hand => hand.length)).toEqual([13, 13, 13, 13]); expect(preset.wall).toHaveLength(84); expect(counts.size).toBe(34); expect([...counts.values()]).toEqual(Array<number>(34).fill(4));
}
function record(name: string, transitions: Transition[]) { console.info('MAHJONG_CLAIMS_' + name + ' ' + JSON.stringify(transitions.map(item => ({ event: item.event, phase: item.after.phase, wall: item.after.wallRemaining })))); }

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

describe('actual local four-person chow, added kong and robbed kong table engine', () => {
  it('claims only the next seat sequence with matching actual meld faces, one local chow clip and no replay after pause or hiding', async () => {
    legalFixture(presets.chow); const group = snapshot(), original = JSON.stringify(group), f = setup(group, { localMahjongPreset: presets.chow }), transitions: Transition[] = [];
    expect(await f.world.setLifeAudio(true)).toBe(true); f.world.setMotion(true);
    const { before, after, event } = runTo(f, transitions, item => item.event.kind === 'chow');
    expect(event).toMatchObject({ actorId: 5, fromActorId: 4, tile: '五万', text: '吃' }); expect(after.turnActorId).toBe(5); expect(after.phase).toBe('hold');
    const previousClaimant = before.players.find(player => player.actorId === 5)!, claimant = after.players.find(player => player.actorId === 5)!;
    expect(claimant.melds).toEqual([{ kind: 'chow', tiles: ['四万', '五万', '六万'] }]); expect(claimant.hand.length).toBe(previousClaimant.hand.length - 2); expect(after.wallRemaining).toBe(before.wallRemaining);
    expect(after.players.find(player => player.actorId === 4)!.discards.length).toBe(before.players.find(player => player.actorId === 4)!.discards.length - 1); expect(claimant.discards).toEqual(previousClaimant.discards);
    const root = actor(f, 5), left = root.getObjectByName('left-arm')!, right = root.getObjectByName('right-arm')!, leftPalm = left.localToWorld(new THREE.Vector3(-.075, -.265, .045)), rightPalm = right.localToWorld(new THREE.Vector3(.075, -.265, .045));
    for (let frame = 0; frame < 40 && game(f).phaseProgress < .4; frame++) advance(f, transitions);
    expect(game(f).lastEvent?.id).toBe(event.id); expect(game(f).phase).toBe('hold'); expect(game(f).phaseProgress).toBeGreaterThanOrEqual(.4); expect(game(f).phaseProgress).toBeLessThan(.7);
    expect(left.rotation.x).toBeLessThan(-.6); expect(right.rotation.x).toBeLessThan(-.7); expect(left.localToWorld(new THREE.Vector3(-.075, -.265, .045)).distanceTo(leftPalm)).toBeGreaterThan(.01); expect(right.localToWorld(new THREE.Vector3(.075, -.265, .045)).distanceTo(rightPalm)).toBeGreaterThan(.01);
    expect(held(f)).toHaveLength(0); expect(f.renderer.scene!.getObjectByName('home-mahjong-game-view')!.userData.snapshot.proxyExcludedCount).toBe(0);
    const frozen = JSON.stringify(game(f)), tokenStates = tokens(f).map(token => ({ token, transform: exact(token), world: token.matrixWorld.toArray() })), plays = playCount();
    f.world.setMotion(false); expect(players.every(player => player.paused)).toBe(true); vi.setSystemTime(Date.now() + 60_000); f.world.update(group, null, 'outdoor'); expect(JSON.stringify(game(f))).toBe(frozen);
    for (const state of tokenStates) { expect(exact(state.token)).toEqual(state.transform); expect(state.token.matrixWorld.toArray()).toEqual(state.world); }
    f.world.setMotion(true); expect(JSON.stringify(game(f))).toBe(frozen); setHidden(true); for (let frame = 0; frame < 5; frame++) step(f, 1000); expect(JSON.stringify(game(f))).toBe(frozen); setHidden(false); step(f); expect(JSON.stringify(game(f))).toBe(frozen); expect(playCount()).toBe(plays);
    const next = runTo(f, transitions, item => item.event.kind === 'discard'); expect(next.event.actorId).toBe(5); expect(next.after.wallRemaining).toBe(after.wallRemaining); expect(playCount()).toBe(plays + 1); expect(players.flatMap(player => player.played).filter(src => src === clipMap['吃'])).toHaveLength(1);
    expect(JSON.stringify(group)).toBe(original); record('CHOW', transitions);
  }, 20_000);

  it('forms a real pung before adding the fourth tile, preserves 136 actual tiles and silently draws the replacement from the wall tail', async () => {
    legalFixture(presets.addedKong); const group = snapshot(), original = JSON.stringify(group), f = setup(group, { localMahjongPreset: presets.addedKong }), transitions: Transition[] = [];
    expect(await f.world.setLifeAudio(true)).toBe(true); f.world.setMotion(true);
    const kong = runTo(f, transitions, item => item.event.kind === 'kong' && item.before.players.find(player => player.actorId === item.event.actorId)!.melds.some(meld => meld.kind === 'pung' && meld.tiles[0] === item.event.tile));
    expect(kong.event).toMatchObject({ actorId: 5, tile: '五万', text: '杠' }); expect(kong.event.fromActorId).toBeUndefined();
    const pung = transitions.find(item => item.event.kind === 'pung' && item.event.actorId === 5 && item.event.tile === '五万'); expect(pung).toBeDefined(); expect(pung!.event.fromActorId).toBe(4); expect(pung!.event.id).toBeLessThan(kong.event.id);
    const previous = kong.before.players.find(player => player.actorId === 5)!, current = kong.after.players.find(player => player.actorId === 5)!;
    expect(previous.melds).toEqual([{ kind: 'pung', tiles: ['五万', '五万', '五万'] }]); expect(current.melds).toEqual([{ kind: 'kong', tiles: ['五万', '五万', '五万', '五万'] }]); expect(current.hand.length).toBe(previous.hand.length - 1); expect(kong.after.wallRemaining).toBe(kong.before.wallRemaining); expect(kong.after.phase).toBe('draw');
    const plays = playCount(), replacement = runTo(f, transitions, item => item.event.kind === 'draw' && item.event.afterKong === true);
    expect(replacement.event).toMatchObject({ actorId: 5, tile: '八筒', afterKong: true }); expect(replacement.event.tile).toBe(presets.addedKong.wall.at(-1)); expect(replacement.after.wallRemaining).toBe(kong.after.wallRemaining - 1); expect(playCount()).toBe(plays);
    const win = runTo(f, transitions, item => item.event.kind === 'win'); expect(win.event).toMatchObject({ actorId: 5, tile: '八筒', text: '杠上花', afterKong: true }); const winner = win.after.players.find(player => player.actorId === 5)!; expect(isHomeMahjongWinningHand(winner.hand, winner.melds.length)).toBe(true); expect(JSON.stringify(group)).toBe(original); record('ADDED_KONG', transitions);
  }, 20_000);

  it('atomically awards a real robbed-kong win while retaining the old pung, leaving the wall untouched and never announcing a rejected kong', async () => {
    legalFixture(presets.robKong); const group = snapshot(), original = JSON.stringify(group), f = setup(group, { localMahjongPreset: presets.robKong }), transitions: Transition[] = [];
    expect(await f.world.setLifeAudio(true)).toBe(true); f.world.setMotion(true);
    const win = runTo(f, transitions, item => item.event.kind === 'win' && item.event.text === '抢杠胡');
    expect(win.event).toMatchObject({ actorId: 6, fromActorId: 5, tile: '五万', text: '抢杠胡', robbedKong: true }); expect(win.after.status).toBe('won'); expect(win.after.phase).toBe('ended'); expect(win.after.wallRemaining).toBe(win.before.wallRemaining);
    const pung = transitions.find(item => item.event.kind === 'pung' && item.event.actorId === 5 && item.event.tile === '五万'); expect(pung).toBeDefined(); expect(pung!.event.id).toBeLessThan(win.event.id);
    const priorLoser = win.before.players.find(player => player.actorId === 5)!, loser = win.after.players.find(player => player.actorId === 5)!, priorWinner = win.before.players.find(player => player.actorId === 6)!, winner = win.after.players.find(player => player.actorId === 6)!;
    expect(loser.melds).toEqual([{ kind: 'pung', tiles: ['五万', '五万', '五万'] }]); expect(loser.melds).toEqual(priorLoser.melds); expect(loser.hand.length).toBe(priorLoser.hand.length - 1); expect(winner.hand.length).toBe(priorWinner.hand.length + 1); expect(isHomeMahjongWinningHand(winner.hand, winner.melds.length)).toBe(true);
    expect(transitions.some(item => item.event.kind === 'kong' && item.event.actorId === 5 && item.event.tile === '五万')).toBe(false); expect(transitions.some(item => item.event.kind === 'draw' && item.event.afterKong)).toBe(false);
    const plays = playCount(), frozen = JSON.stringify(win.after); for (let frame = 0; frame < 20; frame++) advance(f, transitions); expect(JSON.stringify(game(f))).toBe(frozen); expect(playCount()).toBe(plays); expect(f.host.dataset.mahjongGameText).toBe('抢杠胡'); expect(JSON.stringify(group)).toBe(original); record('ROB_KONG', transitions);
  }, 20_000);
});
