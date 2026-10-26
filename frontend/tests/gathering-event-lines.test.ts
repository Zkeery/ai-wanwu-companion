import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gatheringEvent } from '@/lib/gatherings';

const event = () => ({ id: 'synthetic-public-exchange', at: 123, message: '共同交流已保存', kind: 'dialogue', activity: 'talk', characters: [1, 2], origin: 'real_provider' });
const line = () => ({ character_id: 1, name: '合成伙伴', text: '一起看看窗外的景色。' });
beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('saved shared event lines', () => {
  it('retains actual returned shared lines and area without reading or changing another source', () => {
    const raw = { ...event(), area: 'bedroom', lines: [line(), { character_id: 2, name: '合成朋友', text: '好呀，阳光很温暖。' }] };
    const before = JSON.stringify(raw), parsed = gatheringEvent(raw);
    expect(parsed.lines).toEqual(raw.lines);
    expect(parsed.area).toBe('bedroom');
    expect(parsed.origin).toBe('real_provider'); expect(parsed.characters).toEqual([1, 2]);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('accepts historical events without lines or area and does not manufacture a conversation', () => {
    const parsed = gatheringEvent({ id: 'old-event', message: '旧共同记录', at: 100 });
    expect(parsed).toEqual({ id: 'old-event', message: '旧共同记录', at: 100, kind: null, activity: null, characters: [], origin: null });
    expect(parsed).not.toHaveProperty('lines'); expect(parsed).not.toHaveProperty('area');
  });

  it.each(['real_provider', 'offline_rules'])('does not invent missing lines for a saved %s event', origin => {
    expect(gatheringEvent({ ...event(), origin })).not.toHaveProperty('lines');
  });

  it.each(['outdoor', 'indoor', 'bedroom'])('keeps a valid %s shared-event area and an explicitly empty line array', area => {
    const parsed = gatheringEvent({ ...event(), area, lines: [] });
    expect(parsed.area).toBe(area); expect(parsed.lines).toEqual([]);
  });

  it.each([null, {}, 'a line', 1, false])('rejects lines that are not an array %#', lines => {
    expect(() => gatheringEvent({ ...event(), lines })).toThrow();
  });

  it.each([
    null, {}, { ...line(), character_id: '1' }, { ...line(), character_id: Number.NaN },
    { ...line(), character_id: Number.POSITIVE_INFINITY }, { ...line(), name: 1 },
    { ...line(), text: null }, { character_id: 1, name: '缺少文字' },
  ])('rejects malformed shared lines instead of exposing a partial invented sentence %#', value => {
    expect(() => gatheringEvent({ ...event(), lines: [value] })).toThrow();
  });

  it.each([null, 'unknown-room', 7])('rejects an untrusted shared-event area %#', area => {
    expect(() => gatheringEvent({ ...event(), area, lines: [line()] })).toThrow();
  });
});
