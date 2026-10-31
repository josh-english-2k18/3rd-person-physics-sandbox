import type { Vector3 } from 'three';

/**
 * Procedural sound: every effect is synthesized with WebAudio (no audio assets).
 * Gunshots layer a noise crack, a low body thump and a tail through a generated reverb.
 */
export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private reverb!: ConvolverNode;
  private noise!: AudioBuffer;
  private listener = { x: 0, y: 0, z: 0 };

  /** Must be called from a user gesture. */
  resume(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      const compressor = this.ctx.createDynamicsCompressor();
      compressor.threshold.value = -14;
      compressor.ratio.value = 4;
      this.master.connect(compressor).connect(this.ctx.destination);
      this.reverb = this.ctx.createConvolver();
      this.reverb.buffer = this.impulse(2.2);
      const wet = this.ctx.createGain();
      wet.gain.value = 0.28;
      this.reverb.connect(wet).connect(this.master);
      this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    void this.ctx.resume();
  }

  setListener(p: Vector3): void {
    this.listener = { x: p.x, y: p.y, z: p.z };
  }

  private impulse(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const length = ctx.sampleRate * seconds;
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3.2);
    }
    return buffer;
  }

  private attenuation(at?: Vector3): number {
    if (!at) return 1;
    const d = Math.hypot(at.x - this.listener.x, at.y - this.listener.y, at.z - this.listener.z);
    return 1 / (1 + d * 0.12);
  }

  private noiseBurst(start: number, duration: number, filter: BiquadFilterType, freq: number, q: number, gain: number, sweepTo?: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(freq, start);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, start + duration);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    src.connect(f).connect(g);
    g.connect(this.master);
    g.connect(this.reverb);
    src.start(start, Math.random() * 0.5, duration + 0.05);
  }

  private tone(start: number, duration: number, from: number, to: number, gain: number, type: OscillatorType = 'sine') {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, start);
    o.frequency.exponentialRampToValueAtTime(to, start + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    o.connect(g);
    g.connect(this.master);
    g.connect(this.reverb);
    o.start(start);
    o.stop(start + duration + 0.05);
  }

  gunshot(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 0.06, 'highpass', 1800, 0.7, 0.9);
    this.noiseBurst(t, 0.22, 'lowpass', 2600, 0.8, 0.8, 300);
    this.tone(t, 0.16, 140, 42, 0.9);
    this.noiseBurst(t + 0.02, 0.5, 'bandpass', 700, 0.6, 0.12, 200);
  }

  impact(at: Vector3, metal: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const a = this.attenuation(at);
    if (metal) {
      this.tone(t, 0.35, 1900 + Math.random() * 700, 1500, 0.22 * a, 'triangle');
      this.tone(t, 0.25, 3100 + Math.random() * 500, 2600, 0.08 * a, 'sine');
    }
    this.noiseBurst(t, 0.07, 'bandpass', metal ? 3000 : 1200, 1.2, 0.35 * a);
  }

  explosion(at: Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const a = Math.max(0.35, this.attenuation(at));
    this.noiseBurst(t, 1.8, 'lowpass', 1800, 0.7, 1.4 * a, 60);
    this.tone(t, 1.0, 90, 24, 1.3 * a);
    this.noiseBurst(t, 0.12, 'highpass', 1200, 0.5, 0.8 * a);
  }

  shatter(at: Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const a = this.attenuation(at);
    for (let i = 0; i < 6; i++) this.tone(t + i * 0.02 + Math.random() * 0.03, 0.25, 2500 + Math.random() * 3000, 1800, 0.06 * a, 'triangle');
    this.noiseBurst(t, 0.4, 'highpass', 4000, 0.6, 0.35 * a);
  }

  crunch(at: Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const a = this.attenuation(at);
    this.noiseBurst(t, 0.25, 'lowpass', 900, 1, 0.6 * a, 200);
    this.tone(t, 0.12, 180, 60, 0.4 * a, 'triangle');
  }

  /** Brass casing hitting the floor. */
  shell(at: Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const a = this.attenuation(at) * 0.7;
    const pitch = 4200 + Math.random() * 1800;
    this.tone(t, 0.12, pitch, pitch * 0.92, 0.05 * a, 'triangle');
    this.tone(t + 0.07 + Math.random() * 0.04, 0.08, pitch * 1.1, pitch, 0.025 * a, 'triangle');
  }

  dryFire(): void {
    if (!this.ctx) return;
    this.noiseBurst(this.ctx.currentTime, 0.03, 'highpass', 3000, 2, 0.25);
  }

  reload(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t + 0.15, 0.05, 'bandpass', 2000, 3, 0.4);
    this.noiseBurst(t + 0.75, 0.06, 'bandpass', 1500, 3, 0.5);
    this.noiseBurst(t + 1.25, 0.05, 'bandpass', 2500, 4, 0.5);
  }

  footstep(at: Vector3, weight: number): void {
    if (!this.ctx) return;
    const a = this.attenuation(at) * weight;
    this.noiseBurst(this.ctx.currentTime, 0.09, 'lowpass', 500 + Math.random() * 300, 1, 0.16 * a);
  }
}
