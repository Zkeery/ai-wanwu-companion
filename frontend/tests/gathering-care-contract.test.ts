import { describe, expect, it } from 'vitest';
import { parseGathering } from '@/lib/gatherings';

function snapshot(item: Record<string, unknown>) {
  return {
    id: 'synthetic-space', title: '合成照料验证', scene_type: 'home', revision: 2,
    closed: false, is_manager: true, me: 'synthetic-owner', invitation: null,
    members: [], companions: [], items: [{ id: 'synthetic-tree', kind: 'tree', x: .4, y: .5,
      mine: true, contributor_name: '合成成员', growth_status: 'growing', ...item }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false,
    season: { current_season: null },
  };
}

describe('gathering care response contract', () => {
  it('retains the authoritative growth stage and care coverage without changing saved layout', () => {
    const source = snapshot({ stage: 'growing', care_remaining_seconds: 86399.5, flipped: true });
    const before = JSON.stringify(source);
    expect(parseGathering(source).items[0]).toEqual({
      id: 'synthetic-tree', kind: 'tree', x: .4, y: .5, mine: true,
      contributor_name: '合成成员', growth_status: 'growing', stage: 'growing',
      care_remaining_seconds: 86399.5, flipped: true,
    });
    expect(JSON.stringify(source)).toBe(before);
  });

  it('keeps old server responses valid without inventing care or growth evidence', () => {
    const item = parseGathering(snapshot({})).items[0];
    expect(item).not.toHaveProperty('stage');
    expect(item).not.toHaveProperty('care_remaining_seconds');
    expect(item.growth_status).toBe('growing');
  });

  it('preserves zero remaining coverage instead of treating it as missing', () => {
    expect(parseGathering(snapshot({ stage: 'planted', care_remaining_seconds: 0,
      growth_status: 'needs_care' })).items[0]).toMatchObject({ stage: 'planted',
      care_remaining_seconds: 0, growth_status: 'needs_care' });
  });

  it('accepts null for furniture that does not grow', () => {
    expect(parseGathering(snapshot({ kind: 'bench', stage: null, care_remaining_seconds: null,
      growth_status: null })).items[0]).toMatchObject({ kind: 'bench', stage: null,
      care_remaining_seconds: null, growth_status: null });
  });

  it.each([NaN, Infinity, -1, '86400', false, {}])('rejects invalid care coverage %j', value => {
    expect(() => parseGathering(snapshot({ care_remaining_seconds: value }))).toThrow('共同生活数据格式不正确');
  });

  it.each([0, false, {}])('rejects malformed growth stage %j', value => {
    expect(() => parseGathering(snapshot({ stage: value }))).toThrow('共同生活数据格式不正确');
  });
});
