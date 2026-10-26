import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering, type Gathering } from '@/lib/gatherings';
import * as homeAudio from '@/lib/living-home-audio';
import * as clipSpeech from '@/lib/living-home-clip-speech';
import * as mahjongCalls from '@/lib/living-home-mahjong-calls';
import * as mahjongFaces from '@/lib/living-home-mahjong-faces';
import type { HomeWorldDoorId } from '@/lib/living-home-world-meshes';

const ENTRY: HomeWorldDoorId = 'home-main-entry-door', ROOM: HomeWorldDoorId = 'home-room-connection-door', GATE: HomeWorldDoorId = 'home-courtyard-gate';
const gpu = vi.hoisted(() => ({ instances: [] as Array<{ scene: THREE.Scene | null; loop: ((time: number) => void) | null }> }));
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class OfflineRenderer {
    domElement = document.createElement('canvas'); shadowMap = { enabled: false, type: 0 }; outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 1;
    scene: THREE.Scene | null = null; loop: ((time: number) => void) | null = null;
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn();
    setAnimationLoop = vi.fn((loop: ((time: number) => void) | null) => { this.loop = loop; });
    render = vi.fn((scene: THREE.Scene, camera: THREE.Camera) => { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); this.scene = scene; });
    constructor() { gpu.instances.push(this); }
  }
  return { ...actual, WebGLRenderer: OfflineRenderer };
});
type Flags = { realistic?: boolean; localLeisurePreview?: boolean; localRoomTransitions?: boolean; localCompanionDoors?: boolean; localReferenceVilla?: boolean; localQuietAudio?: boolean; localSpeechClips?: Readonly<Record<string, string>>; initialLeisure?: readonly { activity: 'mahjong'; actorIds: number[] }[] };
type AudioKind = keyof typeof homeAudio.HOME_AUDIO_PROFILES;
class MockParam {
  value = 1;
  setValueAtTime(value: number) { this.value = value; return this; }
  linearRampToValueAtTime(value: number) { this.value = value; return this; }
  exponentialRampToValueAtTime(value: number) { this.value = value; return this; }
  setTargetAtTime(value: number) { this.value = value; return this; }
  cancelScheduledValues() { return this; }
}
class MockNode {
  connections: unknown[] = []; disconnected = 0;
  connect(value: unknown) { this.connections.push(value); return value; }
  disconnect() { this.disconnected++; this.connections = []; }
}
class MockBuffer {
  data: Float32Array; duration: number;
  constructor(public length: number, public sampleRate: number) { this.data = new Float32Array(length); this.duration = length / sampleRate; }
  getChannelData() { return this.data; }
}
class MockSource extends MockNode {
  buffer: MockBuffer | null = null; onended: (() => void) | null = null; loop = false; playbackRate = new MockParam();
  starts = 0; stops = 0; ended = false; startedAt = -Infinity; kind: AudioKind | undefined;
  constructor(private context: MockContext) { super(); }
  start() {
    this.starts++; this.startedAt = this.context.currentTime;
    this.kind = (Object.keys(homeAudio.HOME_AUDIO_PROFILES) as AudioKind[]).find(kind => Math.abs(homeAudio.HOME_AUDIO_PROFILES[kind].duration - (this.buffer?.duration ?? -1)) <= 1 / this.context.sampleRate);
  }
  stop() { this.stops++; this.ended = true; }
  flush() { if (this.starts && !this.ended && !this.loop && this.context.currentTime >= this.startedAt + this.buffer!.duration) { this.ended = true; this.onended?.(); } }
  get active() { return this.starts > 0 && !this.ended; }
}
class MockContext {
  state: AudioContextState = 'suspended'; sampleRate = 4000; destination = new MockNode();
  sources: MockSource[] = []; nodes: MockNode[] = []; resumeCalls = 0; closeCalls = 0; createdAt = Date.now();
  get currentTime() { return (Date.now() - this.createdAt) / 1000; }
  async resume() { this.resumeCalls++; this.state = 'running'; }
  async close() { this.closeCalls++; this.state = 'closed'; }
  createGain() { const node = Object.assign(new MockNode(), { gain: new MockParam() }); this.nodes.push(node); return node; }
  createBiquadFilter() { const node = Object.assign(new MockNode(), { type: '', frequency: new MockParam(), Q: new MockParam() }); this.nodes.push(node); return node; }
  createBufferSource() { const source = new MockSource(this); this.sources.push(source); this.nodes.push(source); return source; }
  createBuffer(_channels: number, length: number, sampleRate: number) { return new MockBuffer(length, sampleRate); }
  flush() { this.sources.forEach(source => source.flush()); }
}
const contexts: MockContext[] = [], worlds: Array<ReturnType<typeof createLivingWorld>> = [];
let hidden = false;
let hiddenDescriptor: PropertyDescriptor | undefined, visibilityDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); gpu.instances.length = 0; contexts.length = 0; hidden = false;
  hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden'); visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperties(document, { hidden: { configurable: true, get: () => hidden }, visibilityState: { configurable: true, get: () => hidden ? 'hidden' : 'visible' } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('home world audio integration must remain offline'); }));
  vi.stubGlobal('AudioContext', vi.fn(function () { const context = new MockContext(); contexts.push(context); return context; }));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
});

class LocalClipPlayer {
  src = ''; preload = ''; currentTime = 0; duration = 6; paused = true; error = null;
  onended: (() => void) | null = null; onerror: (() => void) | null = null;
  play = vi.fn(() => { this.paused = false; return Promise.resolve(); });
  pause = vi.fn(() => { this.paused = true; }); load = vi.fn(); removeAttribute = vi.fn((name: string) => { if (name === 'src') this.src = ''; });
}

describe('real local quiet audio and mahjong speech wiring', () => {
  it('enables exact local caption clips while suppressing all AudioContext, ambient and door voices during real motion', async () => {
    const text = '太阳暖暖的，去院子走一走吧。', player = new LocalClipPlayer(), audioFactory = vi.fn(function () { return player; }); vi.stubGlobal('Audio', audioFactory);
    const factory = vi.spyOn(clipSpeech, 'createHomeClipSpeech'), group = snapshot(), original = JSON.stringify(group), fixture = setup(group, { localQuietAudio: true, localSpeechClips: { [text]: '/local-voices/quiet-caption.wav' } });
    const speech = factory.mock.results.at(-1)!.value as ReturnType<typeof clipSpeech.createHomeClipSpeech>;
    expect(audioFactory).not.toHaveBeenCalled(); expect(await fixture.world.setLifeAudio(true)).toBe(true); expect(audioFactory).toHaveBeenCalledTimes(1); fixture.world.setMotion(true);
    const event: Gathering['events'][number] = { id: 'synthetic-quiet-caption', at: Date.now() / 1000, kind: 'dialogue', origin: 'real_provider', area: 'outdoor', characters: [4], message: '本地合成播放夹具', activity: null, lines: [{ character_id: 4, name: '合成伙伴', text }] };
    const talking = { ...group, revision: group.revision + 1, events: [event] }; fixture.world.setBubbleReceipts(new Map([[event.id, Date.now() / 1000]])); fixture.world.update(talking, null, 'outdoor'); step(fixture);
    expect(player.play).toHaveBeenCalledTimes(1); expect(player.src).toBe('/local-voices/quiet-caption.wav'); expect(speech.getSnapshot()).toMatchObject({ enabled: true, currentCaption: { text, actorId: 4 }, clipPlayback: { paused: false } });
    fixture.world.setDoorOpen(ENTRY, true); advance(fixture, 10); expect(fixture.host.dataset.mainDoorOpen).toBe('true'); expect(fixture.renderer.scene!.getObjectByName(ENTRY + '-leaf')!.rotation.y).not.toBe(0);
    fixture.world.setDoorOpen(ENTRY, false); const walking = { ...talking, revision: talking.revision + 1, companions: talking.companions.map(c => ({ ...c, activity: 'walk' })) }, before = actor(fixture).position.clone(); fixture.world.update(walking, null, 'outdoor'); advance(fixture, 40);
    expect(actor(fixture).position.distanceTo(before)).toBeGreaterThan(.05); expect(player.paused).toBe(false); expect(player.play).toHaveBeenCalledTimes(1); expect(fixture.host.dataset.lifeAudioEnabled).toBe('true');
    expect(AudioContext).not.toHaveBeenCalled(); expect(fixture.tick).not.toHaveBeenCalled(); expect(fixture.doorCue).not.toHaveBeenCalled(); expect(sources()).toHaveLength(0); expect(JSON.stringify(group)).toBe(original);
    fixture.world.setMotion(false); expect(player.paused).toBe(true); expect(speech.getSnapshot().currentCaption).toBeNull();
  });

  it('does not let quiet mode or clip options bypass any local preview gate', async () => {
    const nativeAudio = vi.fn(function () { return new LocalClipPlayer(); }); vi.stubGlobal('Audio', nativeAudio); const factory = vi.spyOn(clipSpeech, 'createHomeClipSpeech'), group = snapshot();
    const cases: Array<{ group: Gathering; flags: Flags }> = [{ group, flags: { realistic: false } }, { group, flags: { localLeisurePreview: false } }, { group: { ...group, id: 'production-quiet-world' }, flags: {} }, { group: { ...group, scene_type: 'forest' }, flags: {} }];
    for (const row of cases) { const fixture = setup(row.group, { localQuietAudio: true, localSpeechClips: { 一筒: '/local-voices/yi-tong.wav' }, ...row.flags }); expect(await fixture.world.setLifeAudio(true)).toBe(false); fixture.world.setMotion(true); advance(fixture, 10); fixture.world.setDoorOpen(ENTRY, true); expect(fixture.doorCue).not.toHaveBeenCalled(); fixture.world.dispose(); }
    expect(factory).not.toHaveBeenCalled(); expect(nativeAudio).not.toHaveBeenCalled(); expect(AudioContext).not.toHaveBeenCalled(); expect(sources()).toHaveLength(0);
  });

  it('connects actual mahjong placement steps to an exact offline call clip and the speaking actor caption without draw calls or noise', async () => {
    const player = new LocalClipPlayer(); vi.stubGlobal('Audio', vi.fn(function () { return player; })); const clipFactory = vi.spyOn(clipSpeech, 'createHomeClipSpeech'), callFactory = vi.spyOn(mahjongCalls, 'createHomeMahjongCalls');
    const context = { fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn() }; vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context as unknown as CanvasRenderingContext2D);
    const heldBy = (tile: THREE.Object3D) => { for (let parent = tile.parent; parent; parent = parent.parent) if (typeof parent.userData.characterId === 'number') return parent.userData.characterId as number; return null; };
    const applied: Array<{ tile: THREE.Object3D; text: string; heldBy: number | null; parent: THREE.Object3D | null; ok: boolean }> = [], realApply = mahjongFaces.applyHomeMahjongFace;
    vi.spyOn(mahjongFaces, 'applyHomeMahjongFace').mockImplementation((tile, text) => { const record = { tile, text, heldBy: heldBy(tile), parent: tile.parent, ok: false }; record.ok = realApply(tile, text); applied.push(record); return record.ok; });
    const base = snapshot(), group = { ...base, companions: [4, 5, 6, 7].map((id, index) => ({ ...base.companions[0], id, name: '本地报牌伙伴' + id, x: .25 + index * .15, y: .6 })) }, original = JSON.stringify(group);
    const clipMap = Object.fromEntries(mahjongCalls.HOME_MAHJONG_CALL_TEXTS.map((text, index) => [text, '/local-voices/mahjong-' + index + '.wav'])); expect(Object.keys(clipMap)).toHaveLength(34);
    // Cold-load occupied seats: walking to a seat correctly suppresses calls and
    // belongs to the existing journey tests, rather than this speech wiring case.
    const fixture = setup(group, { localQuietAudio: true, initialLeisure: [{ activity: 'mahjong', actorIds: [4, 5, 6, 7] }], localSpeechClips: clipMap });
    const speech = clipFactory.mock.results.at(-1)!.value as ReturnType<typeof clipSpeech.createHomeClipSpeech>, calls = callFactory.mock.results.at(-1)!.value as ReturnType<typeof mahjongCalls.createHomeMahjongCalls>, stepCalls = vi.spyOn(calls, 'step');
    expect(await fixture.world.setLifeAudio(true)).toBe(true); fixture.world.setMotion(true); expect(fixture.world.getLocalLeisure().assignments.filter(row => row.activity === 'mahjong')).toHaveLength(4);
    advance(fixture, 30); expect(player.play).not.toHaveBeenCalled(); const spokenKeys: string[] = [];
    for (let round = 0; round < 4; round++) {
      until(fixture, () => player.play.mock.calls.length === round + 1, 90);
      const output = speech.getSnapshot().currentCaption; expect(output).not.toBeNull(); expect(output!.key).toMatch(/^local-mahjong-example:/); expect(mahjongCalls.HOME_MAHJONG_CALL_TEXTS).toContain(output!.text); expect([4, 5, 6, 7]).toContain(output!.actorId); spokenKeys.push(output!.key);
      expect(stepCalls.mock.results.some(row => row.value?.key === output!.key)).toBe(true); const record = applied.at(-1)!; expect(record.ok).toBe(true); expect(record.text).toBe(output!.text); expect(record.heldBy, 'apply must find the real tile while it is borrowed by this actor arm').toBe(output!.actorId);
      expect(fixture.renderer.scene!.getObjectByName(record.tile.name)).toBe(record.tile); expect(record.tile.userData.mahjongFace).toBe(output!.text); expect(record.tile.parent, 'effects must return the borrowed tile after placement').not.toBe(record.parent); expect(heldBy(record.tile)).toBeNull();
      const overlay = record.tile.getObjectByName('home-mahjong-face-overlay') as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>; expect(overlay).toBeDefined(); expect(overlay.parent).toBe(record.tile); expect(overlay.userData.mahjongFace).toBe(output!.text); expect(overlay.material.map).toBeInstanceOf(THREE.CanvasTexture);
      expect(player.src).toBe(clipMap[output!.text]); expect(player.paused).toBe(false); expect(Array.from(document.querySelectorAll<HTMLElement>('.living3d-bubble')).some(node => !node.hidden && node.textContent === output!.text)).toBe(true);
      expect(player.onended).toBeTypeOf('function'); player.paused = true; player.onended!(); expect(speech.getSnapshot().currentCaption).toBeNull();
    }
    expect(new Set(spokenKeys).size).toBe(4); expect(applied).toHaveLength(4); expect(AudioContext).not.toHaveBeenCalled(); expect(fixture.tick).not.toHaveBeenCalled(); expect(fixture.doorCue).not.toHaveBeenCalled(); expect(sources()).toHaveLength(0); expect(JSON.stringify(group)).toBe(original);
  }, 15_000);

  it('does not play a mahjong call when actual Canvas2D face application is unavailable', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); const face = vi.spyOn(mahjongFaces, 'applyHomeMahjongFace'), player = new LocalClipPlayer(); vi.stubGlobal('Audio', vi.fn(function () { return player; })); const factory = vi.spyOn(clipSpeech, 'createHomeClipSpeech'), callFactory = vi.spyOn(mahjongCalls, 'createHomeMahjongCalls');
    const base = snapshot(), group = { ...base, companions: [4, 5, 6, 7].map((id, index) => ({ ...base.companions[0], id, name: '无Canvas报牌伙伴' + id, x: .25 + index * .15, y: .6 })) }, clipMap = Object.fromEntries(mahjongCalls.HOME_MAHJONG_CALL_TEXTS.map((text, index) => [text, '/local-voices/mahjong-' + index + '.wav']));
    const fixture = setup(group, { localQuietAudio: true, initialLeisure: [{ activity: 'mahjong', actorIds: [4, 5, 6, 7] }], localSpeechClips: clipMap }), speech = factory.mock.results.at(-1)!.value as ReturnType<typeof clipSpeech.createHomeClipSpeech>, calls = callFactory.mock.results.at(-1)!.value as ReturnType<typeof mahjongCalls.createHomeMahjongCalls>, callStep = vi.spyOn(calls, 'step');
    expect(await fixture.world.setLifeAudio(true)).toBe(true); fixture.world.setMotion(true); advance(fixture, 80); expect(callStep.mock.results.some(row => !!row.value)).toBe(true); expect(face).toHaveBeenCalled(); expect(face.mock.results.every(row => row.value === false)).toBe(true);
    expect(player.play).not.toHaveBeenCalled(); expect(speech.getSnapshot().currentCaption).toBeNull(); expect(AudioContext).not.toHaveBeenCalled(); expect(fixture.tick).not.toHaveBeenCalled(); expect(fixture.doorCue).not.toHaveBeenCalled(); expect(sources()).toHaveLength(0);
  });
});
afterEach(() => {
  worlds.splice(0).forEach(world => world.dispose()); expect(fetch).not.toHaveBeenCalled();
  if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor); else delete (document as unknown as Record<string, unknown>).hidden;
  if (visibilityDescriptor) Object.defineProperty(document, 'visibilityState', visibilityDescriptor); else delete (document as unknown as Record<string, unknown>).visibilityState;
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function snapshot(activity = 'observe'): Gathering {
  return parseGathering({ id: 'synthetic-world-audio', title: '本地合成声音接线验收', scene_type: 'home', revision: 1, closed: false, is_manager: true, me: 'A',
    members: [{ id: 'A', name: '合成主人', manager: true }], companions: [{ id: 4, name: '声音验收伙伴', owner_id: 'A', activity, area: 'outdoor', x: .35, y: .55,
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features' } }],
    items: [{ id: 'saved-tree', kind: 'tree', x: .15, y: .22, mine: true, contributor_name: '合成', growth_status: null },
      { id: 'saved-bench', kind: 'bench', x: .75, y: .65, mine: true, contributor_name: '合成', growth_status: null }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
function sleeping(group: Gathering): Gathering { return { ...group, revision: group.revision + 1, companions: group.companions.map(c => ({ ...c, activity: 'sleep', area: 'bedroom' })) }; }
function setup(group = snapshot(), flags: Flags = {}) {
  const host = document.createElement('div'), labels = document.createElement('div');
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } }); document.body.append(host, labels);
  const factory = vi.spyOn(homeAudio, 'createHomeAudio');
  const world = createLivingWorld(host, labels, group, vi.fn(), vi.fn(), { realistic: true, localLeisurePreview: true, localRoomTransitions: true, localCompanionDoors: true, localReferenceVilla: true, ...flags }); worlds.push(world);
  const audio = factory.mock.results.at(-1)!.value as ReturnType<typeof homeAudio.createHomeAudio>;
  const tick = vi.spyOn(audio, 'tick'), doorCue = vi.spyOn(audio, 'triggerDoor'), pause = vi.spyOn(audio, 'pause');
  return { world, host, renderer: gpu.instances.at(-1)!, audio, tick, doorCue, pause, group };
}
type Fixture = ReturnType<typeof setup>;
function actor(fixture: Fixture) { const root = fixture.renderer.scene!.children.find(o => o.userData.characterId === 4); expect(root).toBeDefined(); return root!; }
function step(fixture: Fixture, delta = 100) { vi.setSystemTime(Date.now() + delta); contexts.forEach(context => context.flush()); expect(fixture.renderer.loop).toBeTypeOf('function'); fixture.renderer.loop!(Date.now()); }
function advance(fixture: Fixture, frames: number) { for (let n = 0; n < frames; n++) step(fixture); }
function until(fixture: Fixture, predicate: () => boolean, max = 900) {
  for (let n = 0; n < max; n++) { step(fixture); if (predicate()) return; }
  throw new Error('AUDIO_WORLD_STALL ' + JSON.stringify({ journey: actor(fixture).userData.homeJourney, position: actor(fixture).position.toArray(), presence: actor(fixture).userData.homePresenceArea, dataset: { ...fixture.host.dataset } }));
}
function sources(kind?: AudioKind) { return contexts.flatMap(context => context.sources).filter(source => source.starts && (!kind || source.kind === kind)); }
function shorts() { return sources().filter(source => !source.loop); }
function active() { return sources().filter(source => source.active); }
function lastActor(fixture: Fixture) { const args = fixture.tick.mock.calls.at(-1); expect(args).toBeDefined(); return args![1].find(row => row.actorId === 4)!; }
function focus(fixture: Fixture, group: Gathering, area: 'outdoor' | 'indoor' | 'bedroom' | 'overview') { fixture.world.setHouseView(area === 'outdoor' ? 'exterior' : 'interior'); fixture.world.update(group, null, area); }
function setHidden(value: boolean) { hidden = value; document.dispatchEvent(new Event('visibilitychange')); }

describe('real local home world audio wiring with actual WebAudio voices', () => {
  it('creates no context by default, starts real local buffers only after explicit enable, and closes immediately on off', async () => {
    const fixture = setup(snapshot('walk')); fixture.world.setMotion(true); advance(fixture, 40);
    expect(AudioContext).not.toHaveBeenCalled(); expect(sources()).toEqual([]);
    expect(await fixture.world.setLifeAudio(true)).toBe(true); expect(AudioContext).toHaveBeenCalledTimes(1); expect(contexts[0].resumeCalls).toBe(1);
    advance(fixture, 60); expect(sources().length).toBeGreaterThan(0); expect(sources('wind').some(source => source.loop)).toBe(true); expect(sources('step').length).toBeGreaterThan(0);
    for (const source of sources()) { expect(source.kind).toBeDefined(); expect(source.buffer!.data.every(Number.isFinite)).toBe(true); expect(source.buffer!.data.some(value => Math.abs(value) > .001)).toBe(true); }
    expect(await fixture.world.setLifeAudio(false)).toBe(false); expect(active()).toHaveLength(0); expect(contexts[0].closeCalls).toBe(1);
    const count = sources().length; advance(fixture, 20); expect(sources()).toHaveLength(count); expect(AudioContext).toHaveBeenCalledTimes(1);
  });

  it('uses actual presence and actual movement during a sleep journey, keeps stationary waiting silent, and snores only after docking', async () => {
    const group = snapshot(), target = sleeping(group), originals = [JSON.stringify(group), JSON.stringify(target)], fixture = setup(group, { localCompanionDoors: false });
    expect(await fixture.world.setLifeAudio(true)).toBe(true); fixture.world.update(target, null, 'outdoor'); fixture.world.setMotion(true); advance(fixture, 12);
    expect(actor(fixture).userData.homePresenceArea).toBe('outdoor'); expect(lastActor(fixture)).toMatchObject({ activity: 'walk', audible: true, moving: true }); expect(sources('step').length).toBeGreaterThan(0); expect(sources('snore')).toHaveLength(0);
    focus(fixture, target, 'bedroom'); step(fixture); expect(lastActor(fixture)).toMatchObject({ activity: 'walk', audible: false }); expect(fixture.tick.mock.calls.at(-1)![2]).toBe('bedroom');
    until(fixture, () => actor(fixture).userData.homeJourney?.phase === 'wait-door'); focus(fixture, target, 'outdoor'); advance(fixture, 3);
    expect(lastActor(fixture)).toMatchObject({ activity: 'walk', audible: true, moving: false }); const stationarySteps = sources('step').length; advance(fixture, 25); expect(sources('step')).toHaveLength(stationarySteps); expect(sources('snore')).toHaveLength(0);
    fixture.world.setDoorOpen(ENTRY, true); focus(fixture, target, 'bedroom'); let before = actor(fixture).position.clone(), crossedWhileWalking = false;
    until(fixture, () => {
      const root = actor(fixture); expect(root.position.distanceTo(before)).toBeLessThan(.2); before = root.position.clone();
      const payload = lastActor(fixture); expect(payload.audible).toBe(root.userData.homePresenceArea === 'bedroom');
      if (root.userData.homeJourney?.active) { expect(payload.activity).toBe('walk'); expect(sources('snore')).toHaveLength(0); if (root.userData.homePresenceArea === 'bedroom') crossedWhileWalking = true; }
      return !!root.userData.sleepingBed;
    });
    expect(crossedWhileWalking).toBe(true); expect(lastActor(fixture).activity).toBe('sleep'); const dockTime = contexts[0].currentTime;
    advance(fixture, 140); expect(sources('snore').length).toBeGreaterThan(0); expect(sources('snore').every(source => source.startedAt >= dockTime)).toBe(true); expect([JSON.stringify(group), JSON.stringify(target)]).toEqual(originals);
  });

  it('silences immediately on pause and visibility changes, then resumes future sounds without replaying hidden or paused history', async () => {
    const fixture = setup(snapshot('walk')); await fixture.world.setLifeAudio(true); fixture.world.setMotion(true); advance(fixture, 30); expect(active().length).toBeGreaterThan(0);
    fixture.world.setMotion(false); expect(active()).toHaveLength(0); const count = shorts().length, total = sources().length;
    vi.setSystemTime(Date.now() + 3_600_000); fixture.world.update(fixture.group, null, 'outdoor'); expect(sources()).toHaveLength(total);
    fixture.world.setMotion(true); expect(shorts()).toHaveLength(count); step(fixture, 50); expect(shorts().length - count).toBeLessThanOrEqual(2);
    advance(fixture, 15); expect(active().length).toBeGreaterThan(0); const tickCount = fixture.tick.mock.calls.length; setHidden(true); expect(active()).toHaveLength(0);
    const hiddenCount = sources().length; step(fixture, 3_600_000); advance(fixture, 10); expect(sources()).toHaveLength(hiddenCount); expect(fixture.tick).toHaveBeenCalledTimes(tickCount);
    const shortCount = shorts().length; setHidden(false); step(fixture); expect(shorts()).toHaveLength(shortCount); step(fixture, 50); expect(shorts().length - shortCount).toBeLessThanOrEqual(2);
    advance(fixture, 30); expect(sources('step').length).toBeGreaterThan(0); expect(AudioContext).toHaveBeenCalledTimes(1); expect(contexts[0].closeCalls).toBe(0);
  });

  it('plays one cue per effective door target change and filters doors by the current listening view', async () => {
    const fixture = setup(snapshot(), { localCompanionDoors: false }); await fixture.world.setLifeAudio(true); fixture.world.setMotion(true); step(fixture);
    const change = (id: HomeWorldDoorId, open: boolean, audible: boolean) => {
      const calls = fixture.doorCue.mock.calls.length, count = sources(open ? 'door-open' : 'door-close').length;
      fixture.world.setDoorOpen(id, open); expect(fixture.doorCue.mock.calls.length - calls).toBe(audible ? 1 : 0); expect(sources(open ? 'door-open' : 'door-close').length - count).toBe(audible ? 1 : 0);
      fixture.world.setDoorOpen(id, open); fixture.world.update(fixture.group, null, fixture.host.dataset.focusView as 'outdoor'); expect(fixture.doorCue.mock.calls.length - calls).toBe(audible ? 1 : 0);
      step(fixture, 500);
    };
    change(ENTRY, true, true); change(ENTRY, false, true); change(ROOM, false, false);
    focus(fixture, fixture.group, 'bedroom'); step(fixture); change(ENTRY, true, false); change(ROOM, false, true); change(ROOM, true, true);
    focus(fixture, fixture.group, 'indoor'); step(fixture); change(ENTRY, false, true); change(ROOM, false, true); change(GATE, false, false);
    focus(fixture, fixture.group, 'outdoor'); step(fixture); change(GATE, true, true);
    focus(fixture, fixture.group, 'overview'); step(fixture); change(ENTRY, true, true); change(ROOM, true, true); change(GATE, false, true);
    fixture.world.setMotion(false); const count = fixture.doorCue.mock.calls.length; fixture.world.setDoorOpen(ENTRY, false); expect(fixture.doorCue).toHaveBeenCalledTimes(count);
  });

  it('does not sound a queued unsafe close until the occupied doorway actually changes target', async () => {
    const fixture = setup(), target = sleeping(fixture.group); await fixture.world.setLifeAudio(true); fixture.world.update(target, null, 'outdoor'); fixture.world.setMotion(true);
    until(fixture, () => actor(fixture).userData.journeyPortal === ENTRY && Math.abs(actor(fixture).position.z + .15) < .25);
    expect(fixture.host.dataset.mainDoorOpen).toBe('true'); const before = fixture.doorCue.mock.calls.filter(([id, open]) => id === ENTRY && !open).length;
    fixture.world.setDoorOpen(ENTRY, false); fixture.world.setDoorOpen(ENTRY, false); expect(fixture.host.dataset.mainDoorOpen).toBe('true'); expect(fixture.doorCue.mock.calls.filter(([id, open]) => id === ENTRY && !open)).toHaveLength(before);
    until(fixture, () => fixture.host.dataset.mainDoorOpen === 'false'); expect(fixture.doorCue.mock.calls.filter(([id, open]) => id === ENTRY && !open)).toHaveLength(before + 1);
    const actualCloses = sources('door-close').length; expect(actualCloses).toBeGreaterThan(0); fixture.world.setDoorOpen(ENTRY, false); advance(fixture, 2); expect(sources('door-close')).toHaveLength(actualCloses);
  });

  it('keeps all local sound disabled outside the explicit realistic synthetic home preview gate', async () => {
    const group = snapshot(), cases: Array<{ group: Gathering; flags: Flags }> = [
      { group, flags: { realistic: false } }, { group, flags: { localLeisurePreview: false } }, { group: { ...group, id: 'production-world-audio' }, flags: {} }, { group: { ...group, scene_type: 'forest' }, flags: {} },
    ];
    for (const row of cases) {
      const fixture = setup(row.group, row.flags); expect(await fixture.world.setLifeAudio(true)).toBe(false); fixture.world.setMotion(true); advance(fixture, 12); fixture.world.setDoorOpen(ENTRY, true); fixture.world.setDoorOpen(GATE, false);
      expect(fixture.doorCue).not.toHaveBeenCalled(); expect(AudioContext).not.toHaveBeenCalled(); expect(sources()).toHaveLength(0); fixture.world.dispose();
    }
  });

  it('closes every active context on group, viewer and scene scope changes and never reopens without another explicit enable', async () => {
    for (const mode of ['group', 'viewer', 'scene'] as const) {
      const group = snapshot('walk'), fixture = setup(group); expect(await fixture.world.setLifeAudio(true)).toBe(true); fixture.world.setMotion(true); advance(fixture, 15); const context = contexts.at(-1)!; expect(context.sources.some(source => source.active)).toBe(true);
      const next = mode === 'group' ? { ...group, id: group.id + '-next' } : mode === 'viewer' ? { ...group, me: 'B' } : { ...group, scene_type: 'forest' as const };
      fixture.world.update(next, null, 'outdoor'); expect(context.closeCalls).toBe(1); expect(context.sources.filter(source => source.active)).toHaveLength(0); expect(fixture.audio.getSnapshot().enabled).toBe(false);
      const constructors = contexts.length, count = sources().length; advance(fixture, 20); expect(contexts).toHaveLength(constructors); expect(sources()).toHaveLength(count);
      if (mode !== 'scene') { expect(await fixture.world.setLifeAudio(true)).toBe(true); expect(contexts).toHaveLength(constructors + 1); advance(fixture, 2); }
      else expect(await fixture.world.setLifeAudio(true)).toBe(false);
      const stale = fixture.renderer.loop; fixture.world.dispose(); fixture.world.dispose(); expect(context.closeCalls).toBe(1); expect(active()).toHaveLength(0); const finalCount = sources().length; stale?.(Date.now() + 100); expect(sources()).toHaveLength(finalCount);
    }
  });
});
