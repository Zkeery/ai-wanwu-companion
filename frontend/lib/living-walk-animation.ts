/** Distance-driven local walking pose; no clocks, network, or activity state changes. */
export type LivingWalkSample = Readonly<{
  position: Readonly<{ x: number; z: number }>;
  targetYaw: number;
  delta: number;
  moving: boolean;
  active: boolean;
}>;
export type LivingWalkPose = Readonly<{ yaw: number; stride: number; arm: number; bob: number; lean: number }>;
type WalkState = { x: number; z: number; phase: number; amplitude: number; pose: LivingWalkPose };
const TAU = Math.PI * 2;
const STRIDE_DISTANCE = .9;
const MAX_TURN_SPEED = 3.6;
const neutral = (yaw: number): LivingWalkPose => ({ yaw, stride: 0, arm: 0, bob: 0, lean: 0 });

export function createLivingWalkAnimation() {
  const states = new Map<number, WalkState>();
  function sample(id: number, input: LivingWalkSample): LivingWalkPose {
    const targetYaw = Number.isFinite(input.targetYaw) ? input.targetYaw : 0;
    if (!input.active) { states.delete(id); return neutral(targetYaw); }
    const validPosition = Number.isFinite(input.position.x) && Number.isFinite(input.position.z);
    let state = states.get(id);
    if (!state) {
      state = { x: validPosition ? input.position.x : 0, z: validPosition ? input.position.z : 0, phase: 0, amplitude: 0, pose: neutral(targetYaw) };
      states.set(id, state);
      return state.pose;
    }
    const travelled = validPosition ? Math.hypot(input.position.x - state.x, input.position.z - state.z) : 0;
    // Refresh the sampling baseline even during pause: resuming must not catch up
    // to positions observed while the animation was frozen.
    if (validPosition) { state.x = input.position.x; state.z = input.position.z; }
    if (!Number.isFinite(input.delta) || input.delta <= 0) return state.pose;

    const moving = input.moving && travelled > 1e-7;
    if (moving) state.phase = (state.phase + travelled / STRIDE_DISTANCE * TAU) % TAU;
    const amplitude = moving ? Math.min(1, travelled / input.delta / .6) : 0;
    state.amplitude += (amplitude - state.amplitude) * (1 - Math.exp(-10 * input.delta));
    if (state.amplitude < 1e-5) state.amplitude = 0;
    const turn = Math.atan2(Math.sin(targetYaw - state.pose.yaw), Math.cos(targetYaw - state.pose.yaw));
    const maxTurn = MAX_TURN_SPEED * input.delta;
    const yaw = state.pose.yaw + Math.max(-maxTurn, Math.min(maxTurn, turn));
    const swing = Math.sin(state.phase) * state.amplitude;
    state.pose = { yaw, stride: swing * .42, arm: swing * .11, bob: Math.abs(Math.sin(state.phase)) * state.amplitude * .014, lean: swing * .025 };
    return state.pose;
  }
  function reset(id?: number) { if (id === undefined) states.clear(); else states.delete(id); }
  return { sample, reset };
}
