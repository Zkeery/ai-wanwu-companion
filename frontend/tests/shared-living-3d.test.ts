import { describe, expect, it } from 'vitest';
import { parseGathering, type Gathering } from '@/lib/gatherings';
import { parseAvatar3D, sampleLivingPose, worldAnchor } from '@/lib/shared-living-3d';

// All records here are synthetic. Rendering must not invent or persist business events.
function snapshot(
  companions: Array<Partial<Gathering['companions'][number]> & { id: number }>,
  events: Gathering['events'] = [],
): Gathering {
  return parseGathering({
    id: '11111111-1111-4111-8111-111111111111', title: '合成立体联测', scene_type: 'home',
    revision: 8, closed: false, is_manager: true, me: 'owner-a', invitation: null,
    members: [{ id: 'owner-a', name: '合成 A', manager: true }, { id: 'owner-b', name: '合成 B', manager: false }],
    companions: companions.map(c => ({ name: `合成伙伴 ${c.id}`, owner_id: 'owner-a', activity: 'rest', x: .5, y: .5, ...c })),
    items: [], votes: [], stories: [], goal: null, story_enabled: false,
    season: { current_season: null }, events,
  });
}

function event(id: number, activity: string, at: number, eventId = 'record') {
  return { id: eventId, message: '合成活动记录', at, kind: 'activity', activity, characters: [id], origin: 'offline_rules' };
}

const validAvatar = {
  version: 1, kind: 'cup', body: '#67A384', accent: '#F2E3B9', detail: '#273D37',
  seed: 42, source: 'procedural_existing_features',
} as const;

describe('shared 3D avatar contracts', () => {
  it('retains a valid existing-feature descriptor without guessing from a name', () => {
    expect(parseAvatar3D(validAvatar, 4)).toEqual(validAvatar);
    expect(parseAvatar3D({ name: '薄荷杯子花束苹果' }, 4).kind).toBe('unavailable');
    expect(parseAvatar3D(undefined, 4).kind).toBe('unavailable');
  });

  it.each([
    { ...validAvatar, version: 2 },
    { ...validAvatar, kind: 'unknown-mesh' },
    { ...validAvatar, source: 'generated_by_model' },
    { ...validAvatar, body: 'url(https://example.invalid/texture)' },
    { ...validAvatar, accent: '' },
    { ...validAvatar, detail: '#zzzzzz' },
    { ...validAvatar, seed: Number.NaN },
    { ...validAvatar, seed: -1 },
    { kind: 'cup', version: 1 },
  ])('uses an unavailable descriptor for malformed or untrusted input %#', value => {
    const parsed = parseAvatar3D(value, 4);
    expect(parsed.kind).toBe('unavailable');
    expect(parsed.source).toBe('procedural_existing_features');
    expect(Number.isFinite(parsed.seed)).toBe(true);
  });
});

describe('server-backed shared 3D layout', () => {
  it('separates ten coincident participants, stays within the ground, and preserves their saved anchors', () => {
    const g = snapshot(Array.from({ length: 10 }, (_, i) => ({ id: i + 1, owner_id: i % 2 ? 'owner-b' : 'owner-a' })));
    const before = JSON.stringify(g);
    const anchors = g.companions.map(c => worldAnchor(g, c.id)!);
    expect(new Set(anchors.map(a => `${a.x}:${a.z}`)).size).toBe(10);
    for (const anchor of anchors) {
      expect(anchor.x).toBeGreaterThanOrEqual(-4);
      expect(anchor.x).toBeLessThanOrEqual(4);
      expect(anchor.z).toBeGreaterThanOrEqual(-2.8);
      expect(anchor.z).toBeLessThanOrEqual(2.8);
    }
    expect(JSON.stringify(g)).toBe(before);
    expect(g.companions.map(c => worldAnchor(g, c.id))).toEqual(anchors);
  });

  it('does not depend on the response order when choosing display positions', () => {
    const g = snapshot([{ id: 1, x: .35, y: .65 }, { id: 2, x: .5, y: .65 }, { id: 3, x: .65, y: .55 }]);
    const reordered = { ...g, companions: [...g.companions].reverse() };
    for (const c of g.companions) expect(worldAnchor(reordered, c.id)).toEqual(worldAnchor(g, c.id));
  });

  it('clamps off-ground legacy coordinates and leaves a recalled participant absent', () => {
    const g = snapshot([{ id: 1, x: -20, y: 30 }, { id: 2, x: 30, y: -20 }]);
    for (const c of g.companions) {
      const anchor = worldAnchor(g, c.id)!;
      expect(Number.isFinite(anchor.x) && Number.isFinite(anchor.z)).toBe(true);
      expect(Math.abs(anchor.x)).toBeLessThanOrEqual(4);
      expect(Math.abs(anchor.z)).toBeLessThanOrEqual(2.8);
    }
    expect(worldAnchor(g, 999)).toBeNull();
    expect(sampleLivingPose(g, 999, 100, true)).toBeNull();
  });
});

describe('shared 3D state presentation', () => {
  it('produces the same pose from the same saved state and clock without changing records', () => {
    const g = snapshot([{ id: 1, activity: 'walk' }], [event(1, 'walk', 100)]);
    const before = JSON.stringify(g);
    const first = sampleLivingPose(g, 1, 102.25, true);
    expect(sampleLivingPose(g, 1, 102.25, true)).toEqual(first);
    expect(sampleLivingPose(g, 1, 102.75, true)).not.toEqual(first);
    expect(JSON.stringify(g)).toBe(before);
  });

  it('keeps a walking presentation close to the saved anchor and inside the ground over a long interval', () => {
    const g = snapshot([{ id: 1, x: .98, y: .98, activity: 'walk' }], [event(1, 'walk', 100)]);
    const anchor = worldAnchor(g, 1)!;
    for (let i = 0; i < 120; i += 1) {
      const pose = sampleLivingPose(g, 1, 100 + i * 1.37, true)!;
      expect(Math.hypot(pose.x - anchor.x, pose.z - anchor.z)).toBeLessThanOrEqual(1);
      expect(Math.abs(pose.x)).toBeLessThanOrEqual(4);
      expect(Math.abs(pose.z)).toBeLessThanOrEqual(2.8);
      expect([pose.x, pose.z, pose.y, pose.yaw, pose.lean, pose.stride, pose.arm].every(Number.isFinite)).toBe(true);
      expect(typeof pose.rest).toBe('boolean');
      expect(typeof pose.blink).toBe('boolean');
    }
    expect(g.companions[0]).toMatchObject({ x: .98, y: .98, activity: 'walk' });
    expect(g.events).toHaveLength(1);
  });

  it('holds every activity still when animation is disabled', () => {
    for (const activity of ['arriving', 'rest', 'walk', 'observe', 'talk']) {
      const g = snapshot([{ id: 1, activity }], [event(1, activity, 10)]);
      const pose = sampleLivingPose(g, 1, 12, false)!;
      expect(sampleLivingPose(g, 1, 900, false)).toEqual(pose);
      expect(pose.stride).toBe(0);
      expect(pose.arm).toBe(0);
    }
  });

  it('only faces a participant who has independently entered the same talk state', () => {
    const g = snapshot([
      { id: 1, activity: 'talk', x: .1, y: .2 },
      { id: 2, activity: 'talk', owner_id: 'owner-b', x: .9, y: .8 },
      { id: 3, activity: 'rest', owner_id: 'owner-b', x: .12, y: .2 },
      { id: 4, activity: 'talk', owner_id: 'owner-b', x: .45, y: .45 },
    ]);
    expect(sampleLivingPose(g, 1, 20, true)?.talkingTo).toBe(4);
    const alone = { ...g, companions: g.companions.filter(c => c.id === 1 || c.activity !== 'talk') };
    expect(sampleLivingPose(alone, 1, 20, true)?.talkingTo).toBeNull();
    expect(sampleLivingPose(g, 3, 20, true)?.talkingTo).toBeNull();
    expect(g.events).toEqual([]);
  });

  it('does not animate an unknown old activity as walking or invent an interaction', () => {
    const g = snapshot([{ id: 1, activity: 'legacy_activity' }]);
    const pose = sampleLivingPose(g, 1, 10, true)!;
    expect(pose.stride).toBe(0);
    expect(pose.talkingTo).toBeNull();
    expect(g.companions[0].activity).toBe('legacy_activity');
    expect(g.events).toEqual([]);
  });
});
