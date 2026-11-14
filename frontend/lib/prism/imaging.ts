import type { Frame } from './types';

export interface Stats { median: number; sigma: number; nValid: number }

/** Median + MAD-based sigma over finite values. */
export function robustStats(data: ArrayLike<number>, mask?: (i: number) => boolean): Stats {
  const vals: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (Number.isFinite(v) && (!mask || mask(i))) vals.push(v);
  }
  if (!vals.length) return { median: NaN, sigma: NaN, nValid: 0 };
  vals.sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];
  const dev = vals.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  return { median, sigma: 1.4826 * dev[Math.floor(dev.length / 2)], nValid: vals.length };
}

/** IRAF-style zscale (sampled, iterative linear fit with rejection), contrast 0.25. */
export function zscale(data: ArrayLike<number>, contrast = 0.25): [number, number] {
  const vals: number[] = [];
  const step = Math.max(1, Math.floor(data.length / 1000));
  for (let i = 0; i < data.length; i += step) if (Number.isFinite(data[i])) vals.push(data[i]);
  if (vals.length < 3) return [0, 1];
  vals.sort((a, b) => a - b);
  const n = vals.length;
  const median = vals[Math.floor(n / 2)];
  let keep = vals.map((v, i) => ({ i, v }));
  let slope = 0, icpt = median;
  for (let iter = 0; iter < 5 && keep.length > n / 2; iter++) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of keep) { sx += p.i; sy += p.v; sxx += p.i * p.i; sxy += p.i * p.v; }
    const k = keep.length;
    const den = k * sxx - sx * sx;
    if (den === 0) break;
    slope = (k * sxy - sx * sy) / den;
    icpt = (sy - slope * sx) / k;
    const res = keep.map((p) => p.v - (icpt + slope * p.i));
    const sd = Math.sqrt(res.reduce((a, r) => a + r * r, 0) / k) || 0;
    const next = keep.filter((_, j) => Math.abs(res[j]) < 2.5 * sd);
    if (next.length === keep.length) break;
    keep = next;
  }
  const s = slope / contrast;
  const lo = Math.max(vals[0], median - (n / 2) * s);
  const hi = Math.min(vals[n - 1], median + (n / 2) * s);
  return hi > lo ? [lo, hi] : [vals[0], vals[n - 1] || vals[0] + 1];
}

export function percentile(data: ArrayLike<number>, p: number): number {
  const vals: number[] = [];
  for (let i = 0; i < data.length; i++) if (Number.isFinite(data[i])) vals.push(data[i]);
  if (!vals.length) return NaN;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.max(0, Math.round((p / 100) * (vals.length - 1))))];
}

export type Stretch = 'asinh' | 'zscale' | 'linear';

export interface Levels { lo: number; hi: number }

export function computeLevels(data: ArrayLike<number>, stretch: Stretch): Levels {
  if (stretch === 'zscale') {
    const [lo, hi] = zscale(data);
    return { lo, hi };
  }
  const st = robustStats(data);
  const lo = st.median - 2 * (st.sigma || 1e-6);
  const hi = Math.max(percentile(data, 99.7), lo + 1e-6);
  return { lo, hi };
}

const MASK: [number, number, number] = [0x2b, 0x3d, 0x5b];

/** Grayscale render (warm paper tint) to RGBA. NaN -> --p-mask. */
export function renderGray(data: ArrayLike<number>, levels: Levels, stretch: Stretch, out: Uint8ClampedArray) {
  const { lo, hi } = levels;
  const span = hi - lo || 1;
  const soft = 0.08; // asinh softening as a fraction of span
  const norm = Math.asinh(1 / soft);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    const o = i * 4;
    if (!Number.isFinite(v)) {
      out[o] = MASK[0]; out[o + 1] = MASK[1]; out[o + 2] = MASK[2]; out[o + 3] = 255;
      continue;
    }
    let t = (v - lo) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (stretch === 'asinh') t = Math.asinh(t / soft) / norm;
    // paper-white ink on warm black: #0b0a09 -> #ece8e1
    out[o] = 11 + t * (236 - 11);
    out[o + 1] = 10 + t * (232 - 10);
    out[o + 2] = 9 + t * (225 - 9);
    out[o + 3] = 255;
  }
}

/** Diverging render centred on zero: negative -> cool ramp blue, positive -> signal orange. */
export function renderDiverging(data: ArrayLike<number>, scale: number, out: Uint8ClampedArray, n = 0) {
  const s = scale || 1;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    const o = i * 4;
    if (!Number.isFinite(v)) {
      // Neutral checker (not --p-mask blue, which would read as a negative residual).
      const odd = n ? ((i % n) + Math.floor(i / n)) % 2 : 0;
      const g = odd ? 38 : 28;
      out[o] = g; out[o + 1] = g - 1; out[o + 2] = g - 3; out[o + 3] = 255;
      continue;
    }
    let t = v / s;
    t = t < -1 ? -1 : t > 1 ? 1 : t;
    const a = Math.sqrt(Math.abs(t));
    const base = [18, 17, 16];
    const tgt = t >= 0 ? [255, 90, 31] : [63, 182, 232];
    out[o] = base[0] + (tgt[0] - base[0]) * a;
    out[o + 1] = base[1] + (tgt[1] - base[1]) * a;
    out[o + 2] = base[2] + (tgt[2] - base[2]) * a;
    out[o + 3] = 255;
  }
}

/** Sequential map for band depth (0 = none -> 0.6+ deep), ink to signal. */
export function renderDepth(data: ArrayLike<number>, maxDepth: number, out: Uint8ClampedArray) {
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    const o = i * 4;
    if (!Number.isFinite(v)) {
      out[o] = 18; out[o + 1] = 17; out[o + 2] = 16; out[o + 3] = 255;
      continue;
    }
    const t = Math.max(-1, Math.min(1, v / (maxDepth || 1)));
    const a = Math.abs(t);
    const tgt = t >= 0 ? [255, 90, 31] : [63, 182, 232];
    out[o] = 30 + (tgt[0] - 30) * a;
    out[o + 1] = 28 + (tgt[1] - 28) * a;
    out[o + 2] = 26 + (tgt[2] - 26) * a;
    out[o + 3] = 255;
  }
}

/** Frame minus its own robust background (removes zodiacal-light level changes between epochs). */
export function bgSubtracted(f: Frame): Float32Array {
  const st = robustStats(f.pixels);
  const out = new Float32Array(f.pixels.length);
  for (let i = 0; i < out.length; i++) out[i] = f.pixels[i] - st.median;
  return out;
}

/** Per-pixel median of background-subtracted frames. NaN where no frame is valid. */
export function medianStack(frames: Frame[]): Float32Array {
  const n = frames[0]?.pixels.length ?? 0;
  const subs = frames.map(bgSubtracted);
  const out = new Float32Array(n);
  const buf: number[] = [];
  for (let i = 0; i < n; i++) {
    buf.length = 0;
    for (const s of subs) if (Number.isFinite(s[i])) buf.push(s[i]);
    if (!buf.length) { out[i] = NaN; continue; }
    buf.sort((a, b) => a - b);
    const m = buf.length >> 1;
    out[i] = buf.length % 2 ? buf[m] : 0.5 * (buf[m - 1] + buf[m]);
  }
  return out;
}

/** Frames whose λ lies within half a bandwidth of the reference frame's λ. */
export function matchedFrames(frames: Frame[], ref: Frame): Frame[] {
  const half = ref.bandwidth_um / 2;
  return frames.filter((f) => Math.abs(f.lambda_um - ref.lambda_um) <= half);
}

export interface Centroid { x: number; y: number; sx: number; sy: number; snr: number; flux: number }

/**
 * Background-subtracted, intensity-weighted centroid in a radius around (x0,y0).
 * Uncertainty per axis ≈ sqrt(second moment)/SNR (photon-noise approximation) ⊕ 0.1 px systematic floor.
 */
export function measureCentroid(pix: ArrayLike<number>, n: number, x0: number, y0: number, r = 2.5): Centroid | null {
  const ann: number[] = [];
  for (let y = Math.floor(y0 - r - 4); y <= Math.ceil(y0 + r + 4); y++) {
    for (let x = Math.floor(x0 - r - 4); x <= Math.ceil(x0 + r + 4); x++) {
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const d = Math.hypot(x - x0, y - y0);
      const v = pix[y * n + x];
      if (d > r + 1.5 && d <= r + 4 && Number.isFinite(v)) ann.push(v);
    }
  }
  if (ann.length < 8) return null;
  const st = robustStats(ann);
  let sw = 0, sx = 0, sy = 0, npx = 0;
  const pts: [number, number, number][] = [];
  for (let y = Math.floor(y0 - r); y <= Math.ceil(y0 + r); y++) {
    for (let x = Math.floor(x0 - r); x <= Math.ceil(x0 + r); x++) {
      if (x < 0 || y < 0 || x >= n || y >= n || Math.hypot(x - x0, y - y0) > r) continue;
      const v = pix[y * n + x];
      if (!Number.isFinite(v)) return null; // masked pixel inside aperture: refuse
      const w = Math.max(0, v - st.median);
      sw += w; sx += w * x; sy += w * y; npx++;
      pts.push([x, y, w]);
    }
  }
  if (sw <= 0 || !Number.isFinite(st.sigma) || st.sigma <= 0) return null;
  const cx = sx / sw, cy = sy / sw;
  let mxx = 0, myy = 0;
  for (const [x, y, w] of pts) { mxx += w * (x - cx) ** 2; myy += w * (y - cy) ** 2; }
  mxx /= sw; myy /= sw;
  const snr = sw / (st.sigma * Math.sqrt(npx));
  if (snr < 3) return null;
  // Statistical term plus a 0.1 px systematic floor (reprojection + undersampled PSF), in quadrature.
  const floor = 0.1;
  const ex = Math.hypot(Math.sqrt(Math.max(mxx, 0.09)) / snr, floor);
  const ey = Math.hypot(Math.sqrt(Math.max(myy, 0.09)) / snr, floor);
  return { x: cx, y: cy, sx: ex, sy: ey, snr, flux: sw };
}

/**
 * Client-side aperture estimate on the reprojected grid (no VARIANCE available):
 * flux = Σ(I − bg)·Ω, error from annulus RMS. Units: mJy.
 */
export function gridAperture(pix: ArrayLike<number>, n: number, x0: number, y0: number, rPix: number, pixscaleArcsec: number) {
  const ann: number[] = [];
  let sum = 0, npx = 0;
  for (let y = Math.floor(y0 - rPix - 5); y <= Math.ceil(y0 + rPix + 5); y++) {
    for (let x = Math.floor(x0 - rPix - 5); x <= Math.ceil(x0 + rPix + 5); x++) {
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const d = Math.hypot(x - x0, y - y0);
      const v = pix[y * n + x];
      if (d <= rPix) {
        if (!Number.isFinite(v)) return null;
        sum += v; npx++;
      } else if (d >= rPix + 1.5 && d <= rPix + 4.5 && Number.isFinite(v)) ann.push(v);
    }
  }
  if (!npx || ann.length < 8) return null;
  const st = robustStats(ann);
  const omega = (pixscaleArcsec / 206264.806) ** 2; // sr
  const flux = (sum - npx * st.median) * omega * 1e9; // MJy -> mJy
  const err = st.sigma * Math.sqrt(npx + (npx * npx * 1.57) / ann.length) * omega * 1e9;
  return { flux, err };
}

export const FLAG_DISPLAY = ['OVERFLOW', 'BLOOM', 'GHOST', 'CROSSTALK', 'PERSIST', 'TRANSIENT', 'NONFUNC', 'SUR_ERROR', 'HALO', 'STREAK'];

export const DEFAULT_FLAG_BITS: Record<string, number> = {
  TRANSIENT: 0, OVERFLOW: 1, SUR_ERROR: 2, NONFUNC: 6, DICHROIC: 7, MISSING_DATA: 9, HOT: 10, COLD: 11,
  FULLSAMPLE: 12, PHANMISS: 14, NONLINEAR: 15, PERSIST: 17, OUTLIER: 19, CROSSTALK: 20, SOURCE: 21,
  GHOST: 22, GHOST_FPA: 23, GHOST_EXT: 24, STREAK: 25, BLOOM: 26, SNOWBALL: 27, HALO: 28,
};

export function flagNames(value: number, bits: Record<string, number>): string[] {
  return Object.entries(bits).filter(([, b]) => (value >>> 0) & (1 << b)).map(([k]) => k).sort();
}

/**
 * Molecular band-depth "goggles". Recipe (documented in UI):
 *   depth = 1 − F_band / F_cont, F_cont = linear interpolation (in λ) between two continuum windows;
 *   each window image = median of background-subtracted frames whose λ at the field centre falls inside it.
 * Windows chosen around the main cool-atmosphere absorbers in SPHEREx range.
 */
export const GOGGLES = {
  CH4: { band: [3.2, 3.45], blue: [2.95, 3.1], red: [3.95, 4.15] },
  H2O: { band: [2.6, 2.85], blue: [2.15, 2.35], red: [3.55, 3.8] },
  CO2: { band: [4.22, 4.35], blue: [4.05, 4.18], red: [4.45, 4.6] },
} as const;
export type GoggleId = keyof typeof GOGGLES;

export function goggleMap(frames: Frame[], id: GoggleId) {
  const g = GOGGLES[id];
  const pick = (w: readonly [number, number]) => frames.filter((f) => f.lambda_um >= w[0] && f.lambda_um <= w[1]);
  const band = pick(g.band), blue = pick(g.blue), red = pick(g.red);
  const counts = { band: band.length, blue: blue.length, red: red.length };
  if (!band.length || !blue.length || !red.length) return { map: null, counts };
  const mean = (fs: Frame[]) => fs.reduce((a, f) => a + f.lambda_um, 0) / fs.length;
  const lb = mean(band), l1 = mean(blue), l2 = mean(red);
  const B = medianStack(band), C1 = medianStack(blue), C2 = medianStack(red);
  const t = (lb - l1) / (l2 - l1);
  const n = B.length;
  const noise = robustStats(C1).sigma + robustStats(C2).sigma;
  const map = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cont = C1[i] + (C2[i] - C1[i]) * t;
    // only where continuum is clearly detected (> 5σ of the continuum images' noise)
    map[i] = Number.isFinite(cont) && cont > 5 * noise && Number.isFinite(B[i]) ? 1 - B[i] / cont : NaN;
  }
  return { map, counts };
}
