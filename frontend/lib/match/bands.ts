/**
 * Star Match: the song side. Pure functions (no DOM), shared by the worker and the main thread.
 *
 * StarChord's mapping (a design choice, not physics): SPHEREx splits light 0.75-5.0 um into 102
 * bands; we split sound into 102 log-spaced bands from ~55 Hz to ~7 kHz. Band i of the song sits
 * next to band i of the sky, with the order mirrored: short wavelength (blue, band 0) <-> high
 * pitch, long wavelength (red, band 101) <-> low pitch.
 *
 * The song profile is the long-term average power in each band (Hann-windowed FFT frames, silent
 * frames ignored), in dB, minus a reference "average music" spectrum, then z-scored across bands.
 * So two songs differ by their character (where the energy sits relative to typical music), not
 * by loudness. The sky side is z-scored per band against the sky median (see search.ts).
 */

export const N_BANDS = 102;
export const F_HIGH = 7040; // Hz, band 0 (shortest wavelength)
export const F_LOW = 55; // Hz, band 101 (longest wavelength)

/** Centre frequency (Hz) of song band i: log-spaced, descending (band 0 = highest pitch). */
export const BAND_HZ: readonly number[] = Array.from({ length: N_BANDS }, (_, i) => F_HIGH * (F_LOW / F_HIGH) ** (i / (N_BANDS - 1)));
const STEP = (F_HIGH / F_LOW) ** (1 / (N_BANDS - 1));
/** Lower / upper edge (Hz) of band i (geometric half-steps around the centre). */
export const BAND_LO: readonly number[] = BAND_HZ.map((f) => f / Math.sqrt(STEP));
export const BAND_HI: readonly number[] = BAND_HZ.map((f) => f * Math.sqrt(STEP));

/**
 * Reference long-term spectrum of "average music" per constant-Q band, in dB: flat up to 250 Hz,
 * then falling 4.5 dB per octave (a smoothed version of published long-term average spectra of
 * mixed popular music). Subtracting it makes a typical mix come out roughly flat.
 */
export function referenceDb(hz: number): number {
  return hz <= 250 ? 0 : -4.5 * Math.log2(hz / 250);
}
const REF_DB = BAND_HZ.map(referenceDb);

// ---------------------------------------------------------------------------------------------
// FFT (radix-2, in place)

export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/**
 * Mean power density inside each band from a one-sided power spectrum (`power[k]` at k*binHz).
 * Bands narrower than an FFT bin are linearly interpolated, so every band gets a value.
 */
export function bandPowers(power: ArrayLike<number>, binHz: number, out = new Float64Array(N_BANDS)): Float64Array {
  const nb = power.length;
  const at = (f: number) => {
    const x = f / binHz, k = Math.floor(x), t = x - k;
    if (k >= nb - 1) return power[nb - 1];
    return power[k] * (1 - t) + power[k + 1] * t;
  };
  for (let b = 0; b < N_BANDS; b++) {
    const lo = BAND_LO[b], hi = BAND_HI[b];
    const k0 = Math.ceil(lo / binHz), k1 = Math.floor(hi / binHz);
    let s = at(lo) * 0.5 + at(hi) * 0.5, w = 1;
    for (let k = k0; k <= k1 && k < nb; k++) { s += power[k]; w++; }
    out[b] = s / w;
  }
  return out;
}

/** dB of band powers minus the reference curve, z-scored across bands (mean 0, sd 1). */
export function profileFromPowers(p: ArrayLike<number>): Float64Array {
  const out = new Float64Array(N_BANDS);
  let mean = 0;
  for (let b = 0; b < N_BANDS; b++) { out[b] = 10 * Math.log10(Math.max(1e-20, p[b])) - REF_DB[b]; mean += out[b]; }
  mean /= N_BANDS;
  let v = 0;
  for (let b = 0; b < N_BANDS; b++) { out[b] -= mean; v += out[b] * out[b]; }
  const sd = Math.sqrt(v / N_BANDS) || 1;
  for (let b = 0; b < N_BANDS; b++) out[b] /= sd;
  return out;
}

/** Display levels 0..1 of band powers (dB, -reference, scaled to a 48 dB window under the peak). */
export function displayLevels(p: ArrayLike<number>, out = new Float32Array(N_BANDS)): Float32Array {
  let mx = -Infinity;
  const db = new Float64Array(N_BANDS);
  for (let b = 0; b < N_BANDS; b++) { db[b] = 10 * Math.log10(Math.max(1e-20, p[b])) - REF_DB[b]; if (db[b] > mx) mx = db[b]; }
  for (let b = 0; b < N_BANDS; b++) out[b] = Math.max(0, Math.min(1, 1 + (db[b] - mx) / 48));
  return out;
}

export interface SongAnalysis {
  /** z-scored character profile, band 0 = highest pitch (pairs with the shortest wavelength). */
  profile: number[];
  /** Mean band power (linear) over the non-silent frames. */
  power: number[];
  /** Band display levels 0..1 every ~0.5 s (for the visualiser). */
  evolution: number[][];
  seconds: number;
  frames: number;
}

/**
 * Analyse mono samples: FFT 16384 (8192 below 24 kHz sample rate), Hann, 50 % hop, average power
 * over frames whose energy is within 45 dB of the loudest frame (and above an absolute floor).
 */
export function analyseSamples(x: Float32Array, sampleRate: number): SongAnalysis {
  const N = sampleRate >= 24000 ? 16384 : 8192, hop = N / 2, binHz = sampleRate / N;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float64Array(N), im = new Float64Array(N), pw = new Float64Array(N / 2);
  const frames: { e: number; bands: Float64Array }[] = [];
  for (let s = 0; s + N <= Math.max(N, x.length); s += hop) {
    let e = 0;
    for (let i = 0; i < N; i++) { const v = x[s + i] ?? 0; re[i] = v * win[i]; im[i] = 0; e += v * v; }
    fftInPlace(re, im);
    for (let k = 0; k < N / 2; k++) pw[k] = re[k] * re[k] + im[k] * im[k];
    frames.push({ e: e / N, bands: bandPowers(pw, binHz) });
  }
  let emax = 0;
  for (const f of frames) emax = Math.max(emax, f.e);
  const floor = Math.max(emax * 10 ** -4.5, 1e-9); // -45 dB under the loudest frame, ~-90 dBFS absolute
  const mean = new Float64Array(N_BANDS);
  let used = 0;
  for (const f of frames) {
    if (f.e < floor) continue;
    for (let b = 0; b < N_BANDS; b++) mean[b] += f.bands[b];
    used++;
  }
  if (!used) throw new Error('silent');
  for (let b = 0; b < N_BANDS; b++) mean[b] /= used;

  // evolution: ~0.5 s bins
  const per = Math.max(1, Math.round((0.5 * sampleRate) / hop));
  const evolution: number[][] = [];
  for (let i = 0; i < frames.length; i += per) {
    const acc = new Float64Array(N_BANDS);
    let k = 0;
    for (let j = i; j < Math.min(frames.length, i + per); j++, k++) for (let b = 0; b < N_BANDS; b++) acc[b] += frames[j].bands[b];
    for (let b = 0; b < N_BANDS; b++) acc[b] /= k || 1;
    evolution.push(Array.from(displayLevels(acc)));
  }
  return { profile: Array.from(profileFromPowers(mean)), power: Array.from(mean), evolution, seconds: x.length / sampleRate, frames: used };
}

/** Choose up to `maxSec` seconds of a track: skip a long intro, keep the body of the song. */
export function analysisWindow(durationSec: number, maxSec = 60): { start: number; length: number } {
  if (durationSec <= maxSec) return { start: 0, length: durationSec };
  const start = Math.min(30, (durationSec - maxSec) / 2);
  return { start, length: maxSec };
}
