/** Pure local television time and physical remote-button edges. No media or timers. */
export const HOME_TELEVISION_CHANNEL_NAMES = ['田园风景', '趣味动画', '乡村美食'] as const;
export type HomeTelevisionChannel = 0 | 1 | 2;
export type HomeTelevisionChannelsSnapshot = Readonly<{
  channel: HomeTelevisionChannel;
  name: typeof HOME_TELEVISION_CHANNEL_NAMES[number];
  elapsed: number;
  /** Discrete channel/reset revision; ordinary playback time does not increment it. */
  revision: number;
}>;
export type HomeTelevisionChannelsStep = Readonly<{
  elapsed: number;
  moving: boolean;
  powered: boolean;
  remote: Readonly<{ heldByActorId: number | null; buttonPressed: boolean }>;
}>;
export function createHomeTelevisionChannels() {
  let disposed = false, lastElapsed: number | null = null;
  let heldByActorId: number | null = null, pressed = false;
  let channel: HomeTelevisionChannel = 0, programmeElapsed = 0, revision = 0;
  const publish = (): HomeTelevisionChannelsSnapshot => Object.freeze({ channel,
    name: HOME_TELEVISION_CHANNEL_NAMES[channel], elapsed: programmeElapsed, revision });
  let snapshot = publish();
  function actorId(input: HomeTelevisionChannelsStep) {
    const value = input.remote?.heldByActorId;
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  function baseline(input?: HomeTelevisionChannelsStep) {
    heldByActorId = input ? actorId(input) : null;
    pressed = input?.remote?.buttonPressed === true;
  }
  function step(input: HomeTelevisionChannelsStep): HomeTelevisionChannelsSnapshot {
    if (disposed) return snapshot;
    if (!input.moving || !input.powered || !Number.isFinite(input.elapsed) || input.elapsed < 0) {
      lastElapsed = null; baseline(); return snapshot;
    }
    const before = lastElapsed;
    lastElapsed = input.elapsed;
    if (before === null || input.elapsed <= before || input.elapsed - before > .75) {
      baseline(input); return snapshot;
    }
    // A television keeps playing while nobody is holding its remote.
    programmeElapsed += Math.min(.1, input.elapsed - before);
    const nextActor = actorId(input), nextPressed = input.remote?.buttonPressed === true;
    if (nextActor === null || nextActor !== heldByActorId) baseline(input);
    else {
      if (nextPressed && !pressed) {
        channel = ((channel + 1) % 3) as HomeTelevisionChannel;
        programmeElapsed = 0; revision++;
      }
      pressed = nextPressed;
    }
    snapshot = publish(); return snapshot;
  }
  return {
    step,
    getSnapshot: () => snapshot,
    reset() {
      if (disposed) return;
      channel = 0; programmeElapsed = 0; revision++;
      lastElapsed = null; baseline(); snapshot = publish();
    },
    dispose() { if (!disposed) { disposed = true; lastElapsed = null; baseline(); } },
  };
}
