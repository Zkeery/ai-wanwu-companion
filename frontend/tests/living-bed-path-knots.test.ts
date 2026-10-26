import { expect, it } from 'vitest';
import { createHomeJourneyController, type JourneyContext, type JourneyPose } from '@/lib/living-home-journey';
import { createLivingNavigation } from '@/lib/living-navigation';

it.each([.1, 1 / 60])('executes every checked contact corner and advances from an exact knot at dt=%s', delta => {
  const controller = createHomeJourneyController(), graph = createLivingNavigation({bounds: {minX: -1, maxX: 1, minZ: -1, maxZ: 1}, blocked: [], clearance: .05});
  const lying: JourneyPose = {x: .123456789, y: .04, z: 0, yaw: 0, tilt: 0, scale: 1, area: 'bedroom', contact: 'sleep'};
  const first = {...lying, x: lying.x + .0137}, second = {...first, y: 0}, end: JourneyPose = {...second, x: first.x + .0181, contact: null};
  controller.reconcile(5, {key: 'bed', pose: lying, approach: end}, lying);
  controller.reconcile(5, {key: 'observe', pose: end, approach: end}, lying);
  const context: JourneyContext = {radius: .05, coordinateContacts: true, plan: (from, to) => graph.planTo({from, to, id: 5}),
    isClear: () => true, portalClear: () => true, doorOpen: () => true,
    contactPath: () => [{pose: lying, blend: 1}, {pose: first, blend: 1}, {pose: second, blend: 0}, {pose: end, blend: 0}],
    isContactClear: (from, to) => [Math.abs(from.x - to.x), Math.abs(from.y - to.y), Math.abs(from.z - to.z)].filter(change => change > 1e-9).length <= 1};
  let sawFirst = false, sawSecond = false, steps = 0;
  for (; steps < 200 && controller.get(5)?.active; steps++) {
    const proposal = controller.prepare(5, delta, context)!;
    expect(proposal.canTraverse(proposal.position, proposal.desired), 'never shortcut across a checked right-angle contact corner').toBe(true);
    controller.commit(5, proposal.desired, delta);
    const frame = controller.get(5)!;
    sawFirst ||= Math.abs(frame.pose.x - first.x) < 1e-10 && Math.abs(frame.pose.y - first.y) < 1e-10;
    sawSecond ||= Math.abs(frame.pose.x - second.x) < 1e-10 && Math.abs(frame.pose.y - second.y) < 1e-10;
  }
  expect(sawFirst).toBe(true); expect(sawSecond).toBe(true);
  expect(controller.get(5)?.active, 'an exactly reached knot must release the next checked segment').toBe(false);
  expect(controller.get(5)?.pose).toEqual(end);
});

it('updates a moving destination without restarting an accepted bed exit', () => {
  const controller = createHomeJourneyController(), graph = createLivingNavigation({bounds: {minX: -2, maxX: 2, minZ: -2, maxZ: 2}, blocked: [], clearance: .05});
  const lying: JourneyPose = {x: 0, y: .3, z: 0, yaw: 0, tilt: 0, scale: 1, area: 'bedroom', contact: 'sleep'}, standing: JourneyPose = {...lying, y: 0, z: .4, contact: null};
  controller.reconcile(5, {key: 'bed', pose: lying, approach: standing}, lying);
  controller.reconcile(5, {key: 'observe-0', pose: standing, approach: standing}, lying);
  let pathCalls = 0, latest = standing;
  const context: JourneyContext = {radius: .05, coordinateContacts: true, plan: (from, to) => graph.planTo({from, to, id: 5}), isClear: () => true, portalClear: () => true, doorOpen: () => true, isContactClear: () => true,
    contactPath: (from, to) => {pathCalls++; return [{pose: from, blend: 1}, {pose: {...from, z: .2}, blend: .5}, {pose: to, blend: 0}];}};
  for (let frame = 0; frame < 100 && controller.get(5)?.active; frame++) {
    const before = controller.get(5)!;
    if (before.phase === 'undock') {latest = {...standing, x: .1 + frame * .001}; controller.reconcile(5, {key: 'observe-' + frame, pose: latest, approach: latest}, before.pose);}
    const proposal = controller.prepare(5, .1, context)!; controller.commit(5, proposal.desired, .1);
  }
  expect(pathCalls, 'the same physical bed exit must retain its accepted progress').toBe(1);
  expect(controller.get(5)?.active).toBe(false); expect(controller.get(5)?.pose).toEqual(latest);
});
