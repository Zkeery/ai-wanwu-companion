import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLivingWorld } from '@/lib/living-world-engine';
import { parseGathering, type Gathering } from '@/lib/gatherings';
import type { HomePresenceSnapshot } from '@/lib/living-home-presence';

const ENTRY = 'home-main-entry-door', ROOM = 'home-room-connection-door';
const gpu = vi.hoisted(() => ({ instances: [] as Array<{ scene: THREE.Scene | null; loop: ((time: number) => void) | null }> }));
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class OfflineRenderer {
    domElement = document.createElement('canvas'); shadowMap = { enabled: false, type: 0 };
    outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 1;
    scene: THREE.Scene | null = null; loop: ((time: number) => void) | null = null;
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn();
    setAnimationLoop = vi.fn((loop: ((time: number) => void) | null) => { this.loop = loop; });
    render = vi.fn((scene: THREE.Scene, camera: THREE.Camera) => { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); this.scene = scene; });
    constructor() { gpu.instances.push(this); }
  }
  return { ...actual, WebGLRenderer: OfflineRenderer };
});
type Renderer = typeof gpu.instances[number];
type Event = { value: HomePresenceSnapshot | null; position: number[] | null };
const worlds: Array<ReturnType<typeof createLivingWorld>> = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); gpu.instances.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('home presence integration must remain offline'); }));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
});
afterEach(() => {
  worlds.splice(0).forEach(world => world.dispose()); expect(fetch).not.toHaveBeenCalled(); document.body.replaceChildren();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function snapshot(): Gathering {
  return parseGathering({ id: 'synthetic-presence-engine', title: '实际位置区域回调', scene_type: 'home', revision: 1,
    closed: false, is_manager: true, me: 'A', members: [{ id: 'A', name: '合成主人', manager: true }, { id: 'B', name: '另一主人', manager: false }],
    companions: [{ id: 4, owner_id: 'A', name: '本地伙伴', activity: 'observe', area: 'outdoor', x: .35, y: .55,
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features' } }],
    items: [{ id: 'saved-tree', kind: 'tree', x: .15, y: .22, mine: true, contributor_name: '合成', growth_status: null },
      { id: 'saved-bench', kind: 'bench', x: .75, y: .65, mine: true, contributor_name: '合成', growth_status: null }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
function sleep(group: Gathering): Gathering { return { ...group, revision: group.revision + 1, companions: group.companions.map(c => ({ ...c, activity: 'sleep', area: 'bedroom' })) }; }
function setup(group = snapshot(), overrides: { realistic?: boolean; localLeisurePreview?: boolean; localRoomTransitions?: boolean } = {}) {
  const host = document.createElement('div'), labels = document.createElement('div'), events: Event[] = [];
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } }); document.body.append(host, labels);
  const callback = vi.fn((value: HomePresenceSnapshot | null) => {
    const root = gpu.instances.at(-1)?.scene?.children.find(object => object.userData.characterId === 4);
    events.push({ value: value ? JSON.parse(JSON.stringify(value)) as HomePresenceSnapshot : null, position: root?.position.toArray() ?? null });
  });
  const options = { realistic: true, localLeisurePreview: true, localRoomTransitions: true, ...overrides, onJourneyChange: callback };
  const world = createLivingWorld(host, labels, group, vi.fn(), vi.fn(), options); worlds.push(world);
  world.setHouseView('interior'); world.setDoorOpen(ENTRY, true); world.setDoorOpen(ROOM, true);
  return { world, events, callback, renderer: gpu.instances.at(-1)!, group };
}
function actor(renderer: Renderer) { const root = renderer.scene!.children.find(object => object.userData.characterId === 4); expect(root).toBeDefined(); return root!; }
function step(renderer: Renderer, delta = 100) { vi.setSystemTime(Date.now() + delta); expect(renderer.loop).toBeTypeOf('function'); renderer.loop!(Date.now()); }
function latest(events: Event[]) { return events.at(-1)?.value; }
function physicalArea(position: readonly number[]) { return position[2] >= -.15 ? 'outdoor' : position[0] > 0 ? 'bedroom' : 'indoor'; }

describe('actual home presence engine callbacks', () => {
  it('publishes outdoor, indoor, and bedroom only when the actual body center crosses the respective doorway plane', () => {
    const group = snapshot(), next = sleep(group), originals = [JSON.stringify(group), JSON.stringify(next)], fixture = setup(group);
    expect(latest(fixture.events)?.actors[0]).toMatchObject({ id: 4, area: 'outdoor', targetArea: 'outdoor', active: false, phase: 'idle' });
    fixture.world.update(next, null, 'bedroom'); expect(latest(fixture.events)?.actors[0]).toMatchObject({ area: 'outdoor', targetArea: 'bedroom', active: true });
    fixture.world.setMotion(true); let complete = false, sawPhysicalAreaBeforeRouteArea = false;
    for (let i = 0; i < 700; i++) {
      const before = actor(fixture.renderer).position.clone(); step(fixture.renderer); const root = actor(fixture.renderer);
      expect(root.position.distanceTo(before)).toBeLessThan(.2); expect(root.userData.homePresenceArea).toBe(physicalArea(root.position.toArray()));
      expect(latest(fixture.events)?.actors[0].area).toBe(root.userData.homePresenceArea);
      if (root.userData.homePresenceArea !== root.userData.homeRegion) sawPhysicalAreaBeforeRouteArea = true;
      if (root.userData.sleepingBed) { complete = true; break; }
    }
    expect(complete).toBe(true); expect(sawPhysicalAreaBeforeRouteArea, 'presentation must use center crossing before the old route region completes its portal').toBe(true);
    const areas: string[] = [];
    for (const event of fixture.events) {
      const value = event.value?.actors.find(row => row.id === 4); if (!value) continue;
      if (areas.at(-1) !== value.area) areas.push(value.area);
      if (event.position) expect(value.area, JSON.stringify(event)).toBe(physicalArea(event.position));
    }
    expect(areas).toEqual(['outdoor', 'indoor', 'bedroom']); expect(latest(fixture.events)?.actors[0]).toMatchObject({ area: 'bedroom', targetArea: 'bedroom', active: false, phase: 'idle' });
    expect([JSON.stringify(group), JSON.stringify(next)]).toEqual(originals);
  });

  it('emits discrete changes and freezes callback area both before and after crossing a portal plane during pause', () => {
    const group = snapshot(), next = sleep(group), fixture = setup(group); fixture.world.update(next, null); fixture.world.setMotion(true); step(fixture.renderer);
    const count = fixture.events.length, start = actor(fixture.renderer).position.clone();
    for (let i = 0; i < 8; i++) step(fixture.renderer);
    expect(actor(fixture.renderer).position.distanceTo(start)).toBeGreaterThan(.3); expect(fixture.events.length).toBe(count);
    fixture.world.setMotion(false); const stopped = actor(fixture.renderer).position.toArray(), stoppedCount = fixture.events.length, value = JSON.stringify(latest(fixture.events));
    vi.setSystemTime(Date.now() + 3_600_000); for (let i = 0; i < 3; i++) { fixture.world.reset(); fixture.world.update({ ...next, revision: next.revision + i + 1 }, null); }
    expect(actor(fixture.renderer).position.toArray()).toEqual(stopped); expect(fixture.events.length).toBe(stoppedCount); expect(JSON.stringify(latest(fixture.events))).toBe(value);
    fixture.world.setMotion(true); step(fixture.renderer, 50); expect(actor(fixture.renderer).position.distanceTo(new THREE.Vector3(stopped[0], stopped[1], stopped[2]))).toBeLessThan(.2);
    expect(latest(fixture.events)?.actors[0]).toMatchObject({ area: 'outdoor', targetArea: 'bedroom', active: true });
    let insidePortal = false;
    for (let i = 0; i < 300; i++) {
      step(fixture.renderer); const root = actor(fixture.renderer);
      if (root.userData.journeyPortal === ENTRY && root.position.z < -.2 && root.userData.homeRegion === 'outdoor') { insidePortal = true; break; }
    }
    expect(insidePortal, 'pause must occur after physical center crossing and before the route chain completes').toBe(true);
    expect(latest(fixture.events)?.actors[0]).toMatchObject({ area: 'indoor', active: true, phase: 'portal' });
    const portalPosition = actor(fixture.renderer).position.toArray(), portalCount = fixture.events.length;
    fixture.world.setMotion(false); vi.setSystemTime(Date.now() + 3_600_000);
    for (let i = 0; i < 3; i++) { fixture.world.reset(); fixture.world.update({ ...next, revision: next.revision + i + 10 }, null); }
    expect(actor(fixture.renderer).position.toArray()).toEqual(portalPosition); expect(actor(fixture.renderer).userData.homePresenceArea).toBe('indoor');
    expect(fixture.events.length).toBe(portalCount); expect(latest(fixture.events)?.actors[0]).toMatchObject({ area: 'indoor', active: true, phase: 'portal' });
    fixture.world.setMotion(true); let complete = false;
    for (let i = 0; i < 700; i++) { const before = actor(fixture.renderer).position.clone(); step(fixture.renderer); expect(actor(fixture.renderer).position.distanceTo(before)).toBeLessThan(.2); if (actor(fixture.renderer).userData.sleepingBed) { complete = true; break; } }
    expect(complete).toBe(true); expect(fixture.events.slice(portalCount).every(event => !event.value || event.value.actors[0].area !== 'outdoor')).toBe(true);
    expect(latest(fixture.events)?.actors[0]).toMatchObject({ area: 'bedroom', active: false });
  });

  it('removes departed actors and replaces callback scope and actual area when gathering, viewer, or scene changes', () => {
    const group = snapshot(), next = sleep(group), fixture = setup(group); fixture.world.update(next, null); fixture.world.setMotion(true); for (let i = 0; i < 10; i++) step(fixture.renderer);
    fixture.world.update({ ...next, revision: 3, companions: [] }, null); expect(latest(fixture.events)).toMatchObject({ groupId: group.id, ownerId: 'A', actors: [] });
    const replacement = { ...group, id: 'synthetic-replacement-presence', revision: 4 }; fixture.world.update(replacement, null);
    expect(latest(fixture.events)).toMatchObject({ groupId: replacement.id, ownerId: 'A' }); expect(latest(fixture.events)?.actors).toEqual([expect.objectContaining({ id: 4, area: 'outdoor', targetArea: 'outdoor', active: false })]);
    fixture.world.update({ ...replacement, me: 'B', revision: 5 }, null); expect(latest(fixture.events)).toMatchObject({ groupId: replacement.id, ownerId: 'B' });
    fixture.world.update({ ...replacement, me: 'B', scene_type: 'forest', revision: 6 }, null); expect(latest(fixture.events)).toBeNull(); expect(actor(fixture.renderer).userData.homePresenceArea).toBeUndefined();
    const count = fixture.events.length; for (let i = 0; i < 20; i++) step(fixture.renderer); expect(fixture.events.length).toBe(count);
    fixture.world.update({ ...group, revision: 7 }, null); expect(latest(fixture.events)).toMatchObject({ groupId: group.id, ownerId: 'A' }); expect(latest(fixture.events)?.actors[0]).toMatchObject({ area: 'outdoor', active: false, targetArea: 'outdoor' });
  });

  it('clears a disposed active snapshot once and prevents stale animation from emitting or changing a fresh world', () => {
    const group = snapshot(), fixture = setup(group); fixture.world.update(sleep(group), null); fixture.world.setMotion(true); for (let i = 0; i < 10; i++) step(fixture.renderer);
    const staleLoop = fixture.renderer.loop!, before = fixture.events.length; fixture.world.dispose(); expect(fixture.events.length).toBe(before + 1); expect(latest(fixture.events)).toBeNull();
    fixture.world.dispose(); vi.setSystemTime(Date.now() + 100_000); staleLoop(Date.now()); expect(fixture.events.length).toBe(before + 1);
    const fresh = setup(group); expect(latest(fresh.events)?.actors[0]).toMatchObject({ area: 'outdoor', targetArea: 'outdoor', active: false }); expect(latest(fixture.events)).toBeNull();
  });

  it('does not publish runtime presence when any synthetic local transition gate is disabled', () => {
    for (const overrides of [{ realistic: false }, { localLeisurePreview: false }, { localRoomTransitions: false }, {}]) {
      const group = snapshot(); if (Object.keys(overrides).length === 0) group.id = 'ordinary-production-presence';
      const fixture = setup(group, overrides); fixture.world.update(sleep(group), null); fixture.world.setMotion(true); for (let i = 0; i < 20; i++) step(fixture.renderer);
      expect(fixture.callback).not.toHaveBeenCalled(); expect(actor(fixture.renderer).userData.homePresenceArea ?? 'bedroom').toBe('bedroom');
    }
  });
});
