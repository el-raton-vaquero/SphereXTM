/**
 * Listar "star symphony" — pure, dependency-free core (no DOM, no Web Audio, no imports),
 * so it can be unit-tested with plain Node:  node scripts/test-symphony.mjs
 *
 * What is real and what is artistic:
 *  - The INPUT is a real spectrum: surface brightness of a sky region measured in real SPHEREx
 *    frames (one wavelength per frame), or a clearly labelled computed spectrum.
 *  - The 102 "bands" here are an approximation of the SPHEREx spectral channels: 6 detectors
 *    x 17 channels with constant resolving power inside each detector (log-spaced). Band edges
 *    come from the detector ranges documented in app/prism-tokens.css (D1 0.75-1.09 ... D6
 *    4.42-5.00 um). They are used only to group samples into notes, never as calibration.
 *  - Everything downstream (pitch, rhythm, timbre) is an ARTISTIC MAPPING of that data.
 */

export const N_DETECTORS = 6;
export const BANDS_PER_DETECTOR = 17;
export const N_BANDS = N_DETECTORS * BANDS_PER_DETECTOR; // 102

/** Detector wavelength ranges in um (same as --p-l1..--p-l6 in prism-tokens.css). */
export const DETECTOR_RANGES_UM: readonly [number, number][] = [
  [0.75, 1.09], [1.1, 1.62], [1.63, 2.41], [2.42, 3.82], [3.83, 4.41], [4.42, 5.0],
];
export const LAMBDA_SHORT_UM = 0.75;
export const LAMBDA_LONG_UM = 5.0;

export interface Band {
  index: number;      // 0..101, short -> long wavelength
  detector: number;   // 1..6
  lo: number;         // um
  hi: number;         // um
  center: number;     // um (geometric centre)
}

/** The 102 approximate SPHEREx bands, ordered by wavelength. */
export const BANDS: readonly Band[] = (() => {
  const out: Band[] = [];
  DETECTOR_RANGES_UM.forEach(([lo, hi], d) => {
    const r = hi / lo;
    for (let k = 0; k < BANDS_PER_DETECTOR; k++) {
      const a = lo * Math.pow(r, k / BANDS_PER_DETECTOR);
      const b = lo * Math.pow(r, (k + 1) / BANDS_PER_DETECTOR);
      out.push({ index: d * BANDS_PER_DETECTOR + k, detector: d + 1, lo: a, hi: b, center: Math.sqrt(a * b) });
    }
  });
  return out;
})();

/** Band index for a wavelength: the band whose [lo,hi) contains it, else the nearest centre (log distance). -1 if out of range. */
export function bandIndexFor(lambdaUm: number): number {
  if (!Number.isFinite(lambdaUm) || lambdaUm < 0.6 || lambdaUm > 5.2) return -1;
  let best = -1;
  let bestD = Infinity;
  for (const b of BANDS) {
    if (lambdaUm >= b.lo && lambdaUm < b.hi) return b.index;
    const d = Math.abs(Math.log(lambdaUm / b.center));
    if (d < bestD) { bestD = d; best = b.index; }
  }
  return best;
}

/**
 * Bin (lambda, intensity) samples into the 102 bands: mean of the finite samples in each band.
 * Bands with no finite sample are NaN (silent). NaN-safe; ignores out-of-range wavelengths.
 */
export function binToBands(lambdaUm: ArrayLike<number>, intensity: ArrayLike<number>): Float64Array {
  const sum = new Float64Array(N_BANDS);
  const cnt = new Uint16Array(N_BANDS);
  const n = Math.min(lambdaUm.length, intensity.length);
  for (let i = 0; i < n; i++) {
    const v = intensity[i];
    if (!Number.isFinite(v)) continue;
    const b = bandIndexFor(lambdaUm[i]);
    if (b < 0) continue;
    sum[b] += v;
    cnt[b]++;
  }
  const out = new Float64Array(N_BANDS);
  for (let b = 0; b < N_BANDS; b++) out[b] = cnt[b] ? sum[b] / cnt[b] : NaN;
  return out;
}

/** p-th percentile (0..100) of the finite values; NaN when there are none. */
export function finitePercentile(values: ArrayLike<number>, p: number): number {
  const v: number[] = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) v.push(values[i]);
  if (!v.length) return NaN;
  v.sort((a, b) => a - b);
  const pos = Math.min(v.length - 1, Math.max(0, (p / 100) * (v.length - 1)));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

/**
 * Robust 0..1 normalisation: (x - p5) / (p97 - p5), clipped. NaN stays NaN (empty band).
 * A flat spectrum (no spread) maps every finite band to 0.5.
 */
export function robustNormalize(bands: ArrayLike<number>, pLo = 5, pHi = 97): Float64Array {
  const lo = finitePercentile(bands, pLo);
  const hi = finitePercentile(bands, pHi);
  const out = new Float64Array(bands.length);
  const span = hi - lo;
  const flat = !(span > 1e-12 * Math.max(1, Math.abs(hi)));
  for (let i = 0; i < bands.length; i++) {
    const x = bands[i];
    if (!Number.isFinite(x)) { out[i] = NaN; continue; }
    out[i] = flat ? 0.5 : Math.min(1, Math.max(0, (x - lo) / span));
  }
  return out;
}

// ---------------------------------------------------------------- pitch

export type ScaleId = 'majorPent' | 'minorPent' | 'suspendedPent';
/** Pentatonic scales (semitones above the root within one octave). No semitone steps -> always consonant. */
export const SCALES: Record<ScaleId, readonly number[]> = {
  majorPent: [0, 2, 4, 7, 9],
  minorPent: [0, 3, 5, 7, 10],
  suspendedPent: [0, 2, 5, 7, 10],
};

/** Snap a semitone offset (relative to the root) to the nearest scale tone, any octave. Ties go down. */
export function quantizeToScale(semis: number, scale: readonly number[]): number {
  const oct = Math.floor(semis / 12);
  let best = 0;
  let bestD = Infinity;
  for (let o = oct - 1; o <= oct + 1; o++) {
    for (const s of scale) {
      const c = o * 12 + s;
      const d = Math.abs(c - semis);
      if (d < bestD - 1e-9) { bestD = d; best = c; }
    }
  }
  return best;
}

/** Melody span in semitones (4 octaves), lowest note = longest wavelength. */
export const MELODY_SPAN = 48;

/** 0 at 5.0 um (long, low pitch) -> 1 at 0.75 um (short, high pitch): like light, shorter = higher. */
export function pitchPosition(lambdaUm: number): number {
  const p = Math.log(LAMBDA_LONG_UM / lambdaUm) / Math.log(LAMBDA_LONG_UM / LAMBDA_SHORT_UM);
  return Math.min(1, Math.max(0, p));
}

/** MIDI note for a band: position on a 4-octave span above `baseMidi`, snapped to the scale. */
export function bandMidi(bandIndex: number, baseMidi: number, scale: readonly number[]): number {
  const b = BANDS[Math.min(N_BANDS - 1, Math.max(0, bandIndex))];
  return baseMidi + quantizeToScale(pitchPosition(b.center) * MELODY_SPAN, scale);
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ---------------------------------------------------------------- note shaping

/** Velocity 0..1 from a normalised band value (soft floor so quiet notes still speak). */
export function noteVelocity(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(1, 0.12 + 0.88 * Math.pow(v, 0.8));
}

/** Note length in seconds: brighter bands ring longer. */
export function noteDuration(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return 0.35 + 2.4 * Math.pow(Math.min(1, v), 1.5);
}

/** Sequencer step length (s) for a band: bright bands hold the beat longer, dark ones pass quickly. */
export function stepLength(v: number, base = 0.17): number {
  const x = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  return base * (0.5 + 0.9 * x);
}

/** Threshold under which a band is a rest. */
export const REST_BELOW = 0.16;

// ---------------------------------------------------------------- spectral colour

export type SpectralColour = 'blue' | 'neutral' | 'red';

/**
 * Colour index in -1..1: mean normalised brightness of the short-wavelength detectors (D1-D2)
 * minus that of the long-wavelength ones (D5-D6). Positive = "blue" (hot, starlight-dominated),
 * negative = "red" (cold, dusty or thermal).
 */
export function colourIndex(norm: ArrayLike<number>): number {
  const mean = (a: number, b: number) => {
    let s = 0, c = 0;
    for (let i = a; i < b; i++) if (Number.isFinite(norm[i])) { s += norm[i]; c++; }
    return c ? s / c : NaN;
  };
  const blue = mean(0, 2 * BANDS_PER_DETECTOR);
  const red = mean(4 * BANDS_PER_DETECTOR, N_BANDS);
  if (!Number.isFinite(blue) || !Number.isFinite(red)) return 0;
  return Math.max(-1, Math.min(1, blue - red));
}

export function classifyColour(ci: number, previous?: SpectralColour, hysteresis = 0.05): SpectralColour {
  const edge = 0.15;
  const h = previous ? hysteresis : 0;
  if (previous === 'blue' && ci > edge - h) return 'blue';
  if (previous === 'red' && ci < -edge + h) return 'red';
  if (ci > edge + h) return 'blue';
  if (ci < -edge - h) return 'red';
  return 'neutral';
}

/** Musical key for a spectral colour: scale + drone root (MIDI). */
export const KEYS: Record<SpectralColour, { scale: ScaleId; root: number; name: string }> = {
  blue: { scale: 'majorPent', root: 40, name: 'E' },       // E2
  neutral: { scale: 'suspendedPent', root: 38, name: 'D' }, // D2
  red: { scale: 'minorPent', root: 45, name: 'A' },         // A2
};

// ---------------------------------------------------------------- spectral features

export type FeatureId = 'h2o' | 'ch4' | 'co2' | 'co' | 'pah';
export interface FeatureDef {
  id: FeatureId;
  /** Feature centre (um), absorption window and continuum windows (um). */
  center: number;
  band: [number, number];
  blue: [number, number];
  red: [number, number];
  /** 'absorption' needs depth > threshold; 'emission' needs depth < -threshold. */
  sense: 'absorption' | 'emission';
  threshold: number;
}

/** Absorption (and one emission) features inside the SPHEREx range that drive the timbre. */
export const FEATURES: readonly FeatureDef[] = [
  { id: 'h2o', center: 3.05, band: [2.9, 3.2], blue: [2.45, 2.7], red: [3.55, 3.8], sense: 'absorption', threshold: 0.12 },
  { id: 'ch4', center: 3.3, band: [3.25, 3.4], blue: [3.12, 3.2], red: [3.45, 3.56], sense: 'absorption', threshold: 0.12 },
  { id: 'pah', center: 3.3, band: [3.25, 3.4], blue: [3.12, 3.2], red: [3.45, 3.56], sense: 'emission', threshold: 0.12 },
  { id: 'co2', center: 4.27, band: [4.22, 4.32], blue: [4.08, 4.18], red: [4.36, 4.5], sense: 'absorption', threshold: 0.12 },
  { id: 'co', center: 4.67, band: [4.6, 4.74], blue: [4.45, 4.55], red: [4.8, 4.95], sense: 'absorption', threshold: 0.12 },
];

export interface FeatureResult {
  id: FeatureId;
  /** 1 - F_band / F_cont (positive = absorption). NaN when not measurable. */
  depth: number;
  detected: boolean;
  /** 0..1 strength used for the timbre mix (0 when not detected). */
  strength: number;
  /** Indices of the bands inside the feature window (they get the feature's voice). */
  bands: number[];
}

function bandsIn(range: [number, number]): number[] {
  return BANDS.filter((b) => b.center >= range[0] && b.center <= range[1]).map((b) => b.index);
}

function meanOf(values: ArrayLike<number>, idx: number[]): number {
  let s = 0, c = 0;
  for (const i of idx) if (Number.isFinite(values[i])) { s += values[i]; c++; }
  return c ? s / c : NaN;
}

/**
 * Robust per-band noise: MAD of the differences between neighbouring filled bands of the same
 * detector, / sqrt(2). Real spectra are smooth on that scale, so this tracks measurement scatter.
 */
export function bandNoise(bands: ArrayLike<number>): number {
  const d: number[] = [];
  for (let i = 1; i < N_BANDS; i++) {
    if (i % BANDS_PER_DETECTOR === 0) continue;
    const a = bands[i - 1], b = bands[i];
    if (Number.isFinite(a) && Number.isFinite(b)) d.push(Math.abs(b - a));
  }
  if (d.length < 5) return 0;
  return (1.4826 * finitePercentile(d, 50)) / Math.SQRT2;
}

/**
 * Band depths on the RAW band values (not normalised), continuum = linear interpolation in
 * wavelength between the blue and red window means. Not measurable (NaN, not detected) when a
 * window is empty or the continuum is not clearly positive (< 3% of the spectrum's p95).
 */
export function detectFeatures(bands: ArrayLike<number>): FeatureResult[] {
  const scale = Math.abs(finitePercentile(bands, 95));
  const noise = bandNoise(bands);
  return FEATURES.map((f) => {
    const inBand = bandsIn(f.band);
    const fb = meanOf(bands, inBand);
    const b = meanOf(bands, bandsIn(f.blue));
    const r = meanOf(bands, bandsIn(f.red));
    const lb = (f.blue[0] + f.blue[1]) / 2;
    const lr = (f.red[0] + f.red[1]) / 2;
    const cont = b + (r - b) * ((f.center - lb) / (lr - lb));
    let depth = NaN;
    // Measurable only when the continuum stands clearly above the band-to-band noise.
    if (Number.isFinite(fb) && Number.isFinite(cont) && cont > 0 && cont > 0.03 * (scale || 0) && cont > 6 * noise) {
      depth = 1 - fb / cont;
      // A band that went below zero (depth > 1) is noise or a bad frame, not an absorption.
      if (depth > 1) depth = NaN;
      // A dip/bump smaller than 3 noise units is not a feature, whatever its relative depth.
      if (Math.abs(cont - fb) < 3 * noise) depth = Math.sign(depth) * Math.min(Math.abs(depth), f.threshold * 0.5);
    }
    const signed = f.sense === 'absorption' ? depth : -depth;
    const detected = Number.isFinite(signed) && signed >= f.threshold;
    const strength = detected ? Math.min(1, (signed - f.threshold) / 0.35 + 0.35) : 0;
    return { id: f.id, depth, detected, strength, bands: inBand };
  });
}

// ---------------------------------------------------------------- analysis

export interface Analysis {
  /** 102 values in 0..1, NaN = empty band (silent). */
  norm: Float64Array;
  /** Number of bands with data. */
  valid: number;
  colourIndex: number;
  colour: SpectralColour;
  features: FeatureResult[];
  /** Local maxima of the normalised spectrum (get an octave "sparkle" on top). */
  peaks: boolean[];
  /** Deterministic seed from the spectrum shape: same region -> same melody. */
  seed: number;
}

export function analyseSpectrum(bands: ArrayLike<number>, previousColour?: SpectralColour): Analysis {
  const norm = robustNormalize(bands);
  let valid = 0;
  for (let i = 0; i < norm.length; i++) if (Number.isFinite(norm[i])) valid++;
  const ci = colourIndex(norm);
  const peaks: boolean[] = [];
  for (let i = 0; i < N_BANDS; i++) {
    const v = norm[i];
    const l = i > 0 ? norm[i - 1] : NaN;
    const r = i < N_BANDS - 1 ? norm[i + 1] : NaN;
    peaks.push(Number.isFinite(v) && v > 0.55 && !(v < l) && !(v < r) && (Number.isFinite(l) || Number.isFinite(r)));
  }
  return {
    norm,
    valid,
    colourIndex: ci,
    colour: classifyColour(ci, previousColour),
    features: detectFeatures(bands),
    peaks,
    seed: spectrumSeed(norm),
  };
}

/** FNV-1a over the spectrum quantised to 16 levels per band. */
export function spectrumSeed(norm: ArrayLike<number>): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    const q = Number.isFinite(norm[i]) ? Math.round(norm[i] * 15) : 255;
    h ^= q;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Small deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stereo position by detector: D1 left ... D6 right. */
export function detectorPan(detector: number): number {
  const d = Math.min(N_DETECTORS, Math.max(1, detector));
  return -0.7 + (1.4 * (d - 1)) / (N_DETECTORS - 1);
}

// ---------------------------------------------------------------- computed spectra

/**
 * Planck blackbody B_lambda(T) sampled at the 102 band centres (arbitrary units). For COMPUTED
 * star colours (e.g. historical sky); label the result provenance:'computed'.
 */
export function planckBands(teffK: number): { lambda_um: number[]; intensity: number[] } {
  const h = 6.62607015e-34, c = 2.99792458e8, k = 1.380649e-23;
  const lambda_um = BANDS.map((b) => b.center);
  const intensity = lambda_um.map((um) => {
    const l = um * 1e-6;
    const x = (h * c) / (l * k * Math.max(50, teffK));
    return x > 700 ? 0 : 1 / (Math.pow(l, 5) * (Math.exp(x) - 1));
  });
  const max = Math.max(...intensity) || 1;
  return { lambda_um, intensity: intensity.map((v) => v / max) };
}

// ---------------------------------------------------------------- WAV export

/** 16-bit PCM WAV from planar float channels (-1..1). */
export function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const nCh = Math.max(1, channels.length);
  const len = channels[0]?.length ?? 0;
  const dataBytes = len * nCh * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nCh, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nCh * 2, true); v.setUint16(32, nCh * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c]?.[i] ?? 0));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return buf;
}
