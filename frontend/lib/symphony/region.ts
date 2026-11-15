/**
 * Real-data path for the star symphony: turn a cached SPHEREx snapshot (frames at many
 * wavelengths on one reprojected grid) into the spectrum of a circular sky region.
 *
 * Every frame is a real SPHEREx Level-2 image at one wavelength (MJy/sr). For a region we take
 * the mean of the usable pixels inside the circle in each frame, so the frames together give a
 * sampled spectrum. Nothing is interpolated or invented: wavelengths with no usable pixel stay
 * empty and are silent.
 */
import { DEFAULT_FLAG_BITS, medianStack, robustStats } from '../prism/imaging';
import type { SearchResult } from '../prism/types';

/** Pixels carrying any of these flags are left out of the region mean. */
const BAD_FLAGS = ['OVERFLOW', 'SUR_ERROR', 'NONFUNC', 'MISSING_DATA', 'HOT', 'COLD', 'NONLINEAR', 'PERSIST', 'OUTLIER', 'TRANSIENT'];

export type RegionMode = 'source' | 'sky';

interface PlateFrame {
  lambda_um: number;
  detector: number;
  pixels: Float32Array;
  good: Uint8Array;
  median: number;
}

export interface Plate {
  n: number;
  pixscale_arcsec: number;
  frames: PlateFrame[];
  /** Per-pixel median of background-subtracted frames (display only). */
  coadd: Float32Array;
}

function badMask(bits: Record<string, number>): number {
  let m = 0;
  for (const k of BAD_FLAGS) if (k in bits) m |= 1 << bits[k];
  return m >>> 0;
}

/** Pre-compute per-frame backgrounds, usable-pixel masks and the display co-add. */
export function preparePlate(search: SearchResult): Plate {
  const n = search.grid.n;
  const globalBits = search.flag_bits ?? DEFAULT_FLAG_BITS;
  const frames: PlateFrame[] = search.frames.map((f) => {
    const bits = ((f as unknown as { flag_bits?: Record<string, number> }).flag_bits) ?? globalBits;
    const mask = badMask(bits);
    const good = new Uint8Array(n * n);
    for (let i = 0; i < good.length; i++) good[i] = Number.isFinite(f.pixels[i]) && ((f.flags[i] >>> 0) & mask) === 0 ? 1 : 0;
    const st = robustStats(f.pixels, (i) => good[i] === 1);
    return { lambda_um: f.lambda_um, detector: f.detector, pixels: f.pixels, good, median: st.median };
  });
  return { n, pixscale_arcsec: search.grid.pixscale_arcsec, frames, coadd: medianStack(search.frames) };
}

export interface RegionSpectrum {
  lambda_um: number[];
  intensity: number[];
  /** Frames that contributed (had at least one usable pixel in the circle). */
  nFrames: number;
  /** Pixels inside the circle. */
  nPixels: number;
}

/**
 * Spectrum of the circle (cx, cy, r) in grid pixels (0-based, x = column from the East edge,
 * y = row from the North edge). mode 'source' subtracts each frame's robust sky median, so the
 * zodiacal glow that changes between dates cancels and only what is in the circle sings;
 * 'sky' keeps the full surface brightness.
 */
export function regionSpectrum(plate: Plate, cx: number, cy: number, r: number, mode: RegionMode): RegionSpectrum {
  const { n } = plate;
  const idx: number[] = [];
  const r2 = r * r;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(n - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(n - 1, Math.ceil(cx + r)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) idx.push(y * n + x);
    }
  }
  const lambda_um: number[] = [];
  const intensity: number[] = [];
  let nFrames = 0;
  for (const f of plate.frames) {
    let s = 0, c = 0;
    for (const i of idx) if (f.good[i]) { s += f.pixels[i]; c++; }
    lambda_um.push(f.lambda_um);
    if (!c || (mode === 'source' && !Number.isFinite(f.median))) { intensity.push(NaN); continue; }
    nFrames++;
    intensity.push(mode === 'source' ? s / c - f.median : s / c);
  }
  return { lambda_um, intensity, nFrames, nPixels: idx.length };
}

/** Brightest co-add pixel near the centre: a good default spot for the listening circle. */
export function brightestNearCentre(plate: Plate, within = 6): { x: number; y: number } {
  const { n, coadd } = plate;
  const c = (n - 1) / 2;
  let best = { x: c, y: c, v: -Infinity };
  for (let y = Math.round(c - within); y <= Math.round(c + within); y++) {
    for (let x = Math.round(c - within); x <= Math.round(c + within); x++) {
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const v = coadd[y * n + x];
      if (Number.isFinite(v) && v > best.v) best = { x, y, v };
    }
  }
  return { x: best.x, y: best.y };
}
