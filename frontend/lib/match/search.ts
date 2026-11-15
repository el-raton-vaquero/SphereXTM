/**
 * Star Match: comparing the song profile with real SPHEREx sky spectra. Pure (no DOM); runs in
 * the match worker (and on the main thread as a fallback).
 *
 * Similarity = Pearson correlation over the valid bands between the song's 102-band character
 * profile (bands.ts) and a sky point's 102-band z-scores (per band, against the sky median).
 * Band i of the song pairs with cube frame i (ascending wavelength = descending pitch).
 */
import { sepDeg, tilePixelRadec } from './healpix';

export interface CoarseInput {
  song: number[];
  z: Int8Array;
  coords: Float32Array;
  npix: number;
  nbands: number;
  valid: boolean[];
  zPerUnit: number;
  missing: number | null;
  top?: number;
  minSepDeg?: number;
}

export interface CoarseHit { pix: number; r: number; ra: number; dec: number; z: number[] }

/** Song vector restricted to the bands used, plus the band list. */
function songBands(song: number[], valid: boolean[], nb: number) {
  const bands: number[] = [];
  for (let b = 0; b < nb; b++) if (valid[b] !== false && Number.isFinite(song[b])) bands.push(b);
  return bands;
}

/** Top `top` index pixels by correlation, at least `minSepDeg` apart (no neighbouring pixels). */
export function coarseSearch(inp: CoarseInput): { hits: CoarseHit[]; compared: number } {
  const { song, z, coords, npix, nbands: nb, valid, zPerUnit, missing } = inp;
  const top = inp.top ?? 50, minSep = inp.minSepDeg ?? 3;
  const bands = songBands(song, valid, nb);
  const r = new Float32Array(npix).fill(NaN);
  let compared = 0;
  for (let p = 0; p < npix; p++) {
    const o = p * nb;
    let n = 0, sx = 0, sxx = 0, sy = 0, syy = 0, sxy = 0;
    for (const b of bands) {
      const q = z[o + b];
      if (missing !== null && q === missing) continue;
      const x = q * zPerUnit, y = song[b];
      n++; sx += x; sxx += x * x; sy += y; syy += y * y; sxy += x * y;
    }
    if (n < bands.length * 0.8) continue;
    const vx = sxx - (sx * sx) / n, vy = syy - (sy * sy) / n;
    if (vx <= 1e-9 || vy <= 1e-9) continue;
    r[p] = (sxy - (sx * sy) / n) / Math.sqrt(vx * vy);
    compared++;
  }
  const order = Array.from({ length: npix }, (_, i) => i).filter((i) => Number.isFinite(r[i])).sort((a, b) => r[b] - r[a]);
  const hits: CoarseHit[] = [];
  for (const p of order) {
    if (hits.length >= top) break;
    const ra = coords[2 * p], dec = coords[2 * p + 1];
    if (hits.some((h) => sepDeg(h.ra, h.dec, ra, dec) < minSep)) continue;
    const zz: number[] = [];
    for (let b = 0; b < nb; b++) { const q = z[p * nb + b]; zz.push(missing !== null && q === missing ? NaN : q * zPerUnit); }
    hits.push({ pix: p, r: r[p], ra, dec, z: zz });
  }
  return { hits, compared };
}

export interface TileInput {
  song: number[];
  /** 102 grey frames of one order-5 tile (512 x 512, 0 = no data), null where missing. */
  frames: (Uint8Array | null)[];
  valid: boolean[];
  /** Per-band sky median (grey units) from index.json. */
  median: number[];
  /** Per-band sky spread (grey units) from index.json, or null. */
  spread: number[] | null;
  order: number;
  npix: number;
  width: number;
  /** Keep at most this many separated candidates from the tile. */
  keep?: number;
}

export interface FineHit { r: number; ra: number; dec: number; npix: number; col: number; row: number; z: number[]; grey: number[] }

/** Robust (median, MAD-sigma) of the non-zero values of one frame, from the histogram of every 5th pixel. */
function robustStats(t: Uint8Array): { med: number; sig: number; count: number } {
  const h = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < t.length; i += 5) { const v = t[i]; if (v) { h[v]++; n++; } }
  if (!n) return { med: NaN, sig: NaN, count: 0 };
  const q = (f: number) => { let acc = 0; for (let v = 1; v < 256; v++) { acc += h[v]; if (acc >= f * n) return v; } return 255; };
  const med = q(0.5);
  const dev = new Uint32Array(256);
  for (let v = 1; v < 256; v++) if (h[v]) dev[Math.abs(v - med)] += h[v];
  let acc = 0, mad = 0;
  for (let d = 0; d < 256; d++) { acc += dev[d]; if (acc >= 0.5 * n) { mad = d; break; } }
  return { med, sig: Math.max(1, 1.4826 * mad), count: n };
}

/**
 * Compare EVERY pixel of one tile with the song. Pixel spectra are normalised like the index:
 * z = (grey - sky median) / s, where s = max(index spread, this tile's robust sigma, 1 grey level):
 * the coarse index was built from smoother (averaged) values, so a full-resolution pixel's noise
 * is larger than the index spread; using the tile's robust sigma when it is larger keeps noisy
 * bands from dominating. Pixels with no data (transparent) in more than 10 % of the bands, or
 * saturated (255) in more than 10 %, are skipped.
 */
export function compareTile(inp: TileInput): { hits: FineHit[]; compared: number } {
  const { song, frames, valid, median, spread, order, npix, width: W } = inp;
  const keep = inp.keep ?? 6;
  const nb = frames.length, N = W * W;
  const bands: number[] = [];
  const luts: Float32Array[] = [];
  for (let b = 0; b < nb; b++) {
    const t = frames[b];
    if (!t || valid[b] === false || !Number.isFinite(song[b])) continue;
    const st = robustStats(t);
    if (!st.count) continue;
    const m = Number.isFinite(median[b]) ? median[b] : st.med;
    const s = Math.max(spread && Number.isFinite(spread[b]) ? spread[b] : 0, st.sig, 1);
    const lut = new Float32Array(256);
    for (let v = 1; v < 256; v++) lut[v] = (v - m) / s;
    bands.push(b); luts.push(lut);
  }
  if (bands.length < 20) return { hits: [], compared: 0 };
  // Accumulate x sums per pixel; the song sums are known for a complete pixel, so only the bands a
  // pixel is MISSING are accumulated (rare) and subtracted.
  let SY = 0, SYY = 0;
  for (const b of bands) { SY += song[b]; SYY += song[b] * song[b]; }
  const need = Math.ceil(bands.length * 0.9), satMax = Math.floor(bands.length * 0.1), nb2 = bands.length;
  const lutXX = luts.map((l) => l.map((x) => x * x));
  const lutXY = luts.map((l, k) => l.map((x) => x * song[bands[k]]));
  // best pixel per 32 x 32 cell, then greedy selection of separated cells
  const CELL = 32, nc = W / CELL;
  const cellR = new Float32Array(nc * nc).fill(-2), cellP = new Int32Array(nc * nc).fill(-1);
  let compared = 0;
  // pixel blocks keep the accumulators in cache (every frame is read sequentially per block)
  const B = 2048;
  const sx = new Float64Array(B), sxx = new Float64Array(B), sxy = new Float64Array(B);
  const my = new Float64Array(B), myy = new Float64Array(B), miss = new Uint8Array(B), sat = new Uint8Array(B);
  for (let p0 = 0; p0 < N; p0 += B) {
    const len = Math.min(B, N - p0);
    sx.fill(0); sxx.fill(0); sxy.fill(0); my.fill(0); myy.fill(0); miss.fill(0); sat.fill(0);
    for (let k = 0; k < nb2; k++) {
      const t = frames[bands[k]] as Uint8Array, lx = luts[k], lxx = lutXX[k], lxy = lutXY[k], y = song[bands[k]], yy = y * y;
      for (let i = 0; i < len; i++) {
        const v = t[p0 + i];
        if (v === 0) { miss[i]++; my[i] += y; myy[i] += yy; continue; }
        if (v === 255) sat[i]++;
        sx[i] += lx[v]; sxx[i] += lxx[v]; sxy[i] += lxy[v];
      }
    }
    for (let i = 0; i < len; i++) {
      const n = nb2 - miss[i];
      if (n < need || sat[i] > satMax) continue;
      const sy = SY - my[i], syy = SYY - myy[i];
      const vx = sxx[i] - (sx[i] * sx[i]) / n, vy = syy - (sy * sy) / n;
      if (vx <= 1e-6 || vy <= 1e-6) continue;
      compared++;
      const r = (sxy[i] - (sx[i] * sy) / n) / Math.sqrt(vx * vy);
      const p = p0 + i, row = (p / W) | 0, col = p - row * W;
      const c = ((row / CELL) | 0) * nc + ((col / CELL) | 0);
      if (r > cellR[c]) { cellR[c] = r; cellP[c] = p; }
    }
  }
  const cells = Array.from({ length: nc * nc }, (_, i) => i).filter((i) => cellP[i] >= 0).sort((a, b) => cellR[b] - cellR[a]);
  const chosen: number[] = [];
  for (const c of cells) {
    if (chosen.length >= keep) break;
    const p = cellP[c], row = (p / W) | 0, col = p - row * W;
    if (chosen.some((q) => { const r2 = (q / W) | 0, c2 = q - r2 * W; return Math.hypot(r2 - row, c2 - col) < 48; })) continue;
    chosen.push(p);
  }
  const hits: FineHit[] = chosen.map((p) => {
    const row = (p / W) | 0, col = p - row * W;
    const { ra, dec } = tilePixelRadec(order, npix, col + 0.5, row + 0.5, W);
    const z: number[] = [], grey: number[] = [];
    for (let b = 0; b < nb; b++) {
      const t = frames[b];
      const v = t ? t[p] : 0;
      grey.push(v);
      const k = bands.indexOf(b);
      z.push(k >= 0 && v ? luts[k][v] : NaN);
    }
    return { r: cellR[Math.floor(row / CELL) * nc + Math.floor(col / CELL)], ra, dec, npix, col, row, z, grey };
  });
  return { hits, compared };
}
