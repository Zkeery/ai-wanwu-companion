import { gatheringCompanionArea, type Gathering } from './gatherings';

export type RoomRestSeat = { characterId: number; index: number; left: number; top: number; extra: boolean };
// Contact points share the room illustration's 1200 x 800 coordinates.
const mainSeats = [628, 520, 736];
const extraSeats = [210, 340, 470, 600, 730, 860, 990];
export function roomRestSeats(g: Gathering): RoomRestSeat[] {
  if (g.scene_type !== 'home') return [];
  return g.companions.filter(c => c.activity === 'rest' && gatheringCompanionArea(g, c) === 'indoor')
    .sort((a, b) => a.id - b.id).slice(0, 10).map((c, index) => ({
      characterId: c.id, index, left: (index < 3 ? mainSeats[index] : extraSeats[index - 3]) / 1200,
      top: (index < 3 ? 438 : 655) / 800, extra: index >= 3,
    }));
}
export function roomRestSeat(g: Gathering, id: number): RoomRestSeat | null {
  return roomRestSeats(g).find(seat => seat.characterId === id) ?? null;
}
