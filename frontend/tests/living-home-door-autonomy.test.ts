import { describe, expect, it } from 'vitest';
import { createHomeDoorAutonomy, type HomeAutonomousDoor, type HomeDoorAutonomyInput } from '../lib/living-home-door-autonomy';
import type { JourneyDoorId } from '../lib/living-home-journey';

const ENTRY: JourneyDoorId = 'home-main-entry-door', ROOM: JourneyDoorId = 'home-room-connection-door';
const door = (id: JourneyDoorId, open = false, blocked = false): HomeAutonomousDoor => ({ id, open, blocked });
const frame = (doors: readonly HomeAutonomousDoor[], requests: readonly JourneyDoorId[] = [], overrides: Partial<HomeDoorAutonomyInput> = {}): HomeDoorAutonomyInput => ({ delta: .1, moving: true, enabled: true, doors, requests, ...overrides });

describe('local companion-owned home doors', () => {
  it('honours an explicit clear-bay closure request after the ordinary clear delay',()=>{
    const auto=createHomeDoorAutonomy(),input=()=>frame([door(ENTRY,true)],[],{closeRequests:[ENTRY]});
    for(let i=0;i<7;i++)expect(auto.step(input())).toEqual([]);
    expect(auto.step(input())).toEqual([{door:ENTRY,open:false}]);
  });

  it('clear-bay closure keeps manual cooldown, body clearance, and crossing requests authoritative',()=>{
    const auto=createHomeDoorAutonomy();auto.manual(ENTRY);
    for(let i=0;i<19;i++)expect(auto.step(frame([door(ENTRY,true)],[],{closeRequests:[ENTRY]}))).toEqual([]);
    for(let i=0;i<10;i++)expect(auto.step(frame([door(ENTRY,true,true)],[],{closeRequests:[ENTRY]}))).toEqual([]);
    for(let i=0;i<10;i++)expect(auto.step(frame([door(ENTRY,true)],[ENTRY],{closeRequests:[ENTRY]}))).toEqual([]);
    for(let i=0;i<7;i++)expect(auto.step(frame([door(ENTRY,true)],[],{closeRequests:[ENTRY]}))).toEqual([]);
    expect(auto.step(frame([door(ENTRY,true)],[],{closeRequests:[ENTRY]}))).toEqual([{door:ENTRY,open:false}]);
  });
  it('opens only the requested clear house door, in a stable order', () => {
    const auto = createHomeDoorAutonomy();
    expect(auto.step(frame([door(ROOM), door(ENTRY)], [ENTRY]))).toEqual([{ door: ENTRY, open: true }]);
    expect(auto.step(frame([door(ROOM), door(ENTRY, true)], [ROOM, ENTRY]))).toEqual([{ door: ROOM, open: true }]);
  });

  it('never claims or closes a door that was already open', () => {
    const auto = createHomeDoorAutonomy();
    expect(auto.step(frame([door(ENTRY, true)], [ENTRY]))).toEqual([]);
    for (let i = 0; i < 30; i++) expect(auto.step(frame([door(ENTRY, true)]))).toEqual([]);
  });

  it('closes its own door only after the whole clear delay', () => {
    const auto = createHomeDoorAutonomy(); auto.step(frame([door(ENTRY)], [ENTRY]));
    for (let i = 0; i < 7; i++) expect(auto.step(frame([door(ENTRY, true)]))).toEqual([]);
    expect(auto.step(frame([door(ENTRY, true)]))).toEqual([{ door: ENTRY, open: false }]);
    expect(auto.step(frame([door(ENTRY, false)]))).toEqual([]);
  });

  it('resets the close delay for a continuing request or any body in the door arc', () => {
    const auto = createHomeDoorAutonomy(); auto.step(frame([door(ENTRY)], [ENTRY]));
    for (let i = 0; i < 6; i++) auto.step(frame([door(ENTRY, true)]));
    for (let i = 0; i < 20; i++) expect(auto.step(frame([door(ENTRY, true, true)]))).toEqual([]);
    for (let i = 0; i < 7; i++) expect(auto.step(frame([door(ENTRY, true)]))).toEqual([]);
    expect(auto.step(frame([door(ENTRY, true)], [ENTRY]))).toEqual([]);
    for (let i = 0; i < 7; i++) expect(auto.step(frame([door(ENTRY, true)]))).toEqual([]);
    expect(auto.step(frame([door(ENTRY, true)]))).toEqual([{ door: ENTRY, open: false }]);
  });

  it('waits for the opening arc to become clear rather than opening through a body', () => {
    const auto = createHomeDoorAutonomy();
    for (let i = 0; i < 30; i++) expect(auto.step(frame([door(ROOM, false, true)], [ROOM]))).toEqual([]);
    expect(auto.step(frame([door(ROOM)], [ROOM]))).toEqual([{ door: ROOM, open: true }]);
  });

  it('manual control cancels automatic closing ownership', () => {
    const auto = createHomeDoorAutonomy(); auto.step(frame([door(ENTRY)], [ENTRY])); auto.manual(ENTRY);
    for (let i = 0; i < 50; i++) expect(auto.step(frame([door(ENTRY, true)]))).toEqual([]);
  });

  it('respects two seconds of manual cooldown before a new request can reopen', () => {
    const auto = createHomeDoorAutonomy(); auto.manual(ROOM);
    for (let i = 0; i < 19; i++) expect(auto.step(frame([door(ROOM)], [ROOM]))).toEqual([]);
    expect(auto.step(frame([door(ROOM)], [ROOM]))).toEqual([{ door: ROOM, open: true }]);
  });

  it('pause and disabled operation neither act nor advance close or manual timers', () => {
    const auto = createHomeDoorAutonomy(); auto.step(frame([door(ENTRY)], [ENTRY])); auto.manual(ROOM);
    for (let i = 0; i < 4; i++) auto.step(frame([door(ENTRY, true), door(ROOM)], [ROOM]));
    for (const overrides of [{ delta: 100, moving: false }, { delta: 0 }, { delta: 100, enabled: false }]) {
      expect(auto.step(frame([door(ENTRY, true), door(ROOM)], [ROOM], overrides))).toEqual([]);
    }
    for (let i = 0; i < 3; i++) expect(auto.step(frame([door(ENTRY, true), door(ROOM)], [ROOM]))).toEqual([]);
    expect(auto.step(frame([door(ENTRY, true), door(ROOM)], [ROOM]))).toEqual([{ door: ENTRY, open: false }]);
    for (let i = 0; i < 11; i++) expect(auto.step(frame([door(ENTRY), door(ROOM)], [ROOM]))).toEqual([]);
    expect(auto.step(frame([door(ENTRY), door(ROOM)], [ROOM]))).toEqual([{ door: ROOM, open: true }]);
  });

  it('does not catch up after a long frame and ignores invalid delta', () => {
    const auto = createHomeDoorAutonomy(); auto.step(frame([door(ENTRY)], [ENTRY]));
    for (const delta of [NaN, Infinity, -1, 0]) expect(auto.step(frame([door(ENTRY, true)], [], { delta }))).toEqual([]);
    for (let i = 0; i < 7; i++) expect(auto.step(frame([door(ENTRY, true)], [], { delta: 60 }))).toEqual([]);
    expect(auto.step(frame([door(ENTRY, true)], [], { delta: 60 }))).toEqual([{ door: ENTRY, open: false }]);
  });

  it('fails closed on missing or duplicated door evidence without consuming clear time', () => {
    const auto = createHomeDoorAutonomy(); auto.step(frame([door(ENTRY)], [ENTRY]));
    for (let i = 0; i < 20; i++) {
      expect(auto.step(frame([]))).toEqual([]);
      expect(auto.step(frame([door(ENTRY, true), door(ENTRY, false)]))).toEqual([]);
    }
    for (let i = 0; i < 7; i++) expect(auto.step(frame([door(ENTRY, true)]))).toEqual([]);
    expect(auto.step(frame([door(ENTRY, true)]))).toEqual([{ door: ENTRY, open: false }]);
  });

  it('reset releases ownership and manual cooldown, and doors have independent timers', () => {
    const auto = createHomeDoorAutonomy();
    auto.step(frame([door(ENTRY), door(ROOM)], [ENTRY, ROOM])); auto.manual(ROOM);
    for (let i = 0; i < 7; i++) expect(auto.step(frame([door(ENTRY, true), door(ROOM, true)]))).toEqual([]);
    expect(auto.step(frame([door(ENTRY, true), door(ROOM, true)]))).toEqual([{ door: ENTRY, open: false }]);
    auto.reset();
    for (let i = 0; i < 10; i++) expect(auto.step(frame([door(ENTRY, true), door(ROOM, true)]))).toEqual([]);
    expect(auto.step(frame([door(ROOM)], [ROOM]))).toEqual([{ door: ROOM, open: true }]);
  });
});
