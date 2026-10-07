const OUTPUT_RATE = 16000;
const MAX_SECONDS = 60;

export function isVSCodeEmbeddedBrowser(userAgent: string): boolean {
  return /\bCode\/[\d.]+\b/.test(userAgent) && /\bElectron\/[\d.]+\b/.test(userAgent);
}

export function encodeMonoWav(chunks: Float32Array[], inputRate: number): Blob {
  if (!Number.isFinite(inputRate) || inputRate <= 0) throw new Error('录音采样率无效，请重新录制。');
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const samples = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
  const frames = Math.min(MAX_SECONDS * OUTPUT_RATE, Math.round(length * OUTPUT_RATE / inputRate));
  const buffer = new ArrayBuffer(44 + frames * 2), view = new DataView(buffer);
  function label(at: number, value: string) { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); }
  label(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); label(8, 'WAVE'); label(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, OUTPUT_RATE, true); view.setUint32(28, OUTPUT_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, 'data'); view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const start = i * inputRate / OUTPUT_RATE;
    const end = Math.min(length, (i + 1) * inputRate / OUTPUT_RATE);
    let sample = 0;
    if (inputRate >= OUTPUT_RATE) {
      const first = Math.floor(start), last = Math.max(first + 1, Math.ceil(end));
      for (let j = first; j < last && j < length; j++) sample += samples[j];
      sample /= Math.min(last, length) - first || 1;
    } else {
      const first = Math.min(length - 1, Math.floor(start)), next = Math.min(length - 1, first + 1);
      sample = samples[first] * (1 - (start - first)) + samples[next] * (start - first);
    }
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export async function startWavCapture(stream: MediaStream): Promise<{ stop: () => Blob; cancel: () => void }> {
  const context = new AudioContext();
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let muted: GainNode | null = null;
  let active = true;
  const chunks: Float32Array[] = [];
  function release() {
    if (!active) return;
    active = false;
    if (processor) { processor.onaudioprocess = null; processor.disconnect(); }
    source?.disconnect(); muted?.disconnect();
    stream.getTracks().forEach(track => track.stop());
    void context.close().catch(() => {});
  }
  try {
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(4096, 1, 1);
    muted = context.createGain(); muted.gain.value = 0;
    processor.onaudioprocess = event => {
      if (active && event.inputBuffer.numberOfChannels) chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor); processor.connect(muted); muted.connect(context.destination);
    await context.resume();
    if (context.state !== 'running') throw new Error('麦克风音频处理未启动，请重新录制。');
    return {
      stop() { release(); return encodeMonoWav(chunks, context.sampleRate); },
      cancel() { release(); },
    };
  } catch (error) { release(); throw error; }
}
