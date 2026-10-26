import { describe, expect, it } from 'vitest';
import { roomRestSeats } from '@/lib/living-room-seats';
import type { Gathering } from '@/lib/gatherings';

function room(count: number): Gathering {
  return { scene_type: 'home', companions: Array.from({ length: count }, (_, i) => ({ id: i + 1, activity: 'rest', area: 'indoor', x: .9, y: .1 })) } as Gathering;
}
describe('room rest seat allocation', () => {
  it.each([0, 1, 2, 3, 4, 10])('allocates %i resting companions to distinct sofa support points without touching saved data', count => {
    const g = room(count), before = JSON.stringify(g), seats = roomRestSeats(g);
    expect(seats).toHaveLength(count);
    expect(new Set(seats.map(s => s.left + ':' + s.top)).size).toBe(count);
    for (const a of seats) for (const b of seats) if (a !== b) {
      expect(Math.hypot((a.left-b.left)*1200, (a.top-b.top)*800)).toBeGreaterThanOrEqual(108 - 1e-9);
    }
    expect(seats.filter(s => !s.extra).length).toBe(Math.min(3,count));
    expect(seats.filter(s => s.extra).length).toBe(Math.max(0,count-3));
    expect(roomRestSeats(JSON.parse(before))).toEqual(seats);
    expect(roomRestSeats({ ...g, companions: [...g.companions].reverse() })).toEqual(seats);
    expect(JSON.stringify(g)).toBe(before);
  });
  it('only seats indoor home rest and keeps other activities and regions alone', () => {
    const g = room(5); g.companions[1].activity='talk';g.companions[2].activity='walk';g.companions[3].area='outdoor';delete g.companions[4].area;
    expect(roomRestSeats(g).map(s=>s.characterId)).toEqual([1]);
    expect(roomRestSeats({ ...g, scene_type:'forest' })).toEqual([]);
    expect(roomRestSeats({ ...g, scene_type:'desert' })).toEqual([]);
  });
});
