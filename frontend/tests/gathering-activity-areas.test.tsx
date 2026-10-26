import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gatheringCompanionArea, parseGathering, type Gathering } from '@/lib/gatherings';
import { sampleLivingPose } from '@/lib/shared-living-3d';

function input(companions: Array<Record<string, unknown>>, scene = 'home') {
  return { id: 'synthetic-area-space', title: '房间与庭院合成测试', scene_type: scene,
    revision: 8, closed: false, is_manager: true, me: 'owner-a', invitation: null,
    members: [{ id: 'owner-a', name: '合成A', manager: true }, { id: 'owner-b', name: '合成B', manager: false }],
    companions: companions.map(c => ({ name: `伙伴${c.id}`, owner_id: 'owner-a', activity: 'talk', x: .5, y: .5, ...c })),
    items: [], votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: null } };
}

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('saved companion area contracts', () => {
  it.each(['indoor', 'outdoor', 'bedroom'] as const)('retains an explicit %s server area and the original ownership, anchors and revision', area => {
    const raw = input([{ id: 1, owner_id: 'owner-b', activity: 'rest', x: .23, y: .74, area }]);
    const before = JSON.stringify(raw), g = parseGathering(raw);
    expect(g.companions[0]).toMatchObject({ id: 1, owner_id: 'owner-b', activity: 'rest', x: .23, y: .74, area });
    expect(g.revision).toBe(8); expect(gatheringCompanionArea(g, g.companions[0])).toBe(area);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('accepts old missing-area records without inferring a new room from their activity', () => {
    const raw = input([{ id: 1, activity: 'rest' }]), before = JSON.stringify(raw), g = parseGathering(raw);
    expect(g.companions[0]).not.toHaveProperty('area');
    expect(gatheringCompanionArea(g, g.companions[0])).toBe('outdoor');
    const legacyTypedCompanion: Gathering['companions'][number] = { id: 2, name: '旧伙伴', owner_id: 'owner-a', activity: 'rest', x: .4, y: .6, dialogue_allowed: false };
    expect(gatheringCompanionArea(g, legacyTypedCompanion)).toBe('outdoor');
    expect(JSON.stringify(raw)).toBe(before);
  });

  it.each([null, '', 'room', 'INDOOR', 1, false, {}, []])('rejects an explicitly invalid area instead of treating it as a trusted room %#', area => {
    const raw = input([{ id: 1, area }]), before = JSON.stringify(raw);
    expect(() => parseGathering(raw)).toThrow('共同生活数据格式不正确');
    expect(JSON.stringify(raw)).toBe(before);
  });

  it.each(['forest', 'desert', 'legacy-scene'])('projects explicit authorized areas for known dwellings in %s without rewriting the descriptor', scene => {
    const raw = input([{ id: 1, activity: 'rest', area: 'indoor' }], scene), before = JSON.stringify(raw);
    const g = parseGathering(raw);
    expect(gatheringCompanionArea(g, g.companions[0])).toBe(scene === 'legacy-scene' ? 'outdoor' : 'indoor');
    expect(g.companions[0].area).toBe('indoor');
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('uses an explicitly refreshed server area without rewriting the old snapshot', () => {
    const original = parseGathering(input([{ id: 1, activity: 'rest' }])), before = JSON.stringify(original);
    const refreshed = parseGathering({ ...input([{ id: 1, activity: 'rest', area: 'indoor' }]), revision: 9 });
    expect(gatheringCompanionArea(original, original.companions[0])).toBe('outdoor');
    expect(gatheringCompanionArea(refreshed, refreshed.companions[0])).toBe('indoor');
    expect(JSON.stringify(original)).toBe(before);
  });
});

describe('shared talk poses respect independently saved areas', () => {
  it.each(['indoor', 'outdoor', 'bedroom'] as const)('faces only another saved talk participant in the same %s area', area => {
    const otherArea = area === 'indoor' ? 'outdoor' : 'indoor';
    const g = parseGathering(input([
      { id: 1, area, x: .12, y: .22 },
      { id: 2, owner_id: 'owner-b', area: otherArea, x: .13, y: .22 },
      { id: 3, owner_id: 'owner-b', area, x: .85, y: .75 },
      { id: 4, owner_id: 'owner-b', area, activity: 'rest', x: .14, y: .22 },
    ]));
    const before = JSON.stringify(g);
    expect(sampleLivingPose(g, 1, 25, true)?.talkingTo).toBe(3);
    expect(sampleLivingPose(g, 3, 25, true)?.talkingTo).toBe(1);
    expect(sampleLivingPose(g, 2, 25, true)?.talkingTo).toBeNull();
    expect(sampleLivingPose(g, 4, 25, true)?.talkingTo).toBeNull();
    expect(g.events).toEqual([]); expect(JSON.stringify(g)).toBe(before);
  });

  it('does not create a shared talk interaction when the two participants are in different areas', () => {
    const g = parseGathering(input([{ id: 1, area: 'indoor' }, { id: 2, owner_id: 'owner-b', area: 'outdoor' }]));
    const before = JSON.stringify(g);
    for (const animate of [true, false]) {
      expect(sampleLivingPose(g, 1, 30, animate)?.talkingTo).toBeNull();
      expect(sampleLivingPose(g, 2, 30, animate)?.talkingTo).toBeNull();
    }
    expect(JSON.stringify(g)).toBe(before); expect(g.events).toEqual([]);
  });

  it('keeps all three home areas separate without inventing a cross-room conversation', () => {
    const g = parseGathering(input([{ id: 1, area: 'outdoor' }, { id: 2, area: 'indoor' }, { id: 3, area: 'bedroom' }]));
    const before = JSON.stringify(g);
    for (const id of [1, 2, 3]) expect(sampleLivingPose(g, id, 30, true)?.talkingTo).toBeNull();
    expect(JSON.stringify(g)).toBe(before); expect(g.events).toEqual([]);
  });

  it.each(['forest', 'desert'])('honors the saved bedroom area in %s without inferring it from activity', scene => {
    const g = parseGathering(input([{ id: 1, area: 'bedroom', activity: 'sleep' }], scene));
    expect(gatheringCompanionArea(g, g.companions[0])).toBe('bedroom');
    expect(g.companions[0].area).toBe('bedroom');
  });

  it.each(['forest', 'desert'])('keeps companions in different saved areas separate in %s', scene => {
    const g = parseGathering(input([{ id: 1, area: 'indoor' }, { id: 2, area: 'outdoor', owner_id: 'owner-b' }], scene));
    expect(sampleLivingPose(g, 1, 30, true)?.talkingTo).toBeNull();
    expect(sampleLivingPose(g, 2, 30, true)?.talkingTo).toBeNull();
    expect(g.events).toEqual([]);
  });
  it.each(['forest','desert'])('keeps legacy %s records outdoors until an explicit saved area arrives',scene=>{
    const g=parseGathering(input([{id:1,activity:'talk'},{id:2,activity:'talk',owner_id:'owner-b'}],scene));
    expect(gatheringCompanionArea(g,g.companions[0])).toBe('outdoor');
    expect(sampleLivingPose(g,1,30,true)?.talkingTo).toBe(2);
    expect(sampleLivingPose(g,2,30,true)?.talkingTo).toBe(1);
  });
});
