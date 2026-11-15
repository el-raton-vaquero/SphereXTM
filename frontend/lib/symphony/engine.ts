/**
 * StarChord star symphony — Web Audio engine (no dependencies).
 *
 * Signal flow
 *   notes ─┐                                    ┌─ dry ─────────────┐
 *          ├─ voiceBus ─ tone low-pass ─────────┼─ reverb send ─ convolver (IR generated in code) ─┤
 *   ice ───┘                                    └─ delay send ─ feedback delay (filtered) ─────────┤
 *   drone pad ─ drone low-pass (slow LFO) ──────────────────────────────────────────────────────────┤
 *                                       glue compressor ─ limiter ─ master gain ─ destination ◄─────┘
 *
 * Musical mapping (see core.ts):
 *  - A cursor sweeps the 102 bands like a music box, long -> short wavelength and back.
 *    Each band is a pentatonic note (shorter wavelength = higher pitch); its normalised
 *    brightness sets velocity, note length and how long the cursor stays (the rhythm).
 *  - The spectral colour (blue/neutral/red) picks scale and drone chord.
 *  - Detected features (H2O ice, CH4, CO2, CO, PAH) switch the notes in their window to a
 *    distinctive voice and fade in a matching sustained layer.
 *  - A new input spectrum never restarts anything: band values glide toward the new target.
 */
import {
  analyseSpectrum, bandMidi, BANDS, binToBands, detectorPan, encodeWav, KEYS, midiToHz, mulberry32,
  N_BANDS, noteDuration, noteVelocity, REST_BELOW, SCALES, stepLength,
  type Analysis, type FeatureId, type SpectralColour,
} from './core';
import { buildChain, playVoice, type Voice, type VoiceChain } from './voices';

export type Provenance = 'spherex' | 'computed';

/** What a host page hands the symphony: a spectrum sampled at arbitrary wavelengths. */
export interface SymphonySpectrum {
  lambda_um: number[];
  intensity: number[];
  label: string;
  provenance: Provenance;
}

export type { Voice };
const FEATURE_VOICE: Record<FeatureId, Voice> = { h2o: 'shimmer', co2: 'bell', co: 'hollow', ch4: 'breath', pah: 'glow' };

export interface VisualState {
  playing: boolean;
  /** Band index the cursor is on (-1 when stopped). */
  cursor: number;
  /** Per-band glow 0..1 of notes currently sounding. */
  lit: Float32Array;
  /** Smoothed normalised spectrum currently being played (NaN = empty band). */
  bands: Float32Array;
  colour: SpectralColour;
  analysis: Analysis | null;
}

interface NoteEvent { band: number; t0: number; dur: number; vel: number }

type AudioCtor = typeof AudioContext;

const LOOKAHEAD_S = 0.14;
const TICK_MS = 30;
const MAX_VOICES = 26;
const GLIDE_S = 0.45;

export function isAudioSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return !!(w.AudioContext || w.webkitAudioContext);
}

export class SymphonyEngine {
  private ctx: AudioContext | null = null;
  private chain: VoiceChain | null = null;
  private master!: GainNode;
  private preComp!: GainNode;
  private reverbSend!: GainNode;
  private noise!: AudioBuffer;
  private droneOsc: OscillatorNode[] = [];
  private droneGain!: GainNode;
  private droneLfo!: OscillatorNode;
  private layers: Partial<Record<FeatureId, { gain: GainNode; nodes: AudioScheduledSourceNode[] }>> = {};
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;

  private target: Analysis | null = null;
  private cur = new Float32Array(N_BANDS).fill(NaN);
  private colour: SpectralColour = 'neutral';
  private cursor = 0;
  private dir = -1; // start at long wavelength (band 101) moving to short
  private nextStepAt = 0;
  private sweep = 0;
  private events: NoteEvent[] = [];
  private activeVoices: number[] = [];
  private volume = 0.8;
  private muted = false;

  private recorder: ScriptProcessorNode | null = null;
  private recChunks: [Float32Array, Float32Array][] = [];
  private recFrames = 0;
  private recMaxFrames = 0;

  get running(): boolean {
    return !!this.ctx && this.ctx.state !== 'closed' && this.timer !== null;
  }

  /** Must be called from a user gesture (click/tap/key): creates/resumes the AudioContext. */
  async start(): Promise<void> {
    if (typeof window === 'undefined') return;
    if (!this.ctx || this.ctx.state === 'closed') {
      const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
      const Ctor = w.AudioContext || w.webkitAudioContext;
      if (!Ctor) throw new Error('Web Audio is not supported in this browser');
      // iOS: route Web Audio through the "playback" session so the ringer switch does not mute it.
      const nav = navigator as unknown as { audioSession?: { type: string } };
      try { if (nav.audioSession) nav.audioSession.type = 'playback'; } catch { /* not supported */ }
      this.ctx = new Ctor({ latencyHint: 'playback' });
      this.build();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(this.outputLevel(), now + 0.6);
    this.nextStepAt = now + 0.25;
    this.lastTick = now;
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** Fade out and suspend (keeps the graph so play resumes instantly). */
  async pause(): Promise<void> {
    if (!this.ctx) return;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0, now + 0.35);
    await new Promise((r) => setTimeout(r, 400));
    if (this.ctx && this.ctx.state === 'running' && !this.timer) await this.ctx.suspend();
  }

  /** Stop every node and release the AudioContext. Safe to call more than once. */
  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.stopRecordingInternal();
    const ctx = this.ctx;
    this.ctx = null;
    this.chain = null;
    if (!ctx) return;
    try {
      for (const o of this.droneOsc) o.stop();
      this.droneLfo?.stop();
      for (const l of Object.values(this.layers)) l?.nodes.forEach((n) => n.stop());
    } catch { /* already stopped */ }
    this.layers = {};
    this.droneOsc = [];
    void ctx.close().catch(() => {});
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    this.applyLevel();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyLevel();
  }

  /** Feed a new spectrum. null = silence the melody (the pad keeps breathing). Glides, never restarts. */
  setSpectrum(s: SymphonySpectrum | null): Analysis | null {
    if (!s || !s.lambda_um?.length) {
      this.target = null;
      return null;
    }
    const bands = binToBands(s.lambda_um, s.intensity);
    const a = analyseSpectrum(bands, this.target ? this.colour : undefined);
    this.target = a;
    if (this.ctx) this.applyTimbre(a);
    else this.colour = a.colour;
    return a;
  }

  getVisual(): VisualState {
    const lit = new Float32Array(N_BANDS);
    const now = this.ctx?.currentTime ?? 0;
    for (const e of this.events) {
      if (now < e.t0) continue;
      const age = now - e.t0;
      const g = age < 0.05 ? age / 0.05 : Math.exp(-(age - 0.05) / Math.max(0.15, e.dur * 0.45));
      const v = e.vel * g;
      if (v > lit[e.band]) lit[e.band] = v;
    }
    return {
      playing: this.running,
      cursor: this.running ? this.cursor : -1,
      lit,
      bands: this.cur,
      colour: this.colour,
      analysis: this.target,
    };
  }

  // ------------------------------------------------------------ recording

  /** Start capturing the master output (max `maxSeconds`). */
  startRecording(maxSeconds = 60): boolean {
    if (!this.ctx || this.recorder) return false;
    const ctx = this.ctx;
    // ScriptProcessor is deprecated but universally available (Safari included) and only runs while recording.
    const node = ctx.createScriptProcessor(4096, 2, 2);
    this.recChunks = [];
    this.recFrames = 0;
    this.recMaxFrames = Math.round(maxSeconds * ctx.sampleRate);
    node.onaudioprocess = (ev) => {
      if (this.recFrames >= this.recMaxFrames) return;
      const l = ev.inputBuffer.getChannelData(0);
      const r = ev.inputBuffer.numberOfChannels > 1 ? ev.inputBuffer.getChannelData(1) : l;
      this.recChunks.push([new Float32Array(l), new Float32Array(r)]);
      this.recFrames += l.length;
      ev.outputBuffer.getChannelData(0).fill(0);
      if (ev.outputBuffer.numberOfChannels > 1) ev.outputBuffer.getChannelData(1).fill(0);
    };
    this.master.connect(node);
    // A ScriptProcessor only runs when connected to the destination; its output is silence.
    node.connect(ctx.destination);
    this.recorder = node;
    return true;
  }

  get recordingSeconds(): number {
    return this.ctx && this.recorder ? this.recFrames / this.ctx.sampleRate : 0;
  }

  get isRecording(): boolean {
    return !!this.recorder;
  }

  /** Stop capturing and return a 16-bit stereo WAV, or null if nothing was captured. */
  stopRecording(): Blob | null {
    const rate = this.ctx?.sampleRate ?? 48000;
    const chunks = this.stopRecordingInternal();
    if (!chunks.length) return null;
    const total = Math.min(this.recMaxFrames || Infinity, chunks.reduce((s, c) => s + c[0].length, 0));
    const L = new Float32Array(total), R = new Float32Array(total);
    let o = 0;
    for (const [l, r] of chunks) {
      const n = Math.min(l.length, total - o);
      if (n <= 0) break;
      L.set(l.subarray(0, n), o); R.set(r.subarray(0, n), o);
      o += n;
    }
    return new Blob([encodeWav([L, R], rate)], { type: 'audio/wav' });
  }

  private stopRecordingInternal(): [Float32Array, Float32Array][] {
    const chunks = this.recChunks;
    if (this.recorder) {
      try { this.master.disconnect(this.recorder); } catch { /* */ }
      try { this.recorder.disconnect(); } catch { /* */ }
      this.recorder.onaudioprocess = null;
      this.recorder = null;
    }
    this.recChunks = [];
    return chunks;
  }

  // ------------------------------------------------------------ graph

  private outputLevel(): number {
    return this.muted ? 0 : Math.min(1, this.volume * this.volume);
  }

  private applyLevel(): void {
    if (!this.ctx || !this.timer) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(this.outputLevel(), now, 0.08);
  }

  private build(): void {
    const ctx = this.ctx!;
    // Shared chain (voices.ts): compressor + limiter + master, tone filter, reverb, delay.
    const chain = buildChain(ctx, ctx.destination, 0);
    this.chain = chain;
    this.master = chain.master;
    this.preComp = chain.preComp;
    this.reverbSend = chain.reverbSend;
    this.noise = chain.noise;

    this.buildDrone();
    if (this.target) this.applyTimbre(this.target);
  }

  private buildDrone(): void {
    const ctx = this.ctx!;
    const key = KEYS[this.colour];
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    this.droneGain.gain.setTargetAtTime(0.085, ctx.currentTime, 1.5);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 0.7;
    this.droneLfo = ctx.createOscillator();
    this.droneLfo.frequency.value = 0.045;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 220;
    this.droneLfo.connect(lfoAmt).connect(lp.frequency);
    this.droneLfo.start();
    lp.connect(this.droneGain);
    this.droneGain.connect(this.preComp);
    this.droneGain.connect(this.reverbSend);
    const spec: [number, OscillatorType, number, number][] = [
      // semis above root, wave, detune cents, level
      [0, 'sawtooth', -7, 0.32],
      [0, 'sawtooth', 7, 0.32],
      [7, 'triangle', 0, 0.38],
      [12, 'sine', 3, 0.28],
      [this.thirdFor(this.colour), 'sine', -3, 0.16],
    ];
    this.droneOsc = spec.map(([semi, type, det, lvl], i) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = midiToHz(key.root + semi);
      o.detune.value = det;
      const g = ctx.createGain();
      g.gain.value = lvl;
      const p = ctx.createStereoPanner();
      p.pan.value = i % 2 ? 0.35 : -0.35;
      o.connect(g).connect(p).connect(lp);
      o.start();
      return o;
    });
  }

  private thirdFor(c: SpectralColour): number {
    return c === 'blue' ? 16 : c === 'red' ? 15 : 14; // major 10th / minor 10th / added 9th
  }

  private retuneDrone(): void {
    if (!this.ctx || !this.droneOsc.length) return;
    const now = this.ctx.currentTime;
    const root = KEYS[this.colour].root;
    const semis = [0, 0, 7, 12, this.thirdFor(this.colour)];
    this.droneOsc.forEach((o, i) => o.frequency.setTargetAtTime(midiToHz(root + semis[i]), now, 0.9));
  }

  /** Fade feature layers in/out and retune the drone for a new analysis. */
  private applyTimbre(a: Analysis): void {
    if (a.colour !== this.colour) {
      this.colour = a.colour;
      this.retuneDrone();
    }
    for (const f of a.features) this.setLayer(f.id, f.detected ? f.strength : 0);
  }

  private setLayer(id: FeatureId, strength: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let layer = this.layers[id];
    if (!layer && strength <= 0) return;
    if (!layer) {
      layer = this.makeLayer(id);
      this.layers[id] = layer;
    }
    const level = { h2o: 0.05, co2: 0.035, co: 0.045, ch4: 0.05, pah: 0.04 }[id] * strength;
    layer.gain.gain.setTargetAtTime(level, ctx.currentTime, 1.2);
  }

  /** Sustained ice/feature layers: quiet textures that make icy regions sound distinct. */
  private makeLayer(id: FeatureId): { gain: GainNode; nodes: AudioScheduledSourceNode[] } {
    const ctx = this.ctx!;
    const root = KEYS[this.colour].root;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.reverbSend);
    gain.connect(this.preComp);
    const nodes: AudioScheduledSourceNode[] = [];
    const osc = (hz: number, type: OscillatorType, det: number, lvl: number, pan: number) => {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = hz; o.detune.value = det;
      const g = ctx.createGain(); g.gain.value = lvl;
      const p = ctx.createStereoPanner(); p.pan.value = pan;
      o.connect(g).connect(p).connect(gain);
      o.start();
      nodes.push(o);
      return g;
    };
    const tremolo = (target: GainNode, rate: number, depth: number) => {
      const l = ctx.createOscillator(); l.frequency.value = rate;
      const a = ctx.createGain(); a.gain.value = depth;
      l.connect(a).connect(target.gain); l.start(); nodes.push(l);
    };
    if (id === 'h2o') {
      // Shimmer: high detuned partial pairs beating slowly, with a gentle tremolo.
      for (const [semi, pan] of [[36, -0.5], [43, 0.5], [48, -0.2], [52, 0.25]] as const) {
        const g1 = osc(midiToHz(root + semi), 'sine', -9, 0.22, pan);
        osc(midiToHz(root + semi), 'sine', 9, 0.22, -pan);
        tremolo(g1, 4.5 + semi / 20, 0.12);
      }
    } else if (id === 'co2') {
      // Glass: inharmonic partials (bell ratios) held very quietly.
      const f = midiToHz(root + 31);
      osc(f, 'sine', 0, 0.3, -0.3); osc(f * 2.76, 'sine', 0, 0.12, 0.3); osc(f * 5.4, 'sine', 0, 0.05, 0);
    } else if (id === 'co') {
      // Hollow low choir: odd harmonics, slow swell.
      const g = osc(midiToHz(root + 12), 'sine', 0, 0.5, 0);
      osc(midiToHz(root + 19), 'triangle', 4, 0.2, 0.4);
      tremolo(g, 0.11, 0.25);
    } else if (id === 'ch4') {
      // Breath: band-passed noise that swells like wind.
      const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = midiToHz(root + 36); bp.Q.value = 6;
      const g = ctx.createGain(); g.gain.value = 0.8;
      src.connect(bp).connect(g).connect(gain); src.start(); nodes.push(src);
      tremolo(g, 0.08, 0.5);
    } else {
      // PAH glow: a warm open fifth.
      osc(midiToHz(root + 24), 'sine', 0, 0.35, -0.2); osc(midiToHz(root + 31), 'sine', 2, 0.25, 0.2);
    }
    return { gain, nodes };
  }

  // ------------------------------------------------------------ sequencer

  private tick(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const dt = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    this.glide(dt);
    this.events = this.events.filter((e) => e.t0 + e.dur + 0.6 > now);
    this.activeVoices = this.activeVoices.filter((t) => t > now);
    if (this.nextStepAt < now - 0.5) this.nextStepAt = now + 0.05; // tab was throttled: resync
    while (this.nextStepAt < now + LOOKAHEAD_S) this.step(this.nextStepAt);
  }

  private glide(dt: number): void {
    const k = 1 - Math.exp(-dt / GLIDE_S);
    const t = this.target?.norm;
    for (let i = 0; i < N_BANDS; i++) {
      const goal = t ? t[i] : NaN;
      const c = this.cur[i];
      if (!Number.isFinite(goal)) {
        // Fade a band out to empty.
        if (Number.isFinite(c)) this.cur[i] = c < 0.02 ? NaN : c * (1 - k);
      } else {
        this.cur[i] = Number.isFinite(c) ? c + (goal - c) * k : goal * k;
      }
    }
  }

  private step(at: number): void {
    const i = this.cursor;
    const v = this.cur[i];
    const a = this.target;
    // Rhythm: the cursor lingers on bright bands and skips quickly over dark or empty ones.
    let len = stepLength(Number.isFinite(v) ? v : 0);
    if (a && Number.isFinite(v) && v >= REST_BELOW) {
      const rng = mulberry32((a.seed ^ (i * 2654435761) ^ (this.sweep * 40503)) >>> 0);
      // Mid-brightness bands play with a probability so the line breathes; bright ones always speak.
      if (v > 0.5 || rng() < 0.35 + v) {
        const scale = SCALES[KEYS[this.colour].scale];
        const base = KEYS[this.colour].root + 12;
        const midi = bandMidi(i, base, scale);
        const feat = a.features.find((f) => f.detected && f.bands.includes(i));
        const voice: Voice = feat ? FEATURE_VOICE[feat.id] : 'soft';
        const vel = noteVelocity(v);
        const dur = noteDuration(v) * (voice === 'bell' ? 1.4 : 1);
        const humanize = (rng() - 0.5) * 0.012;
        this.playNote(at + Math.max(0, humanize), midi, vel, dur, BANDS[i].detector, voice);
        // Peaks get a quiet octave sparkle.
        if (a.peaks[i] && rng() < 0.6) this.playNote(at + 0.09, midi + 12, vel * 0.35, dur * 0.7, BANDS[i].detector, 'bell');
        this.events.push({ band: i, t0: at, dur, vel });
      }
    } else if (!Number.isFinite(v)) {
      len *= 0.5;
    }
    this.nextStepAt = at + len;
    // Ping-pong sweep through all 102 bands.
    let nxt = i + this.dir;
    if (nxt < 0 || nxt >= N_BANDS) {
      this.dir = -this.dir;
      this.sweep++;
      nxt = i + this.dir;
      this.nextStepAt += 0.5; // breath at the turn
    }
    this.cursor = nxt;
  }

  private playNote(at: number, midi: number, vel: number, dur: number, detector: number, voice: Voice): void {
    if (!this.chain || vel <= 0 || this.activeVoices.length >= MAX_VOICES) return;
    playVoice(this.chain, at, midi, vel, dur, detectorPan(detector), voice);
    this.activeVoices.push(at + dur + 0.4);
  }
}
