import type { JourneyDoorId } from './living-home-journey';

export type HomeAutonomousDoor = Readonly<{ id: JourneyDoorId; open: boolean; blocked: boolean }>;
export type HomeDoorCommand = Readonly<{ door: JourneyDoorId; open: boolean }>;
export type HomeDoorAutonomyInput = Readonly<{
  delta: number;
  moving: boolean;
  enabled: boolean;
  doors: readonly HomeAutonomousDoor[];
  requests: readonly JourneyDoorId[];
  /** A proven free exit bay may need the leaf closed to reach its next aisle. */
  closeRequests?: readonly JourneyDoorId[];
}>;

type DoorState = { owned: boolean; clearSeconds: number; cooldown: number };
const IDS: readonly JourneyDoorId[] = ['home-main-entry-door', 'home-room-connection-door'];
const CLOSE_DELAY = .8, MANUAL_COOLDOWN = 2, EPS = 1e-8;
const isHomeDoor = (id: string): id is JourneyDoorId => IDS.some(door => door === id);

/** Decisions only. The engine supplies the real full door-arc occupancy and applies commands. */
export function createHomeDoorAutonomy() {
  const states = new Map<JourneyDoorId, DoorState>();
  const stateFor = (id: JourneyDoorId) => {
    let state = states.get(id);
    if (!state) { state = { owned: false, clearSeconds: 0, cooldown: 0 }; states.set(id, state); }
    return state;
  };

  function step(input: HomeDoorAutonomyInput): readonly HomeDoorCommand[] {
    if (!input.enabled || !input.moving || !Number.isFinite(input.delta) || input.delta <= 0) return [];
    const dt = Math.min(.1, input.delta), commands: HomeDoorCommand[] = [];
    for (const id of IDS) {
      const entries = input.doors.filter(door => door.id === id);
      // Missing or contradictory geometry is not evidence that a door can move.
      if (entries.length !== 1 || typeof entries[0].open !== 'boolean' || typeof entries[0].blocked !== 'boolean') continue;
      const door = entries[0], state = stateFor(id), requested = input.requests.includes(id);
      state.cooldown = Math.max(0, state.cooldown - dt);
      if (state.cooldown > EPS) { state.clearSeconds = 0; continue; }
      if (requested || door.blocked) {
        state.clearSeconds = 0;
        if (requested && !door.open && !door.blocked) {
          commands.push({ door: id, open: true }); state.owned = true;
        }
        continue;
      }
      if ((!state.owned && !input.closeRequests?.includes(id)) || !door.open) { state.clearSeconds = 0; if (!door.open) state.owned = false; continue; }
      state.clearSeconds += dt;
      if (state.clearSeconds + EPS >= CLOSE_DELAY) {
        commands.push({ door: id, open: false }); state.owned = false; state.clearSeconds = 0;
      }
    }
    return commands;
  }

  function manual(id: JourneyDoorId) {
    if (!isHomeDoor(id)) return;
    states.set(id, { owned: false, clearSeconds: 0, cooldown: MANUAL_COOLDOWN });
  }
  return { step, manual, reset: () => states.clear() };
}
