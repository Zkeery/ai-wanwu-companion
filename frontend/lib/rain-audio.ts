/** A local Web Audio rain source. No network, autoplay, or microphone access. */
export class RainAudio {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  async enable() {
    this.context ??= new AudioContext();
    await this.context.resume();
    if (this.context.state !== 'running') throw new Error('声音未能开启，请再次点击开启声音');
    if (this.source) return;
    const buffer = this.context.createBuffer(1, this.context.sampleRate * 3, this.context.sampleRate);
    const samples = buffer.getChannelData(0); let previous = 0;
    for (let i = 0; i < samples.length; i++) { previous = (previous + (Math.random() * 2 - 1) * 0.02) / 1.02; samples[i] = previous * 3.5; }
    this.source = this.context.createBufferSource(); this.source.buffer = buffer; this.source.loop = true;
    const filter = this.context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 1800;
    this.gain = this.context.createGain(); this.gain.gain.value = 0;
    this.source.connect(filter).connect(this.gain).connect(this.context.destination); this.source.start();
  }
  volume(playing: boolean) { if (this.context && this.gain) this.gain.gain.setTargetAtTime(playing ? 0.3 : 0, this.context.currentTime, 0.08); }
  close() { this.source?.stop(); this.source = null; this.gain = null; void this.context?.close().catch(() => {}); this.context = null; }
}
