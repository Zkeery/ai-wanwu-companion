import { describe, expect, it } from 'vitest';
import { activityEvidence, companionPosition, parseGathering } from '@/lib/gatherings';

function snapshot(activity = 'rest') {
  return parseGathering({
    id: 'space', title: '一起生活', scene_type: 'home', revision: 4, closed: false,
    is_manager: true, me: 'owner', invitation: null,
    members: [{ id: 'owner', name: '我', manager: true }],
    companions: [
      { id: 1, name: '小满', owner_id: 'owner', activity, x: 0.35, y: 0.65 },
      { id: 2, name: '小树', owner_id: 'other', activity: 'rest', x: 0.35, y: 0.65 },
    ], items: [], votes: [], stories: [], goal: null, story_enabled: false,
    season: { current_season: null },
    events: [
      { id: 'old', at: 1, message: '小满在休息。', kind: 'activity', activity: 'rest', characters: [1], origin: 'offline_rules' },
      { id: 'other', at: 2, message: '小树在休息。', kind: 'activity', activity: 'rest', characters: [2], origin: 'offline_rules' },
      { id: 'latest', at: 3, message: '小满在散步。', kind: 'activity', activity: 'walk', characters: [1], origin: 'offline_rules' },
    ],
  });
}

describe('shared companion facts', () => {
  it('uses only a persisted event matching the selected companion and current activity', () => {
    expect(activityEvidence(snapshot('walk'), 1)?.id).toBe('latest');
    expect(activityEvidence(snapshot('rest'), 1)?.id).toBe('old');
    expect(activityEvidence(snapshot('observe'), 1)).toBeNull();
    expect(activityEvidence(snapshot(), 2)?.id).toBe('other');
  });

  it('separates overlapping display positions without changing stored coordinates', () => {
    const g = snapshot();
    const first = companionPosition(g, 1), second = companionPosition(g, 2);
    expect(first).not.toEqual(second);
    expect(companionPosition(g, 1)).toEqual(first);
    expect(g.companions.map(c => [c.x, c.y])).toEqual([[0.35, 0.65], [0.35, 0.65]]);
  });

  it('keeps nearby but different saved anchors readable', () => {
    const g = snapshot();
    g.companions[0].x = 0.65; g.companions[0].y = 0.55;
    g.companions[1].x = 0.5;
    const first = companionPosition(g, 1), second = companionPosition(g, 2);
    expect(Math.abs(parseFloat(first!.left) - parseFloat(second!.left))).toBeGreaterThan(15);
    expect(g.companions.map(c => [c.x, c.y])).toEqual([[0.65, 0.55], [0.5, 0.65]]);
  });
});
