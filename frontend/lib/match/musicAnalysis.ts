/**
 * Star Match: what key, tempo and chords is the user's song in? Pure functions, no DOM and no
 * dependencies, so they run in a worker, on the main thread or under Node tests.
 *
 *  - chroma: 12 pitch-class energies from spectral peaks of a Hann-windowed FFT (~185 ms frames,
 *    hop ~46 ms, A4 = 440 Hz, 55 Hz - 5 kHz; peaks on the 3rd/5th/6th/7th overtone of a louder
 *    lower peak attenuated), log-compressed, per frame and averaged;
 *  - key: Krumhansl-Schmuckler, correlation of the mean chroma with the Krumhansl-Kessler major and
 *    minor profiles in all 24 keys; relative major/minor ties are resolved by which tonic chord
 *    the song actually dwells on and starts with;
 *  - tempo: spectral-flux onset envelope -> autocorrelation over 60-180 BPM with a log-normal
 *    prior around 110 BPM (octave errors weighed by the half / double lags), then a fine comb
 *    search over tempo and phase that gives the beat grid;
 *  - chords: mean chroma per half bar, correlated with 24 triad templates (+ no-chord), smoothed
 *    with a Viterbi pass that prefers changes on bar lines, restricted to chords of the key.
 *
 * The beat grid is a constant-tempo grid (most recorded pop / rock / electronic music is), which
 * is what a generated accompaniment needs; rubato or tempo changes are not followed.
 */
import { fftInPlace } from './bands';

export type Mode = 'major' | 'minor';
export type ChordQuality = 'maj' | 'min' | 'dim';
export interface Chord { t: number; dur: number; root: number; quality: ChordQuality }
export interface KeyEstimate { tonic: number; mode: Mode; confidence: number; scores: number[] }
export interface TempoEstimate { bpm: number; confidence: number; beatOffset: number }

export interface MusicAnalysis {
  /** Seconds of audio analysed. */
  duration: number;
  tonic: number;
  mode: Mode;
  keyConfidence: number;
  /** Exact tempo of the beat grid (display it rounded). */
  bpm: number;
  tempoConfidence: number;
  /** Time (s) of the first beat of the grid, 0 <= beatOffset < 60 / bpm. */
  beatOffset: number;
  /** Index (0-3) of the first beat of the grid that starts a bar. */
  downbeat: number;
  chords: Chord[];
  /** Mean chroma, C..B, max = 1. */
  chroma: number[];
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// ---------------------------------------------------------------------------------------------
// helpers

/** Down-sample by an integer factor (box filter) to roughly 20-24 kHz. Chroma only needs < 5 kHz. */
export function decimate(x: Float32Array, sampleRate: number): { x: Float32Array; sampleRate: number } {
  const f = Math.max(1, Math.floor(sampleRate / 20000));
  if (f === 1) return { x, sampleRate };
  const n = Math.floor(x.length / f), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < f; j++) s += x[i * f + j];
    out[i] = s / f;
  }
  return { x: out, sampleRate: sampleRate / f };
}

const HARMONIC_ATTEN = 0.3;

function pow2Near(v: number): number {
  return 2 ** Math.round(Math.log2(Math.max(64, v)));
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

// ---------------------------------------------------------------------------------------------
// chroma

export interface Chromagram {
  /** Per frame, 12 log-compressed pitch-class energies (C = 0), on a common scale 0..1. */
  frames: Float32Array[];
  /** Frame centre times (s). */
  times: number[];
  /** Frame RMS (for silence detection). */
  rms: number[];
  /** Mean chroma over non-silent frames, max = 1. */
  mean: number[];
}

/** Chromagram of mono samples (decimated internally). */
export function chromagram(input: Float32Array, inputRate: number, opts: { fMin?: number; fMax?: number } = {}): Chromagram {
  const { x, sampleRate: sr } = decimate(input, inputRate);
  const N = pow2Near(sr * 0.186), hop = N / 4, binHz = sr / N;
  const fMin = opts.fMin ?? 55, fMax = opts.fMax ?? 5000;
  const kMin = Math.max(2, Math.floor(fMin / binHz)), kMax = Math.min(N / 2 - 2, Math.ceil(fMax / binHz));
  const win = hann(N);
  const re = new Float64Array(N), im = new Float64Array(N), mag = new Float64Array(N / 2);
  const raw: Float64Array[] = [], times: number[] = [], rms: number[] = [];
  for (let s = 0; s + N <= Math.max(N, x.length); s += hop) {
    let e = 0;
    for (let i = 0; i < N; i++) { const v = x[s + i] ?? 0; re[i] = v * win[i]; im[i] = 0; e += v * v; }
    fftInPlace(re, im);
    let mx = 0;
    for (let k = 0; k < N / 2; k++) { mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]); if (k >= kMin && k <= kMax && mag[k] > mx) mx = mag[k]; }
    const c = new Float64Array(12);
    const thr = mx * 0.02;
    const pf: number[] = [], pa: number[] = [];
    for (let k = kMin; k <= kMax; k++) {
      const b = mag[k];
      if (b <= thr || b <= mag[k - 1] || b < mag[k + 1]) continue;
      // parabolic interpolation on log magnitude for the true peak frequency
      const la = Math.log(mag[k - 1] + 1e-12), lb = Math.log(b + 1e-12), lc = Math.log(mag[k + 1] + 1e-12);
      const den = la - 2 * lb + lc;
      const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (la - lc)) / den)) : 0;
      pf.push((k + d) * binHz);
      pa.push(b);
    }
    // Overtones 3, 5, 6 and 7 of a louder lower peak would add a false fifth / third / seventh:
    // attenuate a peak that sits on one of them (octave overtones keep their pitch class anyway).
    const amp = pa.slice();
    for (let i = 0; i < pf.length; i++) {
      for (let j = 0; j < i; j++) {
        if (pa[j] < pa[i]) continue;
        const h = pf[i] / pf[j], hr = Math.round(h);
        if ((hr === 3 || hr === 5 || hr === 6 || hr === 7) && Math.abs(h / hr - 1) < 0.015) { amp[i] *= HARMONIC_ATTEN; break; }
      }
    }
    for (let i = 0; i < pf.length; i++) {
      const p = 69 + 12 * Math.log2(pf[i] / 440);
      const near = Math.round(p), dev = p - near;
      const w = Math.cos(Math.PI * dev) ** 2;
      c[((near % 12) + 12) % 12] += amp[i] * w;
    }
    raw.push(c);
    times.push((s + N / 2) / sr);
    rms.push(Math.sqrt(e / N));
  }
  const G = 10; // gentle log compression: loud notes still outweigh their overtones
  let gmax = 0;
  for (const c of raw) for (let j = 0; j < 12; j++) if (c[j] > gmax) gmax = c[j];
  const frames = raw.map((c) => {
    const f = new Float32Array(12);
    if (gmax > 0) for (let j = 0; j < 12; j++) f[j] = Math.log1p((G * c[j]) / gmax) / Math.log1p(G);
    return f;
  });
  const rmax = Math.max(0, ...rms);
  const mean = new Array<number>(12).fill(0);
  let used = 0;
  frames.forEach((f, i) => {
    if (rms[i] < rmax * 0.01) return;
    for (let j = 0; j < 12; j++) mean[j] += f[j];
    used++;
  });
  const mm = Math.max(...mean);
  if (used && mm > 0) for (let j = 0; j < 12; j++) mean[j] /= mm;
  return { frames, times, rms, mean };
}

// ---------------------------------------------------------------------------------------------
// key

/** Krumhansl-Kessler probe-tone profiles (C major / C minor). */
export const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
export const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Correlation with all 24 keys: scores[0..11] = C..B major, scores[12..23] = C..B minor. */
export function keyScores(chroma: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (const prof of [KK_MAJOR, KK_MINOR]) {
    for (let tonic = 0; tonic < 12; tonic++) {
      const rot = Array.from({ length: 12 }, (_, pc) => prof[(pc - tonic + 12) % 12]);
      out.push(pearson(chroma, rot));
    }
  }
  return out;
}

/** Krumhansl-Schmuckler key from a chroma vector. Confidence 0..1 (margin over the runner-up). */
export function estimateKey(chroma: ArrayLike<number>): KeyEstimate {
  const scores = keyScores(chroma);
  return keyFromScores(scores);
}

function keyFromScores(scores: number[]): KeyEstimate {
  const order = scores.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const [r1, i1] = order[0];
  const r2 = order[1]?.[0] ?? 0;
  return { tonic: i1 % 12, mode: i1 < 12 ? 'major' : 'minor', confidence: clamp01(0.5 * clamp01(r1) + 4 * (r1 - r2)), scores };
}

/** Relative major / minor: A minor <-> C major. */
export function relativeKey(tonic: number, mode: Mode): { tonic: number; mode: Mode } {
  return mode === 'minor' ? { tonic: (tonic + 3) % 12, mode: 'major' } : { tonic: (tonic + 9) % 12, mode: 'minor' };
}

// ---------------------------------------------------------------------------------------------
// tempo

/** Spectral-flux onset strength (log magnitude, half-wave rectified, local mean removed). */
export function onsetEnvelope(input: Float32Array, inputRate: number): { env: Float32Array; fps: number; t0: number } {
  const { x, sampleRate: sr } = decimate(input, inputRate);
  const N = pow2Near(sr * 0.046), hop = N / 4, fps = sr / hop;
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const g = peak > 0 ? 1 / peak : 1;
  const win = hann(N);
  const kMax = Math.min(N / 2, Math.ceil(8000 / (sr / N)));
  const re = new Float64Array(N), im = new Float64Array(N);
  let prev = new Float64Array(kMax), cur = new Float64Array(kMax);
  const nF = Math.max(0, Math.floor((x.length - N) / hop) + 1);
  const flux = new Float32Array(nF);
  for (let f = 0; f < nF; f++) {
    const s = f * hop;
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * g * win[i]; im[i] = 0; }
    fftInPlace(re, im);
    let sum = 0;
    for (let k = 1; k < kMax; k++) {
      cur[k] = Math.log1p(100 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      if (f > 0) { const d = cur[k] - prev[k]; if (d > 0) sum += d; }
    }
    flux[f] = sum;
    const t = prev; prev = cur; cur = t;
  }
  // remove the local mean (~0.5 s), rectify, unit variance
  const half = Math.round(fps * 0.25);
  const env = new Float32Array(nF);
  const cs = new Float64Array(nF + 1);
  for (let i = 0; i < nF; i++) cs[i + 1] = cs[i] + flux[i];
  for (let i = 0; i < nF; i++) {
    const a = Math.max(0, i - half), b = Math.min(nF, i + half + 1);
    env[i] = Math.max(0, flux[i] - (cs[b] - cs[a]) / (b - a));
  }
  let v = 0;
  for (let i = 0; i < nF; i++) v += env[i] * env[i];
  const sd = Math.sqrt(v / Math.max(1, nF)) || 1;
  for (let i = 0; i < nF; i++) env[i] /= sd;
  // frame f's flux belongs to the window centre
  return { env, fps, t0: N / 2 / sr };
}

function sampleAt(env: ArrayLike<number>, p: number): number {
  const i = Math.floor(p), k = p - i;
  if (i < 0 || i + 1 >= env.length) return i >= 0 && i < env.length ? env[i] : 0;
  return env[i] * (1 - k) + env[i + 1] * k;
}

/**
 * Tempo and beat phase from an onset envelope. Coarse: autocorrelation over 60-180 BPM, each lag
 * supported by its double and half, times a log-normal prior centred on 110 BPM (sd 0.9 octave).
 * Fine: comb search +-3 % in 0.02 BPM steps over every phase, beats weighted 1 and off-beats 0.5.
 */
export function estimateTempo(env: Float32Array, fps: number, t0 = 0, opts: { minBpm?: number; maxBpm?: number; prior?: number } = {}): TempoEstimate {
  const minBpm = opts.minBpm ?? 60, maxBpm = opts.maxBpm ?? 180, prior = opts.prior ?? 110;
  const n = env.length;
  const lagMax = Math.min(n - 1, Math.ceil((fps * 60 * 2) / minBpm) + 2);
  const ac = new Float64Array(lagMax + 1);
  for (let L = 1; L <= lagMax; L++) {
    let s = 0;
    for (let i = 0; i + L < n; i++) s += env[i] * env[i + L];
    ac[L] = s / Math.max(1, n - L);
  }
  const acAt = (L: number) => (L > lagMax ? 0 : sampleAt(ac, L));
  let best = -Infinity, bestBpm = prior;
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.5) {
    const L = (fps * 60) / bpm;
    const s = acAt(L) + 0.5 * acAt(2 * L) + 0.25 * acAt(L / 2);
    const w = Math.exp(-0.5 * (Math.log2(bpm / prior) / 0.9) ** 2);
    if (s * w > best) { best = s * w; bestBpm = bpm; }
  }
  // fine tempo + phase
  let fb = -Infinity, fBpm = bestBpm, fPhase = 0, fMean = 1;
  for (let bpm = bestBpm * 0.97; bpm <= bestBpm * 1.03; bpm += 0.02) {
    const P = (fps * 60) / bpm;
    const scores: number[] = [];
    for (let ph = 0; ph < P; ph += 0.5) {
      let s = 0, c = 0;
      for (let p = ph; p < n; p += P) { s += sampleAt(env, p) + 0.5 * sampleAt(env, p + P / 2); c++; }
      scores.push(c ? s / c : 0);
    }
    let m = 0, bi = 0;
    scores.forEach((s, i) => { m += s; if (s > scores[bi]) bi = i; });
    m /= Math.max(1, scores.length);
    if (scores[bi] > fb) { fb = scores[bi]; fBpm = bpm; fPhase = bi * 0.5; fMean = m; }
  }
  const period = 60 / fBpm;
  let beatOffset = fPhase / fps + t0;
  beatOffset = ((beatOffset % period) + period) % period;
  const confidence = clamp01((fb / Math.max(1e-9, fMean) - 1) / 1.5);
  return { bpm: fBpm, confidence, beatOffset };
}

// ---------------------------------------------------------------------------------------------
// chords

export interface ChordName { root: number; quality: ChordQuality }

const TRIAD: Record<ChordQuality, number[]> = { maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6] };

export function chordPcs(c: ChordName): number[] {
  return TRIAD[c.quality].map((s) => (c.root + s) % 12);
}

/** Template: 1 on the chord tones, 0 elsewhere. */
function template(c: ChordName): number[] {
  const t = new Array<number>(12).fill(0);
  for (const pc of chordPcs(c)) t[pc] = 1;
  return t;
}

/** All 24 major / minor triads. */
export const ALL_TRIADS: ChordName[] = [
  ...Array.from({ length: 12 }, (_, r) => ({ root: r, quality: 'maj' as const })),
  ...Array.from({ length: 12 }, (_, r) => ({ root: r, quality: 'min' as const })),
];

/** Triads plausible in a key: the diatonic ones (+ the major V of harmonic minor). */
export function keyChords(tonic: number, mode: Mode): ChordName[] {
  const steps = mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  const qual: ChordQuality[] = mode === 'major' ? ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'] : ['min', 'dim', 'maj', 'min', 'min', 'maj', 'maj'];
  const out = steps.map((s, i) => ({ root: (tonic + s) % 12, quality: qual[i] }));
  if (mode === 'minor') out.push({ root: (tonic + 7) % 12, quality: 'maj' });
  return out;
}

/**
 * Chords over the beat grid: one chroma vector per half bar (2 beats, aligned to the downbeat),
 * correlated with the candidate triads; Viterbi smoothing (changing chord costs 0.12, changing
 * mid-bar 0.1 more); quiet or ambiguous segments are no-chord (N) and are left out of the list.
 */
export function detectChords(chroma: Chromagram, grid: { bpm: number; beatOffset: number; downbeat: number }, duration: number, candidates: ChordName[] = ALL_TRIADS): Chord[] {
  const beat = 60 / grid.bpm, segLen = 2 * beat;
  // segment boundaries: every 2 beats from the first downbeat, extended backwards to 0
  const first = grid.beatOffset + grid.downbeat * beat;
  let b0 = first - Math.ceil(first / segLen) * segLen;
  const bounds: number[] = [];
  for (let t = b0; t < duration; t += segLen) bounds.push(Math.max(0, t));
  bounds.push(duration);
  if (bounds[1] !== undefined && bounds[1] - bounds[0] < beat * 0.5) bounds.splice(1, 1); // fold a tiny first piece
  b0 = bounds[0];
  const segs: { t0: number; t1: number; c: number[]; barStart: boolean; quiet: boolean }[] = [];
  const rmax = Math.max(0, ...chroma.rms);
  for (let s = 0; s + 1 < bounds.length; s++) {
    const t0 = bounds[s], t1 = bounds[s + 1];
    const c = new Array<number>(12).fill(0);
    let k = 0, e = 0;
    chroma.times.forEach((t, i) => {
      if (t < t0 || t >= t1) return;
      for (let j = 0; j < 12; j++) c[j] += chroma.frames[i][j];
      e += chroma.rms[i]; k++;
    });
    const idx = Math.round((t0 - first) / segLen);
    segs.push({ t0, t1, c, barStart: ((idx % 2) + 2) % 2 === 0, quiet: !k || e / k < rmax * 0.02 });
  }
  if (!segs.length) return [];
  const tpl = candidates.map(template);
  const S = candidates.length; // state S = no chord
  const emit = segs.map((g) => {
    const r = tpl.map((t) => (g.quiet ? -1 : pearson(g.c, t)));
    r.push(g.quiet ? 1 : 0.3);
    return r;
  });
  const score = emit[0].slice();
  const back: number[][] = [];
  for (let s = 1; s < segs.length; s++) {
    const pen = 0.12 + (segs[s].barStart ? 0 : 0.1);
    const nxt = new Array<number>(S + 1), bk = new Array<number>(S + 1);
    let bestPrev = 0;
    for (let j = 1; j <= S; j++) if (score[j] > score[bestPrev]) bestPrev = j;
    for (let j = 0; j <= S; j++) {
      const stay = score[j], move = score[bestPrev] - pen;
      if (stay >= move || bestPrev === j) { nxt[j] = stay + emit[s][j]; bk[j] = j; } else { nxt[j] = move + emit[s][j]; bk[j] = bestPrev; }
    }
    back.push(bk);
    for (let j = 0; j <= S; j++) score[j] = nxt[j];
  }
  let st = 0;
  for (let j = 1; j <= S; j++) if (score[j] > score[st]) st = j;
  const path = new Array<number>(segs.length);
  path[segs.length - 1] = st;
  for (let s = segs.length - 1; s > 0; s--) { st = back[s - 1][st]; path[s - 1] = st; }
  const out: Chord[] = [];
  path.forEach((p, s) => {
    if (p === S) return;
    const c = candidates[p], last = out[out.length - 1];
    if (last && last.root === c.root && last.quality === c.quality && Math.abs(last.t + last.dur - segs[s].t0) < 1e-6) last.dur = segs[s].t1 - last.t;
    else out.push({ t: segs[s].t0, dur: segs[s].t1 - segs[s].t0, root: c.root, quality: c.quality });
  });
  return out.map((c) => ({ ...c, t: Math.round(c.t * 1e4) / 1e4, dur: Math.round(c.dur * 1e4) / 1e4 }));
}

/** Which beat (0-3) of the grid starts a bar: where the harmony changes most. */
export function estimateDownbeat(chroma: Chromagram, bpm: number, beatOffset: number, duration: number): number {
  const beat = 60 / bpm;
  const nb = Math.floor((duration - beatOffset) / beat);
  if (nb < 8) return 0;
  const per: number[][] = [];
  for (let b = 0; b < nb; b++) {
    const t0 = beatOffset + b * beat, t1 = t0 + beat, c = new Array<number>(12).fill(0);
    chroma.times.forEach((t, i) => { if (t >= t0 && t < t1) for (let j = 0; j < 12; j++) c[j] += chroma.frames[i][j]; });
    per.push(c);
  }
  const nov = new Array<number>(4).fill(0), cnt = new Array<number>(4).fill(0);
  for (let b = 2; b + 2 <= nb; b++) {
    const before = per[b - 2].map((v, j) => v + per[b - 1][j]);
    const after = per[b].map((v, j) => v + per[b + 1][j]);
    nov[b % 4] += 1 - pearson(before, after);
    cnt[b % 4]++;
  }
  let best = 0;
  for (let o = 1; o < 4; o++) if (nov[o] / Math.max(1, cnt[o]) > nov[best] / Math.max(1, cnt[best]) + 1e-9) best = o;
  return best;
}

// ---------------------------------------------------------------------------------------------
// everything

/** Key, tempo, beat grid and chords of mono samples (up to `maxSeconds`, default 60). */
export function analyseMusic(samples: Float32Array, sampleRate: number, opts: { maxSeconds?: number } = {}): MusicAnalysis {
  const maxN = Math.floor((opts.maxSeconds ?? 60) * sampleRate);
  const x = samples.length > maxN ? samples.subarray(0, maxN) : samples;
  const duration = x.length / sampleRate;
  const chroma = chromagram(x, sampleRate);
  if (Math.max(...chroma.mean) <= 0) throw new Error('silent');
  const { env, fps, t0 } = onsetEnvelope(x, sampleRate);
  const tempo = estimateTempo(env, fps, t0);
  const downbeat = estimateDownbeat(chroma, tempo.bpm, tempo.beatOffset, duration);
  const grid = { bpm: tempo.bpm, beatOffset: tempo.beatOffset, downbeat };

  // Key: Krumhansl-Schmuckler, then settle a near-tie between relative keys (C major / A minor
  // share every note) by tonic-chord evidence from an unrestricted chord pass.
  const scores = keyScores(chroma.mean);
  let key = keyFromScores(scores);
  const rel = relativeKey(key.tonic, key.mode);
  const relScore = scores[rel.tonic + (rel.mode === 'minor' ? 12 : 0)];
  const topScore = scores[key.tonic + (key.mode === 'minor' ? 12 : 0)];
  if (topScore - relScore < 0.2) {
    const free = detectChords(chroma, grid, duration, ALL_TRIADS);
    const total = free.reduce((s, c) => s + c.dur, 0) || 1;
    const evidence = (k: { tonic: number; mode: Mode }) => {
      const q: ChordQuality = k.mode === 'major' ? 'maj' : 'min';
      const isT = (c?: Chord) => !!c && c.root === k.tonic && c.quality === q;
      return free.filter(isT).reduce((s, c) => s + c.dur, 0) / total + (isT(free[0]) ? 0.4 : 0) + (isT(free[free.length - 1]) ? 0.15 : 0);
    };
    const adj = scores.slice();
    adj[key.tonic + (key.mode === 'minor' ? 12 : 0)] += 0.5 * evidence(key);
    adj[rel.tonic + (rel.mode === 'minor' ? 12 : 0)] += 0.5 * evidence(rel);
    key = { ...keyFromScores(adj), scores };
  }
  const chords = detectChords(chroma, grid, duration, keyChords(key.tonic, key.mode));
  return {
    duration, tonic: key.tonic, mode: key.mode, keyConfidence: key.confidence,
    bpm: tempo.bpm, tempoConfidence: tempo.confidence, beatOffset: tempo.beatOffset, downbeat, chords,
    chroma: chroma.mean.map((v) => Math.round(v * 1e3) / 1e3),
  };
}

// ---------------------------------------------------------------------------------------------
// names

const NAMES = {
  en: { sharp: ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'], flat: ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'] },
  es: { sharp: ['Do', 'Do♯', 'Re', 'Re♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'], flat: ['Do', 'Re♭', 'Re', 'Mi♭', 'Mi', 'Fa', 'Sol♭', 'Sol', 'La♭', 'La', 'Si♭', 'Si'] },
};
/** Keys conventionally written with flats (major tonic pcs; minor keys use their relative major). */
const FLAT_MAJOR = new Set([1, 3, 5, 8, 10]);

/** Pitch-class name in the spelling of a key (EN C, D♭...; ES Do, Re♭...). */
export function noteName(pc: number, locale: 'en' | 'es', key?: { tonic: number; mode: Mode }): string {
  const major = key ? (key.mode === 'major' ? key.tonic : (key.tonic + 3) % 12) : 0;
  const flats = FLAT_MAJOR.has(major) || (key?.mode === 'minor' && key.tonic === 2); // D minor: B♭
  const n = NAMES[locale] ?? NAMES.en;
  return (flats ? n.flat : n.sharp)[((pc % 12) + 12) % 12];
}

/** Chord symbol: EN "Am", "F", "B°"; ES "Lam", "Fa", "Si°". */
export function chordName(c: ChordName, locale: 'en' | 'es', key?: { tonic: number; mode: Mode }): string {
  return noteName(c.root, locale, key) + (c.quality === 'min' ? 'm' : c.quality === 'dim' ? '°' : '');
}
