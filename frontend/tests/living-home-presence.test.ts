import { describe, expect, it } from 'vitest';
import { getHomePresenceActor, homePresenceActivityLabel, homePresenceSnapshotKey, type HomePresenceActor, type HomePresenceScope, type HomePresenceSnapshot } from '../lib/living-home-presence';

const scope: HomePresenceScope = { groupId: 'synthetic-presence', ownerId: 'account-a', sceneType: 'home', enabled: true, actorIds: [4, 5] };
const actor: HomePresenceActor = { id: 4, area: 'outdoor', active: true, phase: 'walk', targetArea: 'bedroom' };
const snapshot: HomePresenceSnapshot = { groupId: scope.groupId, ownerId: scope.ownerId, actors: [actor] };

describe('home presence is a read-only view projection', () => {
  it('shows the current physical area separately from the saved destination', () => {
    const savedCompanion = { id: 4, owner_id: 'friend', activity: 'sleep', area: 'bedroom' };
    const before = JSON.stringify(savedCompanion), projected = getHomePresenceActor(snapshot, scope, savedCompanion.id)!;
    expect(projected.area).toBe('outdoor'); expect(projected.targetArea).toBe('bedroom');
    expect(homePresenceActivityLabel(projected, '睡觉')).toBe('走向卧室，准备睡觉');
    expect(JSON.stringify(savedCompanion)).toBe(before);
    // Permission remains the saved record's owner, regardless of projected area or arrival state.
    expect(savedCompanion.owner_id === scope.ownerId).toBe(false);
    expect(Object.keys(projected).sort()).toEqual(['active', 'area', 'id', 'phase', 'targetArea']);
    expect(Object.isFrozen(projected)).toBe(true);
  });
  it.each([
    { ...scope, enabled: false }, { ...scope, sceneType: 'forest' }, { ...scope, groupId: 'production-space' },
    { ...scope, groupId: 'synthetic-other-space' }, { ...scope, ownerId: 'account-b' }, { ...scope, actorIds: [5] },
  ])('rejects disabled, production, cross-space, cross-account or removed-actor snapshots', currentScope => {
    expect(getHomePresenceActor(snapshot, currentScope, 4)).toBeNull();
  });
  it('rejects unavailable ids and malformed projections without granting any fallback capabilities', () => {
    expect(getHomePresenceActor(snapshot, scope, 5)).toBeNull();
    expect(getHomePresenceActor(snapshot, scope, -1)).toBeNull();
    expect(getHomePresenceActor(null, scope, 4)).toBeNull();
    expect(getHomePresenceActor(snapshot, { ...scope, groupId: undefined } as unknown as HomePresenceScope, 4)).toBeNull();
    const duplicate = { ...snapshot, actors: [actor, actor] };
    expect(getHomePresenceActor(duplicate, scope, 4)).toBeNull();
    expect(homePresenceSnapshotKey(duplicate)).toBe('');
    for (const patch of [{ id: NaN }, { area: 'unknown' }, { targetArea: 'unknown' }, { phase: 'dialogue' }, { active: false }, { active: true, phase: 'idle' }]) {
      const invalid = { ...snapshot, actors: [{ ...actor, ...patch }] } as HomePresenceSnapshot;
      expect(getHomePresenceActor(invalid, scope, 4)).toBeNull(); expect(homePresenceSnapshotKey(invalid)).toBe('');
    }
  });
  it('returns only fixed presentation phrases, never model dialogue or system state in a bubble', () => {
    const phrases = { undock: '正在起身', turn: '正在转身', portal: '正在穿过房门', 'wait-door': '门前等候', blocked: '暂时停下' } as const;
    for (const [phase, phrase] of Object.entries(phrases)) expect(homePresenceActivityLabel({ ...actor, phase: phase as HomePresenceActor['phase'] }, '睡觉')).toBe(phrase);
    expect(homePresenceActivityLabel({ ...actor, phase: 'dock' }, '休息')).toBe('正在坐下');
    expect(homePresenceActivityLabel({ ...actor, phase: 'dock' }, '睡觉')).toBe('正在躺下');
    expect(homePresenceActivityLabel({ ...actor, phase: 'dock' }, '喝茶')).toBe('正在就位');
    expect(homePresenceActivityLabel({ ...actor, active: false, phase: 'idle' }, '睡觉')).toBe('睡觉');
    expect(homePresenceActivityLabel(null, '散步')).toBe('散步');
  });
  it('keys only discrete contents, in stable id order, and preserves caller-owned snapshots', () => {
    const second: HomePresenceActor = { id: 5, area: 'indoor', active: false, phase: 'idle', targetArea: 'indoor' };
    const original = { ...snapshot, actors: [second, actor] }, before = JSON.stringify(original);
    expect(homePresenceSnapshotKey(original)).toBe(homePresenceSnapshotKey({ ...original, actors: [actor, second] }));
    const withFrameNoise = { ...original, timestamp: 123, actors: original.actors.map(a => ({ ...a, x: 999, frame: 123 })) };
    expect(homePresenceSnapshotKey(original)).toBe(homePresenceSnapshotKey(withFrameNoise));
    expect(JSON.stringify(original)).toBe(before);
    for (const patch of [{ area: 'indoor' }, { phase: 'wait-door' }, { targetArea: 'indoor' }, { active: false, phase: 'idle' }]) {
      const changed = { ...snapshot, actors: [{ ...actor, ...patch }] } as HomePresenceSnapshot;
      expect(homePresenceSnapshotKey(changed)).not.toBe(homePresenceSnapshotKey(snapshot));
    }
    expect(homePresenceSnapshotKey({ ...snapshot, ownerId: 'account-b' })).not.toBe(homePresenceSnapshotKey(snapshot));
    expect(homePresenceSnapshotKey({ ...snapshot, actors: [] })).not.toBe(homePresenceSnapshotKey(snapshot));
  });
  it('does not add dialogue events, membership or authorization fields to the snapshot', () => {
    const state = { companions: [{ id: 4, owner_id: 'account-a', area: 'bedroom', activity: 'sleep' }], events: [{ id: 'existing-record', kind: 'dialogue' }] };
    const before = JSON.stringify(state), key = homePresenceSnapshotKey(snapshot);
    getHomePresenceActor(snapshot, scope, 4); homePresenceActivityLabel(actor, '睡觉');
    expect(JSON.stringify(state)).toBe(before); expect(homePresenceSnapshotKey(snapshot)).toBe(key);
    expect('owner_id' in getHomePresenceActor(snapshot, scope, 4)!).toBe(false);
    expect('events' in snapshot).toBe(false);
  });
});
