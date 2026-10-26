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
Object.assign(clipMap, { 吃: '/local-voices/mahjong-chow.wav', 碰: '/local-voices/mahjong-pung.wav', 杠: '/local-voices/mahjong-kong.wav', 胡: '/local-voices/mahjong-hu.wav', 自摸: '/local-voices/mahjong-self-draw.wav', 杠上花: '/local-voices/mahjong-kong-draw-win.wav', 抢杠胡: '/local-voices/mahjong-rob-kong-win.wav', 流局: '/local-voices/mahjong-exhausted.wav' });
function snapshot(): Gathering {
  return parseGathering({ id: 'synthetic-sichuan-engine', title: '本地吃碰补杠真实规则', scene_type: 'home', revision: 1, closed: false, is_manager: true, me: 'owner', members: [{ id: 'owner', name: '合成主人', manager: true }],
    companions: [4, 5, 6, 7].map((id, index) => ({ id, owner_id: 'owner', name: '合成牌友' + id, activity: 'observe', area: 'outdoor', x: .25 + index * .15, y: .6,
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: id, source: 'procedural_existing_features' } })),
    items: [{ id: 'saved-tree', kind: 'tree', x: .15, y: .22, mine: true, contributor_name: '合成', growth_status: null }, { id: 'saved-bench', kind: 'bench', x: .75, y: .65, mine: true, contributor_name: '合成', growth_status: null }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
type Flags = NonNullable<Parameters<typeof createLivingWorld>[5]>;
function setup(group = snapshot(), flags: Flags = {}) {
  const host = document.createElement('div'), labels = document.createElement('div'); Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } }); document.body.append(host, labels);
  const options: Flags = { realistic: true, localLeisurePreview: true, localRoomTransitions: true, localCompanionDoors: true, localReferenceVilla: true, localQuietAudio: true,
    localMahjongGame: true, localMahjongRules: 'sichuan', localSpeechClips: clipMap, initialLeisure: [{ activity: 'mahjong', actorIds: [4, 5, 6, 7] }], ...flags };
  const world = createLivingWorld(host, labels, group, vi.fn(), vi.fn(), options); worlds.push(world);
  return { world, host, labels, renderer: gpu.instances.at(-1)!, group };
}
type Fixture = ReturnType<typeof setup>;
function step(f: Fixture, delta = 100) { vi.setSystemTime(Date.now() + delta); players.forEach(player => player.flush()); expect(f.renderer.loop).toBeTypeOf('function'); f.renderer.loop!(Date.now()); }
function actor(f: Fixture, id: number) { const root = f.renderer.scene!.children.find(object => object.userData.characterId === id); expect(root).toBeDefined(); return root!; }
function ancestorActor(object: THREE.Object3D) { for (let current: THREE.Object3D | null = object; current; current = current.parent) if (typeof current.userData.characterId === 'number') return current.userData.characterId as number; return null; }
function visibleCaption(f: Fixture, text: string) { return Array.from(f.labels.querySelectorAll<HTMLElement>('.living3d-bubble')).some(node => !node.hidden && node.textContent === text); }
function setHidden(value: boolean) { hidden = value; document.dispatchEvent(new Event('visibilitychange')); }
function game(f: Fixture): HomeMahjongGameSnapshot { const state = f.world.getLocalMahjong(); expect(state.rules).toBe('sichuan'); expect(state.totalTiles).toBe(108); return state; }
function tokens(f: Fixture) { const result: THREE.Object3D[] = []; f.renderer.scene!.traverse(object => { if (object.userData.homeMahjongTile === true) result.push(object); }); return result; }
function held(f: Fixture) { return tokens(f).filter(tile => tile.visible && ancestorActor(tile) !== null); }
function exact(object: THREE.Object3D) { return { parent: object.parent, position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray(), matrix: object.matrix.toArray(), auto: object.matrixAutoUpdate }; }
function playCount() { return players.reduce((total, player) => total + player.play.mock.calls.length, 0); }
function tileFor(f: Fixture, event: HomeMahjongGameEvent) { const player = game(f).players.find(player => player.actorId === event.actorId)!; return f.renderer.scene!.getObjectByName('home-mahjong-tile-' + player.seatId.split('-').at(-1))!; }
function conservation(state: HomeMahjongGameSnapshot) { return state.wallRemaining + state.players.reduce((total, player) => total + player.hand.length + player.discards.length + player.melds.reduce((sum, meld) => sum + meld.tiles.length, 0), 0); }
const exchangePreset: HomeMahjongGamePreset = {
  "hands": [
    [
      "一万",
      "二万",
      "三万",
      "一筒",
      "二筒",
      "三筒",
      "四筒",
      "五筒",
      "一条",
      "二条",
      "三条",
      "四条",
      "五条",
      "六条"
    ],
    [
      "四万",
      "五万",
      "六万",
      "七万",
      "八万",
      "六筒",
      "七筒",
      "八筒",
      "一条",
      "二条",
      "三条",
      "四条",
      "五条"
    ],
    [
      "一万",
      "二万",
      "三万",
      "四万",
      "五万",
      "一筒",
      "二筒",
      "三筒",
      "四筒",
      "五筒",
      "七条",
      "八条",
      "九条"
    ],
    [
      "六万",
      "七万",
      "八万",
      "一筒",
      "二筒",
      "三筒",
      "四筒",
      "五筒",
      "一条",
      "二条",
      "三条",
      "四条",
      "五条"
    ]
  ],
  "wall": [
    "九万",
    "一万",
    "一万",
    "二万",
    "二万",
    "三万",
    "三万",
    "四万",
    "四万",
    "五万",
    "五万",
    "六万",
    "六万",
    "七万",
    "七万",
    "八万",
    "八万",
    "九万",
    "九万",
    "九万",
    "一筒",
    "二筒",
    "三筒",
    "四筒",
    "五筒",
    "六筒",
    "六筒",
    "六筒",
    "七筒",
    "七筒",
    "七筒",
    "八筒",
    "八筒",
    "八筒",
    "九筒",
    "九筒",
    "九筒",
    "九筒",
    "一条",
    "二条",
    "三条",
    "四条",
    "五条",
    "六条",
    "六条",
    "六条",
    "七条",
    "七条",
    "七条",
    "八条",
    "八条",
    "八条",
    "九条",
    "九条",
    "九条"
  ],
  "turn": 0,
  "exchangeDirection": 1
};
const expectedOutgoing = [{"actorId":1,"tiles":["一万","二万","三万"],"toActorId":2},{"actorId":2,"tiles":["六筒","七筒","八筒"],"toActorId":3},{"actorId":3,"tiles":["七条","八条","九条"],"toActorId":4},{"actorId":4,"tiles":["六万","七万","八万"],"toActorId":1}];
const expectedMissing = ["万","筒","条","万"];
function assertFace(f: Fixture, event: HomeMahjongGameEvent) {
  expect(event.tile).not.toBeNull(); const tile = tileFor(f, event); expect(tile).toBeDefined(); expect(tile.userData.mahjongFace).toBe(event.tile);
  const overlay = tile.getObjectByName('home-mahjong-face-overlay') as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>; expect(overlay).toBeDefined(); expect(overlay.parent).toBe(tile); expect(overlay.userData.mahjongFace).toBe(event.tile); expect(overlay.material.map).toBeInstanceOf(THREE.CanvasTexture);
  const state = game(f); if (event.kind === 'draw' || state.phase === 'discard' && state.phaseProgress < .6) { expect(overlay.visible).toBe(false); expect(effectivelyVisible(overlay)).toBe(false); expect(tile.userData.mahjongFaceExposed).toBe(false); }
  return tile;
}

const continuingCase: { preset: HomeMahjongGamePreset; randomStateAfterDeal: number; firstWin: ExpectedEvent; expectedDraws: ExpectedEvent[] } = {
  "preset": {
    "hands": [
      [
        "一万",
        "三万",
        "三万",
        "五万",
        "六万",
        "二筒",
        "四筒",
        "一条",
        "三条",
        "四条",
        "六条",
        "六条",
        "七条",
        "九条"
      ],
      [
        "二万",
        "六万",
        "七万",
        "九万",
        "一筒",
        "二筒",
        "三筒",
        "三筒",
        "五筒",
        "七筒",
        "九筒",
        "五条",
        "八条"
      ],
      [
        "二万",
        "四万",
        "四万",
        "五万",
        "八万",
        "一筒",
        "五筒",
        "八筒",
        "九筒",
        "九筒",
        "二条",
        "二条",
        "六条"
      ],
      [
        "一万",
        "一万",
        "五万",
        "九万",
        "四筒",
        "五筒",
        "六筒",
        "二条",
        "三条",
        "四条",
        "四条",
        "八条",
        "九条"
      ]
    ],
    "wall": [
      "三筒",
      "四万",
      "九条",
      "七条",
      "四条",
      "四筒",
      "九万",
      "七筒",
      "三条",
      "八筒",
      "二筒",
      "七条",
      "三条",
      "八筒",
      "八筒",
      "四筒",
      "五条",
      "九筒",
      "九万",
      "七条",
      "八万",
      "一条",
      "九条",
      "四万",
      "一条",
      "六筒",
      "六万",
      "八万",
      "五条",
      "六筒",
      "三万",
      "七万",
      "二万",
      "三万",
      "五万",
      "三筒",
      "七筒",
      "八万",
      "六条",
      "五条",
      "六万",
      "八条",
      "八条",
      "二筒",
      "七万",
      "七筒",
      "一万",
      "六筒",
      "二条",
      "一筒",
      "二万",
      "一条",
      "五筒",
      "一筒",
      "七万"
    ],
    "turn": 0,
    "exchangeDirection": 1
  },
  "randomStateAfterDeal": 923276397,
  "firstWin": {
    "id": 46,
    "kind": "win",
    "actorId": 1,
    "tile": "六条",
    "text": "胡",
    "fromActorId": 4
  },
  "expectedDraws": [
    {
      "id": 47,
      "kind": "draw",
      "actorId": 2,
      "tile": "五条",
      "text": "五条"
    },
    {
      "id": 49,
      "kind": "draw",
      "actorId": 3,
      "tile": "九筒",
      "text": "九筒"
    },
    {
      "id": 51,
      "kind": "draw",
      "actorId": 4,
      "tile": "九万",
      "text": "九万"
    },
    {
      "id": 53,
      "kind": "draw",
      "actorId": 2,
      "tile": "七条",
      "text": "七条"
    }
  ]
};
const multiCase: { preset: HomeMahjongGamePreset; randomStateAfterDeal: number; expectedWins: ExpectedEvent[]; finalWall: number; finalWinnerIds: number[] } = {
  "preset": {
    "hands": [
      [
        "一万",
        "三万",
        "四万",
        "五万",
        "九万",
        "三筒",
        "七筒",
        "九筒",
        "二条",
        "二条",
        "五条",
        "六条",
        "八条",
        "九条"
      ],
      [
        "一万",
        "六万",
        "六万",
        "三筒",
        "六筒",
        "七筒",
        "七筒",
        "八筒",
        "八筒",
        "二条",
        "五条",
        "六条",
        "九条"
      ],
      [
        "二万",
        "八万",
        "二筒",
        "五筒",
        "六筒",
        "六筒",
        "八筒",
        "二条",
        "三条",
        "四条",
        "七条",
        "八条",
        "九条"
      ],
      [
        "二万",
        "二万",
        "三万",
        "四万",
        "五万",
        "六万",
        "六万",
        "七万",
        "四筒",
        "八筒",
        "九筒",
        "三条",
        "四条"
      ]
    ],
    "wall": [
      "一条",
      "一条",
      "三条",
      "七条",
      "七万",
      "九万",
      "四筒",
      "九条",
      "三万",
      "一万",
      "一条",
      "七条",
      "九万",
      "五万",
      "九筒",
      "一筒",
      "四万",
      "一筒",
      "九筒",
      "三条",
      "五条",
      "五筒",
      "三万",
      "六条",
      "一筒",
      "六筒",
      "八万",
      "四条",
      "二筒",
      "七条",
      "五筒",
      "四筒",
      "四万",
      "八条",
      "七筒",
      "三筒",
      "一万",
      "二万",
      "二筒",
      "五筒",
      "三筒",
      "八万",
      "五条",
      "五万",
      "二筒",
      "七万",
      "四筒",
      "六条",
      "九万",
      "一筒",
      "一条",
      "八条",
      "七万",
      "四条",
      "八万"
    ],
    "turn": 0,
    "exchangeDirection": 2
  },
  "randomStateAfterDeal": 1724627824,
  "expectedWins": [
    {
      "id": 58,
      "kind": "win",
      "actorId": 1,
      "tile": "四条",
      "text": "胡",
      "fromActorId": 4
    },
    {
      "id": 59,
      "kind": "win",
      "actorId": 3,
      "tile": "四条",
      "text": "胡",
      "fromActorId": 4
    }
  ],
  "finalWall": 12,
  "finalWinnerIds": [
    1,
    2,
    3
  ]
};
type PresentedTile = { actorId: number; role: 'hand' | 'meld' | 'discard'; text: string | null; standing: boolean; faceVisible: boolean; hidden: 'hand' | 'meld' | null; height: number };
function effectivelyVisible(object: THREE.Object3D) { for (let current: THREE.Object3D | null = object; current; current = current.parent) if (!current.visible) return false; return true; }
function assertPrivateTable(f: Fixture, state: HomeMahjongGameSnapshot) {
  expect(conservation(state)).toBe(108);
  const view = f.renderer.scene!.getObjectByName('home-mahjong-game-view'); expect(view).toBeDefined();
  const rendered = view!.userData.snapshot, displayed = rendered.tiles as PresentedTile[], proxies = held(f);
  expect(rendered.logicalTileCount).toBe(108); expect(rendered.wallRemaining).toBe(state.wallRemaining); expect(rendered.phase).toBe(state.phase); expect(rendered.turnActorId).toBe(state.turnActorId);
  expect(displayed).toHaveLength(rendered.renderedTileCount); expect(rendered.renderedTileCount).toBe(rendered.faceCount + rendered.hiddenHandCount + rendered.hiddenMeldCount);
  expect(rendered.renderedTileCount + proxies.length + state.wallRemaining).toBe(108); expect(proxies.length).toBe(rendered.proxyExcludedCount);
  expect(displayed.filter(tile => tile.faceVisible)).toHaveLength(rendered.faceCount); expect(displayed.filter(tile => tile.hidden === 'hand')).toHaveLength(rendered.hiddenHandCount); expect(displayed.filter(tile => tile.hidden === 'meld')).toHaveLength(rendered.hiddenMeldCount);
  expect(displayed.filter(tile => tile.standing)).toHaveLength(rendered.standingCount); expect(displayed.filter(tile => tile.hidden === 'hand' && !tile.standing)).toHaveLength(rendered.faceDownHandCount); expect(rendered.hiddenHandCount).toBe(rendered.standingCount + rendered.faceDownHandCount); expect(rendered.standingCount).toBe(displayed.filter(tile => tile.hidden === 'hand' && !state.players.find(player => player.actorId === tile.actorId)!.won).length);
  for (const tile of displayed) { if (tile.hidden) { expect(tile.text).toBeNull(); expect(tile.faceVisible).toBe(false); } else { expect(HOME_MAHJONG_CALL_TEXTS).toContain(tile.text); expect(tile.faceVisible).toBe(true); } expect(tile.standing).toBe(tile.hidden === 'hand' && !state.players.find(player => player.actorId === tile.actorId)!.won); }
  const terminal = state.status === 'won' || state.status === 'exhausted';
  for (const player of state.players) {
    const hand = displayed.filter(tile => tile.actorId === player.actorId && tile.role === 'hand'), excluded = state.phase === 'hold' && state.lastEvent?.kind === 'draw' && state.lastEvent.actorId === player.actorId ? 1 : 0;
    expect(hand).toHaveLength(player.hand.length - excluded);
    if (terminal) { expect(hand.map(tile => tile.text)).toEqual(player.hand); expect(hand.every(tile => tile.faceVisible && !tile.standing && tile.hidden === null)).toBe(true); }
    else expect(hand.every(tile => tile.text === null && !tile.faceVisible && tile.standing === !player.won && tile.hidden === 'hand')).toBe(true);
    const meld = displayed.filter(tile => tile.actorId === player.actorId && tile.role === 'meld');
    expect(meld.map(tile => ({ text: tile.text, hidden: tile.hidden, faceVisible: tile.faceVisible }))).toEqual(player.melds.flatMap(group => group.tiles.map(text => ({ text: group.concealed && !terminal ? null : text, hidden: group.concealed && !terminal ? 'meld' : null, faceVisible: !(group.concealed && !terminal) }))));
    const pending = state.phase === 'discard' && state.phaseProgress < .6 && state.lastEvent?.kind === 'discard' && state.lastEvent.actorId === player.actorId;
    expect(displayed.filter(tile => tile.actorId === player.actorId && tile.role === 'discard').map(tile => tile.text)).toEqual(pending ? player.discards.slice(0, -1) : player.discards);
  }
  const faces = view!.getObjectByName('home-mahjong-game-tile-faces') as THREE.Mesh<THREE.BufferGeometry>, bodies = view!.getObjectByName('home-mahjong-game-tile-bodies') as THREE.Mesh<THREE.BufferGeometry>;
  expect(faces.geometry.getAttribute('position').count).toBe(rendered.faceCount * 4); expect(faces.geometry.index?.count ?? 0).toBe(rendered.faceCount * 6);
  const points = bodies.geometry.getAttribute('position'); expect(points.count).toBe((rendered.renderedTileCount + Number(state.wallRemaining > 0)) * 24); expect(bodies.geometry.index?.count ?? 0).toBe((rendered.renderedTileCount + Number(state.wallRemaining > 0)) * 36);
  const standingIndex = displayed.findIndex(tile => tile.standing);
  if (standingIndex >= 0) { const box = new THREE.Box3(); for (let index = standingIndex * 24; index < (standingIndex + 1) * 24; index++) box.expandByPoint(new THREE.Vector3().fromBufferAttribute(points, index)); const size = box.getSize(new THREE.Vector3()); expect(size.y).toBeCloseTo(displayed[standingIndex].height, 5); expect(size.y).toBeGreaterThan(Math.min(size.x, size.z) * 1.5); }
  const retiredIndex = displayed.findIndex(tile => tile.hidden === 'hand' && !tile.standing); if (retiredIndex >= 0) { const box = new THREE.Box3(); for (let index = retiredIndex * 24; index < (retiredIndex + 1) * 24; index++) box.expandByPoint(new THREE.Vector3().fromBufferAttribute(points, index)); const size = box.getSize(new THREE.Vector3()); expect(size.y).toBeCloseTo(.022, 5); expect(size.y).toBeLessThan(Math.min(size.x, size.z)); }
  for (const proxy of proxies) { const overlay = proxy.getObjectByName('home-mahjong-face-overlay')!; expect(overlay).toBeDefined(); expect(overlay.visible).toBe(false); expect(effectivelyVisible(overlay)).toBe(false); expect(proxy.userData.mahjongFaceExposed).toBe(false); }
  if (state.status === 'won') for (const proxy of tokens(f)) { expect(ancestorActor(proxy)).toBeNull(); expect(proxy.visible).toBe(false); expect(proxy.userData.mahjongFaceExposed).toBe(true); const overlay = proxy.getObjectByName('home-mahjong-face-overlay'); if (overlay) expect(overlay.visible).toBe(true); }
}

type Transition = { before: HomeMahjongGameSnapshot; after: HomeMahjongGameSnapshot; event: HomeMahjongGameEvent };
const numberedTile = /^[一二三四五六七八九][万筒条]$/;
function assertReal108(f: Fixture, state: HomeMahjongGameSnapshot) {
  assertPrivateTable(f, state); expect(state.players).toHaveLength(4); expect([1, 2, 3]).toContain(state.exchangeDirection);
  const view = f.renderer.scene!.getObjectByName('home-mahjong-game-view')!; expect(view.userData.snapshot.rules).toBe('sichuan'); expect(view.userData.snapshot.totalTiles).toBe(108); expect(view.userData.snapshot.wonActorIds).toEqual(state.players.filter(player => player.won).map(player => player.actorId));
  for (const player of state.players) {
    const root = actor(f, player.actorId); expect(root.visible).toBe(true); expect(root.userData.roomRestSeat?.seatId).toBe(player.seatId); expect(root.userData.homeJourney?.active).not.toBe(true);
    for (const text of [...player.hand, ...player.discards, ...player.melds.flatMap(meld => [...meld.tiles])]) expect(numberedTile.test(text)).toBe(true);
    expect(player.melds.some(meld => meld.kind === 'chow')).toBe(false);
    if (player.won) { expect(player.hand.some(text => text.endsWith(player.missingSuit!))).toBe(false); const candidate = player.hand.length % 3 === 1 && player.winningTile ? [...player.hand, player.winningTile] : player.hand; expect(isHomeMahjongWinningHand(candidate, player.melds.length)).toBe(true); }
  }
  if (['draw', 'hold', 'discard', 'claim'].includes(state.phase)) expect(state.players.find(player => player.actorId === state.turnActorId)?.won).toBe(false);
  expect(held(f).length).toBeLessThanOrEqual(1); if (held(f)[0]) expect(ancestorActor(held(f)[0])).toBe(state.turnActorId);
  const ledger = new Map(state.players.map(player => [player.actorId, 0]));
  for (const transfer of state.scoreTransfers ?? []) { expect(Number.isInteger(transfer.points)).toBe(true); expect(transfer.points).toBeGreaterThan(0); expect(ledger.has(transfer.fromActorId)).toBe(true); expect(ledger.has(transfer.toActorId)).toBe(true); ledger.set(transfer.fromActorId, ledger.get(transfer.fromActorId)! - transfer.points); ledger.set(transfer.toActorId, ledger.get(transfer.toActorId)! + transfer.points); }
  expect(state.players.reduce((sum, player) => sum + (player.score ?? 0), 0)).toBe(0); for (const player of state.players) expect(player.score).toBe(ledger.get(player.actorId));
}
function advance(f: Fixture, transitions: Transition[]) {
  const before = game(f), priorPlays = playCount(); step(f); const after = game(f); assertReal108(f, after); const event = after.lastEvent;
  if (!event || event.id === before.lastEvent?.id) { expect(playCount()).toBe(priorPlays); return null; }
  expect(event.kind).not.toBe('chow'); if (event.tile) expect(numberedTile.test(event.tile)).toBe(true);
  if (event.tile) assertFace(f, event); expect(f.host.dataset.mahjongGameText).toBe(event.kind === 'draw' ? '摸牌' : event.text);
  if (event.kind === 'draw') expect(playCount()).toBe(priorPlays);
  else { expect(playCount()).toBe(priorPlays + 1); expect(players.some(player => !player.paused && player.src === clipMap[event.text])).toBe(true); expect(visibleCaption(f, event.text)).toBe(true); }
  if (event.kind === 'discard') { const player = before.players.find(player => player.actorId === event.actorId)!; expect(player.won).toBe(false); if (player.hand.some(text => text.endsWith(player.missingSuit!))) expect(event.tile!.endsWith(player.missingSuit!)).toBe(true); }
  if (event.kind === 'pung' || event.kind === 'kong') { const player = after.players.find(player => player.actorId === event.actorId)!; expect(event.tile!.endsWith(player.missingSuit!)).toBe(false); }
  const transition = { before, after, event }; transitions.push(transition); return transition;
}
function runToState(f: Fixture, transitions: Transition[], predicate: (state: HomeMahjongGameSnapshot) => boolean, limit = 1000) {
  for (let frame = 0; frame < limit; frame++) { advance(f, transitions); if (predicate(game(f))) return game(f); }
  throw new Error('SICHUAN_ENGINE_STALL ' + JSON.stringify({ state: game(f), events: transitions.map(item => item.event), dataset: { ...f.host.dataset } }));
}
function runToEvent(f: Fixture, transitions: Transition[], predicate: (transition: Transition) => boolean, limit = 1000) {
  for (let frame = 0; frame < limit; frame++) { const item = advance(f, transitions); if (item && predicate(item)) return item; }
  throw new Error('SICHUAN_ENGINE_EVENT_STALL ' + JSON.stringify({ state: game(f), events: transitions.map(item => item.event) }));
}
function subtract(hand: readonly string[], tiles: readonly string[]) { const result = [...hand]; for (const tile of tiles) { const at = result.indexOf(tile); expect(at).toBeGreaterThanOrEqual(0); result.splice(at, 1); } return result; }
function legal108(preset: HomeMahjongGamePreset) { const counts = new Map<string, number>(); for (const tile of [...preset.hands.flat(), ...preset.wall]) { expect(numberedTile.test(tile)).toBe(true); counts.set(tile, (counts.get(tile) ?? 0) + 1); } expect(preset.hands.map(hand => hand.length)).toEqual([14, 13, 13, 13]); expect(preset.wall).toHaveLength(55); expect(counts.size).toBe(27); expect([...counts.values()]).toEqual(Array<number>(27).fill(4)); }
function record(name: string, transitions: Transition[]) { console.info('SICHUAN_ENGINE_' + name + ' ' + JSON.stringify(transitions.map(item => ({ event: item.event, phase: item.after.phase, wall: item.after.wallRemaining, winners: item.after.players.filter(player => player.won).map(player => player.actorId) })))); }


type ExpectedEvent = { id: number; kind: string; actorId: number; tile: string | null; text: string; fromActorId?: number; afterKong?: boolean; robbedKong?: boolean };
function remapEvent(event: ExpectedEvent) { return { ...event, actorId: event.actorId + 3, ...(event.fromActorId === undefined ? {} : { fromActorId: event.fromActorId + 3 }) }; }
function replayRandom(savedState: number) { let state = savedState >>> 0; return vi.fn(() => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; }); }

describe('actual explicit 108-tile Sichuan blood-battle table engine', () => {
  it('really exchanges three same-suit tiles, declares the missing suit and discards it first without exposing private hands or admitting honors/chow', async () => {
    legal108(exchangePreset); const group = snapshot(), original = JSON.stringify(group), f = setup(group, { localMahjongPreset: exchangePreset }), transitions: Transition[] = []; expect(game(f)).toMatchObject({ status: 'waiting', phase: 'ended', players: [] }); f.world.setMotion(true); const initial = game(f);
    expect(initial.phase).toBe('exchange'); expect(initial.players.map(player => player.hand.length)).toEqual([14, 13, 13, 13]); expect(initial.wallRemaining).toBe(55); expect(initial.players.every(player => player.missingSuit === null)).toBe(true); expect(Audio).not.toHaveBeenCalled(); expect(playCount()).toBe(0); assertReal108(f, initial);
    expect(await f.world.setLifeAudio(true)).toBe(true); f.world.setMotion(true);
    const exchanged = runToState(f, transitions, state => state.phase === 'dingque'); expect(exchanged.exchangeDirection).toBe(1); expect(exchanged.wallRemaining).toBe(55); expect(transitions).toHaveLength(0);
    for (const outgoing of expectedOutgoing) { expect(outgoing.tiles).toHaveLength(3); expect(new Set(outgoing.tiles.map(tile => tile.at(-1))).size).toBe(1); const giver = initial.players.find(player => player.actorId === outgoing.actorId + 3)!, recipient = initial.players.find(player => player.actorId === outgoing.toActorId + 3)!; const recipientOut = expectedOutgoing.find(item => item.actorId === outgoing.toActorId)!; const expected = [...subtract(recipient.hand, recipientOut.tiles), ...outgoing.tiles].sort(); expect(exchanged.players.find(player => player.actorId === recipient.actorId)!.hand.slice().sort()).toEqual(expected); expect(subtract(giver.hand, outgoing.tiles)).toHaveLength(giver.hand.length - 3); }
    const declared = runToState(f, transitions, state => state.phase === 'hold'); expect(declared.players.map(player => player.missingSuit)).toEqual(expectedMissing); expect(declared.players[0].hand.filter(tile => tile.endsWith('万'))).toHaveLength(3); expect(transitions).toHaveLength(0);
    const discard = runToEvent(f, transitions, item => item.event.kind === 'discard'); expect(discard.event.actorId).toBe(4); expect(discard.event.tile!.endsWith('万')).toBe(true);
    const publicState = runToState(f, transitions, state => state.phase === 'discard' && state.phaseProgress >= .6), proxy = tileFor(f, discard.event), overlay = proxy.getObjectByName('home-mahjong-face-overlay')!; expect(proxy.visible).toBe(false); expect(ancestorActor(proxy)).toBeNull(); expect(proxy.userData.mahjongFaceExposed).toBe(true); expect(overlay.visible).toBe(true); expect(effectivelyVisible(overlay)).toBe(false); expect(publicState.wallRemaining).toBe(55);
    const plays = playCount(), draw = runToEvent(f, transitions, item => item.event.kind === 'draw'); expect(draw.event).toMatchObject({ actorId: 5, tile: '九万' }); expect(draw.after.wallRemaining).toBe(54); expect(playCount()).toBe(plays); expect(f.host.dataset.mahjongGameText).toBe('摸牌'); expect(JSON.stringify(group)).toBe(original); record('EXCHANGE', transitions);
  }, 20_000);

  it('freezes a real hidden drawn tile through pause, hidden pages and a clock jump and only announces the next future discard once', async () => {
    legal108(exchangePreset); const f = setup(snapshot(), { localMahjongPreset: exchangePreset }), transitions: Transition[] = []; expect(await f.world.setLifeAudio(true)).toBe(true); f.world.setMotion(true); runToEvent(f, transitions, item => item.event.kind === 'draw');
    const frozen = JSON.stringify(game(f)), token = held(f)[0], transform = exact(token), matrix = token.matrixWorld.toArray(), plays = playCount(); expect(token).toBeDefined(); expect(token.userData.mahjongFaceExposed).toBe(false); f.world.setMotion(false); expect(players.every(player => player.paused)).toBe(true);
    vi.setSystemTime(Date.now() + 60_000); f.world.update(f.group, null, 'outdoor'); expect(JSON.stringify(game(f))).toBe(frozen); expect(exact(token)).toEqual(transform); expect(token.matrixWorld.toArray()).toEqual(matrix); f.world.setMotion(true); expect(JSON.stringify(game(f))).toBe(frozen);
    setHidden(true); for (let frame = 0; frame < 5; frame++) step(f, 1000); expect(JSON.stringify(game(f))).toBe(frozen); expect(playCount()).toBe(plays); setHidden(false); step(f); expect(JSON.stringify(game(f))).toBe(frozen); step(f, 3_600_000); expect(JSON.stringify(game(f))).toBe(frozen); expect(playCount()).toBe(plays);
    const future = runToEvent(f, transitions, item => item.event.kind === 'discard'); expect(future.event.actorId).toBe(5); expect(playCount()).toBe(plays + 1); record('PAUSE', transitions);
  }, 20_000);
  it('continues real draws after the first genuine win, skips the retired winner and keeps every hand private during blood battle', async () => {
    legal108(continuingCase.preset); const group = snapshot(), original = JSON.stringify(group), random = replayRandom(continuingCase.randomStateAfterDeal), f = setup(group, { localMahjongPreset: continuingCase.preset, localMahjongRandom: random }), transitions: Transition[] = [];
    expect(game(f)).toMatchObject({ status: 'waiting', phase: 'ended', players: [] }); expect(await f.world.setLifeAudio(true)).toBe(true); f.world.setMotion(true); expect(game(f).phase).toBe('exchange');
    const first = runToEvent(f, transitions, item => item.event.kind === 'win', 2500); expect(first.event).toMatchObject(remapEvent(continuingCase.firstWin)); expect(first.after.status).toBe('playing'); expect(first.after.phase).toBe('win');
    const winner = first.after.players.find(player => player.actorId === first.event.actorId)!; expect(winner.won).toBe(true); const frozenWinner = JSON.stringify(winner), root = actor(f, winner.actorId); expect(root.getObjectByName('left-arm')!.rotation.x).toBeLessThan(-.9); expect(root.getObjectByName('right-arm')!.rotation.x).toBeLessThan(-.9); expect(held(f)).toHaveLength(0);
    const draws: HomeMahjongGameEvent[] = []; while (draws.length < continuingCase.expectedDraws.length) { const next = runToEvent(f, transitions, item => item.event.kind === 'draw', 1000); draws.push(next.event); expect(next.event.actorId).not.toBe(winner.actorId); expect(next.after.players.find(player => player.actorId === next.event.actorId)!.won).toBe(false); expect(JSON.stringify(next.after.players.find(player => player.actorId === winner.actorId))).toBe(frozenWinner); }
    expect(draws).toMatchObject(continuingCase.expectedDraws.map(remapEvent)); expect(random).toHaveBeenCalled(); expect(JSON.stringify(group)).toBe(original); record('RETIRED_WINNER', transitions);
  }, 45_000);

  it('announces two real winners of one physical discard, continues to three winners and never starts a new deal or allocates duplicate tiles afterward', async () => {
    legal108(multiCase.preset); const group = snapshot(), original = JSON.stringify(group), random = replayRandom(multiCase.randomStateAfterDeal), f = setup(group, { localMahjongPreset: multiCase.preset, localMahjongRandom: random }), transitions: Transition[] = [];
    expect(game(f)).toMatchObject({ status: 'waiting', phase: 'ended', players: [] }); expect(await f.world.setLifeAudio(true)).toBe(true); f.world.setMotion(true); expect(game(f).phase).toBe('exchange');
    const first = runToEvent(f, transitions, item => item.event.kind === 'win', 3000), second = runToEvent(f, transitions, item => item.event.kind === 'win', 1000);
    expect(first.event).toMatchObject(remapEvent(multiCase.expectedWins[0])); expect(second.event).toMatchObject(remapEvent(multiCase.expectedWins[1])); expect(first.event.tile).toBe(second.event.tile); expect(first.event.fromActorId).toBe(second.event.fromActorId); expect(second.event.id).toBe(first.event.id + 1);
    expect(second.after.wallRemaining).toBe(first.before.wallRemaining); expect(first.after.wallRemaining).toBe(first.before.wallRemaining); expect(second.after.status).toBe('playing');
    const winningActors = [first.event.actorId, second.event.actorId];
    for (const id of winningActors) { const before = first.before.players.find(player => player.actorId === id)!, after = second.after.players.find(player => player.actorId === id)!; expect(after.won).toBe(true); expect(after.winningTile).toBe(first.event.tile); expect(after.hand).toEqual(before.hand); expect(after.melds).toEqual(before.melds); }
    const source = second.after.players.find(player => player.actorId === first.event.fromActorId)!; expect(source.discards).toEqual(first.before.players.find(player => player.actorId === source.actorId)!.discards);
    const view = f.renderer.scene!.getObjectByName('home-mahjong-game-view')!, displayed = view.userData.snapshot.tiles as PresentedTile[]; expect(displayed.filter(tile => tile.actorId === source.actorId && tile.role === 'discard' && tile.text === first.event.tile && tile.faceVisible)).toHaveLength(1); expect(view.userData.snapshot.wonActorIds).toEqual(winningActors); expect(players.flatMap(player => player.played).slice(-2)).toEqual([clipMap['胡'], clipMap['胡']]);
    const finished = runToState(f, transitions, state => state.status === 'won', 3000); expect(finished.settlement?.reason).toBe('three-winners'); expect(finished.wallRemaining).toBe(multiCase.finalWall); expect(finished.players.filter(player => player.won).map(player => player.actorId)).toEqual(multiCase.finalWinnerIds.map(id => id + 3)); expect(finished.players.filter(player => !player.won)).toHaveLength(1);
    const frozen = JSON.stringify(finished), count = playCount(), body = view.getObjectByName('home-mahjong-game-tile-bodies') as THREE.Mesh, face = view.getObjectByName('home-mahjong-game-tile-faces') as THREE.Mesh, bodyGeometry = body.geometry, faceGeometry = face.geometry;
    for (let frame = 0; frame < 40; frame++) advance(f, transitions); expect(JSON.stringify(game(f))).toBe(frozen); expect(playCount()).toBe(count); expect(body.geometry).toBe(bodyGeometry); expect(face.geometry).toBe(faceGeometry); expect(random).toHaveBeenCalled(); expect(JSON.stringify(group)).toBe(original); record('MULTIPLE_WINNERS', transitions);
  }, 60_000);

});
