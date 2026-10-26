import { describe, expect, it } from 'vitest';
import { parseGathering, type Gathering } from '@/lib/gatherings';
import { isLivingConversationCaptionValid, livingBubble } from '@/lib/living-world-bubbles';

const receipts = new Map([['synthetic-exchange', 100], ['newer', 102]]);
function sample(): Gathering {
  return parseGathering({ id: 'synthetic-bubbles', title: '合成共同交流', scene_type: 'home', revision: 1,
    closed: false, is_manager: true, me: 'owner-a', invitation: null,
    members: [{ id: 'owner-a', name: '合成A', manager: true }, { id: 'owner-b', name: '合成B', manager: false }],
    companions: [1, 2].map(id => ({ id, name: `合成伙伴${id}`, owner_id: id === 1 ? 'owner-a' : 'owner-b', activity: 'talk', area: 'indoor', x: .5, y: .5 })),
    items: [], votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: null } });
}
function exchange(): Gathering['events'][number] {
  return { id: 'synthetic-exchange', at: 100, kind: 'dialogue', origin: 'real_provider', area: 'indoor',
    characters: [1, 2], message: '合成共同交流记录', activity: null,
    lines: [{ character_id: 1, name: '合成甲', text: '合成台词甲' }, { character_id: 2, name: '合成乙', text: '合成台词乙' }] };
}

describe('saved conversations without status bubbles', () => {
  it('invalidates audible captions on departure, room changes and newer activity while preserving explicit history', () => {
    const g = sample(); g.events = [exchange()];
    expect(isLivingConversationCaptionValid(g, 1, 'synthetic-exchange')).toBe(true);
    g.events.push({ id: 'changed', at: 101, kind: 'activity', activity: 'rest', origin: 'offline_rules', characters: [1], message: '合成新活动' });
    expect(isLivingConversationCaptionValid(g, 1, 'synthetic-exchange')).toBe(false);
    expect(isLivingConversationCaptionValid(g, 1, 'synthetic-exchange', true)).toBe(true);
    g.companions[0].area = 'outdoor';
    expect(isLivingConversationCaptionValid(g, 1, 'synthetic-exchange', true)).toBe(false);
    g.companions = [];
    expect(isLivingConversationCaptionValid(g, 1, 'synthetic-exchange', true)).toBe(false);
  });

  it('does not keep speaking after the snapshot closes or membership is lost', () => {
    const g = sample(); g.events = [exchange()]; g.closed = true;
    expect(livingBubble(g, 1, 102, true, null, receipts)).toBeNull();
    expect(isLivingConversationCaptionValid(g, 1, 'synthetic-exchange')).toBe(false);
    g.closed = false; g.members = g.members.filter(member => member.id !== g.me);
    expect(livingBubble(g, 1, 102, true, null, receipts)).toBeNull();
    expect(isLivingConversationCaptionValid(g, 1, 'synthetic-exchange')).toBe(false);
  });

  it('keeps the saved speaking timeline when the first speaker leaves', () => {
    const g = sample(); g.events = [exchange()]; g.companions = g.companions.filter(c => c.id !== 1);
    expect(livingBubble(g, 2, 102, true, null, receipts)).toBeNull();
    expect(livingBubble(g, 2, 104, true, null, receipts)).toEqual({ kind: 'dialogue', text: '合成台词乙' });
  });

  it('keeps the saved speaking timeline when a newer activity invalidates a line', () => {
    const g = sample(); g.events = [exchange(), { id: 'left-talk', at: 101, kind: 'activity', activity: 'rest', origin: 'offline_rules', characters: [1], area: 'indoor', message: '合成活动' }];
    expect(livingBubble(g, 2, 102, true, null, receipts)).toBeNull();
    expect(livingBubble(g, 2, 104, true, null, receipts)).toEqual({ kind: 'dialogue', text: '合成台词乙' });
  });

  it('shows no bubble for an arranged talk without a real returned conversation', () => {
    const g = sample();
    expect(livingBubble(g, 1, 100, true, null, receipts)).toBeNull();
    g.companions[1].area = 'bedroom';
    expect(livingBubble(g, 1, 100, true, null, receipts)).toBeNull();
    g.companions[0].activity = 'sleep';
    expect(livingBubble(g, 1, 100, true, null, receipts)).toBeNull();
  });

  it('shows each actual saved line once in speaker order with no state or title, without changing records', () => {
    const g = sample(); g.events = [exchange()]; const before = JSON.stringify(g);
    expect(livingBubble(g, 1, 101, true, null, receipts)).toEqual({ kind: 'dialogue', text: '合成台词甲' });
    expect(livingBubble(g, 2, 101, true, null, receipts)).toBeNull();
    expect(livingBubble(g, 2, 104, true, null, receipts)).toEqual({ kind: 'dialogue', text: '合成台词乙' });
    expect(livingBubble(g, 1, 104, true, null, receipts)).toBeNull();
    for (const id of [1, 2]) {
      expect(livingBubble(g, id, 107, true, null, receipts)).toBeNull();
      expect(livingBubble(g, id, 108, true, null, receipts)).toBeNull();
    }
    expect(JSON.stringify(g)).toBe(before);
  });

  it.each(['offline_rules', 'unknown', ''])('does not quote %s or replace it with an activity status', origin => {
    const g = sample(); g.events = [{ ...exchange(), origin }];
    expect(livingBubble(g, 1, 101, true, null, receipts)).toBeNull();
    expect(livingBubble(g, 2, 104, true, null, receipts)).toBeNull();
  });

  it('does not move old room lines into another area or replay a record whose area is missing', () => {
    const g = sample(); g.events = [{ ...exchange(), area: 'bedroom' }];
    expect(livingBubble(g, 1, 101, true, null, receipts)).toBeNull();
    delete g.events[0].area;
    expect(livingBubble(g, 1, 101, true, null, receipts)).toBeNull();
    expect(livingBubble(g, 1, 501, true, 500, receipts)).toBeNull();
  });

  it('keeps expired or future speech hidden and replays saved lines only through explicit history playback', () => {
    const g = sample(); g.events = [exchange()];
    expect(livingBubble(g, 1, 99, true, null, receipts)).toBeNull();
    expect(livingBubble(g, 1, 500, true, null, receipts)).toBeNull();
    expect(livingBubble(g, 1, 501, true, 500, receipts)).toEqual({ kind: 'history', text: '合成台词甲' });
    expect(livingBubble(g, 2, 501, true, 500, receipts)).toBeNull();
    expect(livingBubble(g, 2, 504, true, 500, receipts)).toEqual({ kind: 'history', text: '合成台词乙' });
    for (const id of [1, 2]) expect(livingBubble(g, id, 507, true, 500, receipts)).toBeNull();
  });

  it('does not present a past line as fresh speech after that speaker has a newer activity', () => {
    const g = sample(); g.events = [exchange(), { id: 'later', at: 101, kind: 'activity', activity: 'rest', characters: [1], origin: 'offline_rules', message: '合成休息' }];
    expect(livingBubble(g, 1, 102, true, null, receipts)).toBeNull();
    expect(livingBubble(g, 1, 103, true, 102, receipts)).toEqual({ kind: 'history', text: '合成台词甲' });
  });

  it('does not show an absent companion or an unreturned private record', () => {
    const g = sample();
    expect(livingBubble(g, 99, 100, true, null, receipts)).toBeNull();
    expect(livingBubble(g, 1, 100, false, null, receipts)).toBeNull();
  });

  it('shows no speech while paused instead of jumping back to the first sentence', () => {
    const g = sample(); g.events = [exchange()];
    expect(livingBubble(g, 2, 104, true, null, receipts)).toEqual({ kind: 'dialogue', text: '合成台词乙' });
    for (const id of [1, 2]) {
      expect(livingBubble(g, id, 104, false, null, receipts)).toBeNull();
      expect(livingBubble(g, id, 504, false, 500, receipts)).toBeNull();
    }
  });

  it('uses the latest area conversation for every participant rather than simultaneously replaying another person’s old round', () => {
    const g = sample();
    g.events = [exchange(), { ...exchange(), id: 'newer', at: 102, characters: [1], lines: [{ character_id: 1, name: '合成甲', text: '新一轮真实保存的台词' }] }];
    const before = JSON.stringify(g);
    expect(livingBubble(g, 1, 103, true, null, receipts)).toEqual({ kind: 'dialogue', text: '新一轮真实保存的台词' });
    expect(livingBubble(g, 2, 104, true, null, receipts)).toBeNull();
    expect(livingBubble(g, 2, 504, true, 500, receipts)).toBeNull();
    expect(JSON.stringify(g)).toBe(before);
  });
});
