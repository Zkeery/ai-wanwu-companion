import {expect, it, vi} from 'vitest';
import {createHomeJourneyController, type JourneyContext, type JourneyPose} from '@/lib/living-home-journey';
import {createLivingNavigation} from '@/lib/living-navigation';

it('rechecks a pure vertical bed-transfer frame after clearance changes and retains the real pose when rejected', () => {
  const controller = createHomeJourneyController(), graph = createLivingNavigation({bounds: {minX: -5, maxX: 5, minZ: -5, maxZ: 5}, blocked: [], clearance: .3});
  const lying: JourneyPose = {x: 0, y: .66, z: 0, yaw: 0, tilt: -1.26, scale: .9, area: 'bedroom', contact: 'sleep'};
  const standing: JourneyPose = {x: 0, y: 0, z: 2, yaw: 0, tilt: 0, scale: 1, area: 'bedroom', contact: null};
  controller.reconcile(5, {key: 'bed', pose: lying, approach: standing}, lying);
  controller.reconcile(5, {key: 'observe', pose: standing, approach: standing}, lying);
  const context: JourneyContext = {coordinateContacts: true, radius: .3, revision: 1,
    plan: (from, to) => graph.planTo({from, to, id: 5}), isClear: () => true, portalClear: () => true, doorOpen: () => true,
    isContactClear: () => true, contactPath: (from, to) => [{pose: from, blend: 1},
      {pose: {...from, y: 1, tilt: 0, scale: 1}, blend: 0}, {pose: {...to, y: 1}, blend: 0}, {pose: to, blend: 0}]};
  const first = controller.prepare(5, .1, context)!; controller.commit(5, first.desired, .1);
  const before = controller.get(5)!;
  expect(before.pose.y).toBeGreaterThan(lying.y);
  const dynamicClearance = vi.fn((from: JourneyPose, to: JourneyPose) => to.y <= from.y + 1e-8);
  const next = controller.prepare(5, .1, {...context, revision: 2, isContactClear: dynamicClearance})!;
  expect(next.canTraverse(next.position, next.desired), 'a pure-Y update must validate its actual new pose').toBe(false);
  controller.commit(5, next.desired, .1);
  expect(controller.get(5)!.pose).toEqual(before.pose); expect(controller.get(5)!.contactBlend).toBe(before.contactBlend);
  expect(dynamicClearance.mock.calls.some(([from, to]) => to.y > from.y + 1e-8)).toBe(true);
});

it('retains the captured sleep thickness and seated-leg state when the optional custom path is unavailable', () => {
  const controller = createHomeJourneyController(), graph = createLivingNavigation({bounds: {minX: -5, maxX: 5, minZ: -5, maxZ: 5}, blocked: [], clearance: .3});
  const lying: JourneyPose = {x: 0, y: .66, z: 0, yaw: 0, tilt: -1.26, scale: .9, area: 'bedroom', contact: 'sleep', bedSeat: 0, bedBreathing: 1.008, bedLegLift: .08};
  const standing: JourneyPose = {x: 0, y: 0, z: 2, yaw: 0, tilt: 0, scale: 1, area: 'bedroom', contact: null};
  controller.reconcile(5, {key: 'bed', pose: lying, approach: standing}, lying);
  controller.reconcile(5, {key: 'observe', pose: standing, approach: standing}, lying);
  const context: JourneyContext = {radius: .3, plan: (from, to) => graph.planTo({from, to, id: 5}), isClear: () => true,
    portalClear: () => true, doorOpen: () => true, isContactClear: () => true};
  const proposal = controller.prepare(5, .1, context)!; controller.commit(5, proposal.desired, .1);
  const frame = controller.get(5)!;
  expect(frame.pose.bedBreathing).toBeGreaterThan(1); expect(frame.pose.bedBreathing).toBeLessThan(1.008);
  expect(frame.pose.bedSeat).toBe(0); expect(frame.pose.bedLegLift).toBeGreaterThan(0); expect(frame.pose.bedLegLift).toBeLessThan(.08); expect(frame.contactBlend).toBeGreaterThan(0);
});
