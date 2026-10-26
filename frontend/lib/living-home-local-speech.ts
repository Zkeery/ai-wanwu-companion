export type HomeLocalSpeechHost = Readonly<{
  synthesis: Pick<SpeechSynthesis, 'getVoices' | 'speak' | 'cancel' | 'addEventListener' | 'removeEventListener'> & Partial<Pick<SpeechSynthesis, 'speaking' | 'pending'>>;
  createUtterance: (text: string) => SpeechSynthesisUtterance;
}>;
export type HomeLocalSpeechCaption = Readonly<{ key: string; text: string; actorId: number }>;
export type HomeLocalSpeechSnapshot = Readonly<{
  enabled: boolean; available: boolean; speaking: boolean; disposed: boolean;
  status: 'off' | 'unavailable' | 'ready' | 'speaking' | 'disposed';
  voiceName: string | null; lang: string | null; localOnly: true; seenKeys: number;
  currentCaption: HomeLocalSpeechCaption | null; pendingCount: 0 | 1;
  clipPlayback?: Readonly<{ paused: boolean; currentTime: number; duration: number | null; errorCode: number | null }>;
  lastPlayError?: string | null;
}>;

function browserHost(): HomeLocalSpeechHost | null {
  if (typeof window === 'undefined' || !window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function') return null;
  const synthesis = window.speechSynthesis;
  return { synthesis, createUtterance: text => new window.SpeechSynthesisUtterance(text) };
}
function isLocalChinese(voice: SpeechSynthesisVoice) { return voice.localService === true && /^zh(?:[-_]|$)/i.test(voice.lang); }

/** Local device speech only. The caller owns preview, visibility and freshness
 * gates. One fresh pending caption may follow the current one within 8 seconds.
 */
export function createHomeLocalSpeech(injectedHost?: HomeLocalSpeechHost | null) {
  let host = injectedHost ?? null, resolved = injectedHost !== undefined, enabled = false, desired = false, disposed = false;
  let voice: SpeechSynthesisVoice | null = null, current: SpeechSynthesisUtterance | null = null;
  let currentCaption: HomeLocalSpeechCaption | null = null, pending: { caption: HomeLocalSpeechCaption; deadline: number } | null = null;
  let changed: (() => void) | null = null;
  const seen = new Set<string>();
  function detach() {
    if (changed && host) { try { host.synthesis.removeEventListener('voiceschanged', changed); } catch { /* unavailable browser host */ } }
    changed = null;
  }
  function cancel() {
    const utterance = current; current = null; currentCaption = null; pending = null;
    if (utterance) { utterance.onend = null; utterance.onerror = null; }
    if (host && (enabled || utterance)) { try { host.synthesis.cancel(); } catch { /* local speech service stopped */ } }
  }
  function selectVoice() {
    let voices: SpeechSynthesisVoice[] = [];
    try { voices = host?.synthesis.getVoices() ?? []; } catch { /* no local voice service */ }
    const local = voices.filter(isLocalChinese);
    voice = local.find(v => /^zh[-_]CN$/i.test(v.lang)) ?? local.find(v => v.default) ?? local[0] ?? null;
    enabled = desired && !!voice && !disposed;
  }
  function enable() {
    if (disposed) return false;
    desired = true; detach();
    if (!resolved) { resolved = true; try { host = browserHost(); } catch { host = null; } }
    selectVoice();
    if (!voice && host) {
      changed = () => { detach(); if (desired && !disposed) selectVoice(); };
      try { host.synthesis.addEventListener('voiceschanged', changed, { once: true }); } catch { changed = null; }
    }
    return enabled;
  }
  function speak(caption: HomeLocalSpeechCaption) {
    if (!enabled || !host || !voice || !isLocalChinese(voice) || disposed) return false;
    let utterance: SpeechSynthesisUtterance;
    try { utterance = host.createUtterance(caption.text); } catch { return false; }
    utterance.voice = voice; utterance.lang = voice.lang; utterance.rate = 1; utterance.volume = 1;
    utterance.pitch = Math.abs(Math.trunc(caption.actorId)) % 2 === 0 ? .98 : 1.06;
    current = utterance; currentCaption = caption;
    const finish = () => {
      if (current !== utterance) return;
      current = null; currentCaption = null; utterance.onend = null; utterance.onerror = null;
      const next = pending; pending = null;
      if (next && Date.now() <= next.deadline) speak(next.caption);
    };
    utterance.onend = finish; utterance.onerror = finish;
    try { host.synthesis.speak(utterance); return true; }
    catch { finish(); return false; }
  }
  function say(caption: HomeLocalSpeechCaption) {
    if (disposed || !caption || typeof caption.key !== 'string' || !caption.key.trim() || caption.key.length > 256) return false;
    if (seen.has(caption.key)) return false;
    seen.add(caption.key);
    if (!enabled || !host || !voice || !isLocalChinese(voice) || typeof caption.text !== 'string' || !Number.isFinite(caption.actorId)) return false;
    const text = Array.from(caption.text.replace(/\s+/g, ' ').trim()).slice(0, 160).join('');
    if (!text) return false;
    const normalized = Object.freeze({ key: caption.key, text, actorId: caption.actorId });
    if (current) {
      if (pending) return false;
      pending = { caption: normalized, deadline: Date.now() + 8_000 }; return true;
    }
    if (host.synthesis.speaking || host.synthesis.pending) return false;
    return speak(normalized);
  }
  function off() { desired = false; detach(); cancel(); enabled = false; }
  return {
    enable, say,
    /** Drop stale work while preserving opt-in and consumed caption keys. */
    retain(predicate: (caption: HomeLocalSpeechCaption) => boolean): void {
      if (currentCaption && !predicate(currentCaption)) cancel();
      else if (pending && !predicate(pending.caption)) pending = null;
    },
    /** Cancel now, keep consumed keys and opt-in. Call say only after resuming. */
    pause() { cancel(); },
    off,
    dispose() { if (disposed) return; off(); disposed = true; seen.clear(); voice = null; },
    getSnapshot(): HomeLocalSpeechSnapshot {
      return Object.freeze({ enabled, available: !!voice, speaking: !!current, disposed,
        status: disposed ? 'disposed' : !desired ? 'off' : !enabled ? 'unavailable' : current ? 'speaking' : 'ready',
        voiceName: voice?.name ?? null, lang: voice?.lang ?? null, localOnly: true, seenKeys: seen.size,
        currentCaption, pendingCount: pending ? 1 : 0 });
    },
  };
}
