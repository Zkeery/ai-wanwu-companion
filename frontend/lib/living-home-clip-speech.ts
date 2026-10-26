import type { HomeLocalSpeechCaption, HomeLocalSpeechSnapshot } from './living-home-local-speech';

function localClipPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const path = decodeURIComponent(value);
    return value.startsWith('/local-voices/') && path.startsWith('/local-voices/') && path.length > '/local-voices/'.length
      && !path.includes('..') && !/[\\%?#\s]/.test(path) && !Array.from(path).some(char => char.charCodeAt(0) < 32) && !path.includes('//');
  } catch { return false; }
}
function playErrorName(error: unknown) {
  try { const name = (error as { name?: unknown } | null)?.name; if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,47}$/.test(name)) return name; } catch { /* opaque device error */ }
  return 'PlaybackError';
}

/** Fixed local fixture clips, never a system voice or generated speech. */
export function createHomeClipSpeech(clips: Readonly<Record<string, string>>, audioFactory: () => HTMLAudioElement = () => new Audio()) {
  const paths = new Map(Object.entries(clips).filter(([text, path]) => !!text.trim() && Array.from(text).length <= 160 && localClipPath(path)));
  const seen = new Set<string>();
  let audio: HTMLAudioElement | null = null, enabled = false, desired = false, disposed = false, generation = 0;
  let lastPlayError: string | null = null;
  let currentCaption: HomeLocalSpeechCaption | null = null, pending: { caption: HomeLocalSpeechCaption; deadline: number } | null = null;
  function stop(release = false) {
    generation++; currentCaption = null; pending = null;
    if (!audio) return;
    audio.onended = null; audio.onerror = null;
    try { audio.pause(); audio.currentTime = 0; } catch { /* local media service stopped */ }
    if (release) { try { audio.removeAttribute('src'); audio.load(); } catch { /* unavailable media host */ } }
  }
  function enable() {
    if (disposed) return false;
    desired = true;
    if (!paths.size) return false;
    if (!audio) { try { audio = audioFactory(); audio.preload = 'auto'; } catch (error) { audio = null; lastPlayError = playErrorName(error); return false; } }
    lastPlayError = null; enabled = true; return true;
  }
  function speak(caption: HomeLocalSpeechCaption) {
    if (!audio || !enabled || disposed) return false;
    const player = audio, token = ++generation;
    currentCaption = caption;
    const finish = () => {
      if (token !== generation || currentCaption !== caption) return;
      generation++; currentCaption = null; player.onended = null; player.onerror = null;
      try { player.pause(); } catch { /* failed local playback */ }
      const next = pending; pending = null;
      if (next && Date.now() <= next.deadline) speak(next.caption);
    };
    const fail = (error: unknown, media = false) => {
      if (token !== generation || currentCaption !== caption) return;
      lastPlayError = media ? player.error?.code ? 'media:' + player.error.code : 'MediaError' : playErrorName(error);
      finish();
    };
    player.onended = finish; player.onerror = () => fail(null, true);
    try {
      player.src = paths.get(caption.text)!; player.currentTime = 0;
      void Promise.resolve(player.play()).catch(error => fail(error));
      return true;
    } catch (error) { fail(error); return false; }
  }
  function say(caption: HomeLocalSpeechCaption) {
    if (disposed || !caption || typeof caption.key !== 'string' || !caption.key.trim() || caption.key.length > 256 || seen.has(caption.key)) return false;
    seen.add(caption.key);
    if (!enabled || !audio || typeof caption.text !== 'string' || !paths.has(caption.text) || !Number.isFinite(caption.actorId)) return false;
    const normalized = Object.freeze({ key: caption.key, text: caption.text, actorId: caption.actorId });
    if (currentCaption) { if (pending) return false; pending = { caption: normalized, deadline: Date.now() + 8_000 }; return true; }
    return speak(normalized);
  }
  function off() {
    desired = false;
    if (enabled || currentCaption || pending) stop(true);
    enabled = false;
  }
  return {
    enable, say,
    /** Drop stale work while preserving opt-in and consumed caption keys. */
    retain(predicate: (caption: HomeLocalSpeechCaption) => boolean): void {
      if (currentCaption && !predicate(currentCaption)) stop();
      else if (pending && !predicate(pending.caption)) pending = null;
    },
    pause() { stop(); },
    off,
    dispose() { if (disposed) return; off(); disposed = true; audio = null; seen.clear(); },
    getSnapshot(): HomeLocalSpeechSnapshot {
      return Object.freeze({ enabled, available: !disposed && paths.size > 0, speaking: !!currentCaption, disposed,
        status: disposed ? 'disposed' : !desired ? 'off' : !enabled ? 'unavailable' : currentCaption ? 'speaking' : 'ready',
        voiceName: '本地离线示例', lang: 'zh-CN', localOnly: true, seenKeys: seen.size, currentCaption, pendingCount: pending ? 1 : 0,
        clipPlayback: audio ? Object.freeze({ paused: audio.paused, currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
          duration: Number.isFinite(audio.duration) ? audio.duration : null, errorCode: audio.error?.code ?? null }) : undefined,
        lastPlayError });
    },
  };
}
