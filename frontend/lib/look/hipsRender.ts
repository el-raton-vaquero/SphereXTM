/**
 * Client-side renderer for the official SPHEREx DR1 all-sky HiPS cube served by IRSA.
 *
 *   base   https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube   (CORS: *)
 *   /properties (checked 2026-11-14): obs_title "SPHEREx DR1 all-sky data cube",
 *   dataproduct_type=cube, hips_cube_depth=102, hips_order=5, hips_tile_width=512,
 *   hips_tile_format=png (8-bit grey palette, index 0 = transparent = no data),
 *   hips_pixel_function=asinh, hips_pixel_cut=0 40 (MJy/sr), hips_frame=equatorial,
 *   t_min 60789.75 / t_max 61174.49 (MJD), hips_creator "SPHEREx Science Data Center",
 *   hips_copyright Caltech/IPAC, obs_copyright NASA/SPHEREx.
 *   Frame f = 17*(band-1) + (channel-1), ascending wavelength; frames 50 and 51 (the dichroic
 *   channels) are blank. Tile of frame 0: NorderK/DirD/NpixN.png, frame f>0: NpixN_f.png.
 *   Norder3/Allsky.png (Allsky_f.png): all 768 order-3 tiles at 64x64 px, 27 per row.
 *
 * PNG tiles are display-stretched (asinh, cut 0..40 MJy/sr), so everything rendered or sampled
 * here is a picture of the data, not calibrated fluxes.
 *
 * Geometry: HEALPix NESTED (Gorski et al. 2005) as in healpix_base loc2pix. Inside a tile, the
 * HiPS 1.0 convention (as drawn by Aladin / Aladin Lite) puts the face-local HEALPix x axis
 * (south corner -> east corner) along the image rows (downwards) and the y axis (south corner ->
 * west corner) along the image columns: PNG column = y, PNG row (from the top) = x. So a raw
 * PNG tile shows the south corner top-left and the north corner bottom-right (the familiar
 * "upside-down" look of HiPS image tiles). Verified against bright stars (Betelgeuse, Rigel,
 * Bellatrix, Pleiades) at orders 3 and 5 and in the Allsky image.
 *
 * No dependencies; runs in the browser (fetch + createImageBitmap + canvas).
 */
import type { HipsLayer, TanWcs } from './hips';

export const IRSA_HIPS_BASE = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
export const IRSA_HIPS_ID = 'ivo://IPAC/P/SPHEREx/DR1/cube';
export const IRSA_HIPS_PROPERTIES = `${IRSA_HIPS_BASE}/properties`;
export const CUBE_DEPTH = 102;
export const BLANK_FRAMES: readonly number[] = [50, 51];
const TILE_W = 512;
const ALLSKY_W = 64;
const ALLSKY_COLS = 27;
const MAX_ORDER = 5;
const MIN_ORDER = 3;

/** Central wavelength (um) of every cube frame, from data_cube_crval3_arr in /properties. */
export const FRAME_UM: readonly number[] = [
  0.753, 0.771, 0.790, 0.809, 0.828, 0.848, 0.868, 0.889, 0.910, 0.932, 0.955, 0.978, 1.001, 1.025, 1.050, 1.075, 1.102,
  1.113, 1.139, 1.167, 1.195, 1.224, 1.254, 1.284, 1.315, 1.346, 1.378, 1.412, 1.446, 1.481, 1.517, 1.554, 1.592, 1.631,
  1.656, 1.695, 1.735, 1.775, 1.818, 1.861, 1.905, 1.949, 1.995, 2.041, 2.089, 2.139, 2.189, 2.240, 2.292, 2.345, 2.399,
  2.445, 2.506, 2.575, 2.646, 2.719, 2.794, 2.871, 2.951, 3.033, 3.118, 3.204, 3.293, 3.383, 3.476, 3.570, 3.667, 3.768,
  3.833, 3.867, 3.901, 3.935, 3.970, 4.005, 4.040, 4.076, 4.112, 4.148, 4.184, 4.220, 4.257, 4.294, 4.331, 4.368, 4.405,
  4.435, 4.467, 4.500, 4.533, 4.566, 4.600, 4.635, 4.669, 4.704, 4.739, 4.773, 4.808, 4.843, 4.879, 4.915, 4.951, 4.988,
];

/**
 * Frames shown for each UI layer. Colour = blue 1.00 um (D1), green 2.19 um (D3), red 4.00 um (D5);
 * detector layers use the middle channel (9 of 17) of that detector.
 */
export const LAYER_FRAMES: Record<HipsLayer, number[]> = {
  color: [73, 46, 12], // R, G, B
  D1: [8], D2: [25], D3: [42], D4: [59], D5: [76], D6: [93],
};

// ---------------------------------------------------------------------------------------------
// HEALPix (nested)

/** Face number and continuous face coordinates x, y in [0, nside) of a unit vector. */
export function vecToFaceXY(vx: number, vy: number, vz: number, nside: number): { face: number; x: number; y: number } {
  const z = vz, za = Math.abs(z);
  let tt = Math.atan2(vy, vx) / (Math.PI / 2);
  if (tt < 0) tt += 4;
  if (tt >= 4) tt -= 4;
  let face: number, x: number, y: number;
  if (za <= 2 / 3) {
    const t1 = nside * (0.5 + tt), t2 = nside * z * 0.75;
    const jp = t1 - t2, jm = t1 + t2;
    const ifp = Math.floor(jp / nside), ifm = Math.floor(jm / nside);
    face = ifp === ifm ? (ifp | 4) : ifp < ifm ? ifp : ifm + 8;
    x = jm - ifm * nside;
    y = nside - (jp - ifp * nside);
  } else {
    const ntt = Math.min(3, Math.floor(tt));
    const tp = tt - ntt;
    const oneMinusZa = (vx * vx + vy * vy) / (1 + za); // = 1 - |z|, precise near the poles
    const tmp = nside * Math.sqrt(3 * oneMinusZa);
    const jp = Math.min(nside, tp * tmp), jm = Math.min(nside, (1 - tp) * tmp);
    if (z >= 0) { face = ntt; x = nside - jm; y = nside - jp; } else { face = ntt + 8; x = jp; y = jm; }
  }
  const top = nside * (1 - 1e-12);
  return { face, x: Math.min(top, Math.max(0, x)), y: Math.min(top, Math.max(0, y)) };
}

function spread(v: number): number {
  // interleave the bits of v (< 2^13) with zeros
  let r = 0;
  for (let b = 0; v >> b; b++) r += ((v >> b) & 1) * 2 ** (2 * b);
  return r;
}

/** Nested index of a cell at `order` from its face and integer face coordinates. */
export function nestIndex(order: number, face: number, ix: number, iy: number): number {
  return face * 4 ** order + spread(ix) + 2 * spread(iy);
}

export function radecToUnit(raDeg: number, decDeg: number): [number, number, number] {
  const a = (raDeg * Math.PI) / 180, d = (decDeg * Math.PI) / 180;
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}

/**
 * HiPS tile + pixel holding a direction. `width` is the tile width (512, or 64 for Allsky).
 * col/row are continuous PNG coordinates (row 0 at the top; pixel centres at i + 0.5).
 */
export function locateInTile(v: readonly number[], order: number, width: number): { npix: number; col: number; row: number } {
  const nside = 2 ** order * width;
  const { face, x, y } = vecToFaceXY(v[0], v[1], v[2], nside);
  const tx = Math.floor(x / width), ty = Math.floor(y / width);
  return { npix: nestIndex(order, face, tx, ty), col: y - ty * width, row: x - tx * width };
}

/** HEALPix pixel size (deg) at nside. */
const pixDeg = (nside: number) => (Math.sqrt((4 * Math.PI) / (12 * nside * nside)) * 180) / Math.PI;

// ---------------------------------------------------------------------------------------------
// TAN WCS -> directions

/** Unit vector of FITS pixel (p1, p2) (1-based, y up) of a TAN WCS. */
function wcsBasis(w: TanWcs) {
  const c = radecToUnit(w.crval1, w.crval2);
  const a = (w.crval1 * Math.PI) / 180, d = (w.crval2 * Math.PI) / 180;
  const e = [-Math.sin(a), Math.cos(a), 0];
  const n = [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)];
  const k = Math.PI / 180;
  const cd = [w.cd[0][0] * k, w.cd[0][1] * k, w.cd[1][0] * k, w.cd[1][1] * k];
  return (p1: number, p2: number, out: number[]) => {
    const dx = p1 - w.crpix1, dy = p2 - w.crpix2;
    const xi = cd[0] * dx + cd[1] * dy, eta = cd[2] * dx + cd[3] * dy;
    const x = c[0] + xi * e[0] + eta * n[0], y = c[1] + xi * e[1] + eta * n[1], z = c[2] + xi * e[2] + eta * n[2];
    const r = Math.hypot(x, y, z);
    out[0] = x / r; out[1] = y / r; out[2] = z / r;
  };
}

/** Output pixel scale (deg/px) of a WCS. */
export function wcsScaleDeg(w: TanWcs): number {
  const sx = Math.hypot(w.cd[0][0], w.cd[1][0]), sy = Math.hypot(w.cd[0][1], w.cd[1][1]);
  return Math.sqrt(sx * sy);
}

// ---------------------------------------------------------------------------------------------
// Tile loading: fetch + decode to an 8-bit grey array (0 = no data), LRU cache, abortable

export type Gray = Uint8Array; // width*width values, 0 = no data
export interface Level { order: number; allsky: boolean; width: number }

export function tileUrl(order: number, npix: number, frame: number): string {
  const dir = Math.floor(npix / 10000) * 10000;
  return `${IRSA_HIPS_BASE}/Norder${order}/Dir${dir}/Npix${npix}${frame > 0 ? `_${frame}` : ''}.png`;
}
export function allskyUrl(frame: number): string {
  return `${IRSA_HIPS_BASE}/Norder3/Allsky${frame > 0 ? `_${frame}` : ''}.png`;
}

interface CacheEntry { promise: Promise<Gray | null>; bytes: number; waiters: number; ctrl: AbortController; done: boolean }
const CACHE = new Map<string, CacheEntry>();
const CACHE_BUDGET = 96 * 1024 * 1024;
let cacheBytes = 0;
let active = 0;
const queue: (() => void)[] = [];
const MAX_PARALLEL = 8;

function slot(signal: AbortSignal): Promise<void> {
  if (active < MAX_PARALLEL) { active++; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const go = () => { signal.removeEventListener('abort', onAbort); active++; resolve(); };
    const onAbort = () => { const i = queue.indexOf(go); if (i >= 0) queue.splice(i, 1); reject(abortError()); };
    queue.push(go);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
function release() { active--; const next = queue.shift(); if (next) next(); }

function abortError() { return new DOMException('Aborted', 'AbortError'); }
export const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

function evict() {
  if (cacheBytes <= CACHE_BUDGET) return;
  for (const [k, e] of CACHE) {
    if (cacheBytes <= CACHE_BUDGET) break;
    if (!e.done || e.waiters > 0) continue;
    CACHE.delete(k);
    cacheBytes -= e.bytes;
  }
}

/** Decode a PNG blob (createImageBitmap, or an <img> where that is missing). */
async function decodeImage(blob: Blob): Promise<{ src: CanvasImageSource; w: number; h: number; done: () => void }> {
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    return { src: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, done: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function decodeGray(blob: Blob): Promise<{ data: Uint8Array; w: number; h: number }> {
  const bmp = await decodeImage(blob);
  const { w, h } = bmp;
  const cv: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = cv.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bmp.src, 0, 0);
  bmp.done();
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    // grey palette: R = value; alpha 0 = no data. Keep 0 reserved for "no data".
    out[i] = rgba[j + 3] === 0 ? 0 : Math.max(1, rgba[j]);
  }
  return { data: out, w, h };
}

async function fetchGray(url: string, signal: AbortSignal): Promise<Gray | null> {
  await slot(signal);
  try {
    const res = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { data } = await decodeGray(await res.blob());
    return data;
  } finally {
    release();
  }
}

/**
 * Cached, shared, abortable load. Several callers may wait on one request; the network request
 * is only aborted when every waiter has aborted.
 */
function loadCached(url: string, signal: AbortSignal | undefined, load: (s: AbortSignal) => Promise<Gray | null>): Promise<Gray | null> {
  if (signal?.aborted) return Promise.reject(abortError());
  let e = CACHE.get(url);
  if (e) { CACHE.delete(url); CACHE.set(url, e); } // LRU touch
  else {
    const ctrl = new AbortController();
    const entry: CacheEntry = { promise: Promise.resolve(null), bytes: 0, waiters: 0, ctrl, done: false };
    entry.promise = load(ctrl.signal).then(
      (g) => { entry.done = true; entry.bytes = g ? g.byteLength : 0; cacheBytes += entry.bytes; evict(); return g; },
      (err) => { if (CACHE.get(url) === entry) CACHE.delete(url); throw err; },
    );
    entry.promise.catch(() => {});
    CACHE.set(url, entry);
    e = entry;
  }
  const entry = e;
  if (entry.done || !signal) return entry.promise;
  entry.waiters++;
  return new Promise<Gray | null>((resolve, reject) => {
    const onAbort = () => {
      entry.waiters--;
      if (entry.waiters <= 0 && !entry.done) { entry.ctrl.abort(); if (CACHE.get(url) === entry) CACHE.delete(url); }
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    entry.promise.then(
      (g) => { signal.removeEventListener('abort', onAbort); entry.waiters--; resolve(g); },
      (err) => { signal.removeEventListener('abort', onAbort); entry.waiters--; reject(err); },
    );
  });
}

/** One tile (order 3..5) of one frame, as grey values (null when the tile does not exist). */
export function loadTile(order: number, npix: number, frame: number, signal?: AbortSignal): Promise<Gray | null> {
  const url = tileUrl(order, npix, frame);
  return loadCached(url, signal, (s) => fetchGray(url, s));
}

/** The Allsky image of a frame, split into 768 grey 64x64 tiles. */
const ALLSKY_SPLIT = new Map<number, Promise<Gray[] | null>>();
function loadAllsky(frame: number, signal?: AbortSignal): Promise<Gray[] | null> {
  const url = allskyUrl(frame);
  const whole = loadCached(url, signal, (s) => fetchGray(url, s));
  return whole.then((g) => {
    if (!g) return null;
    let p = ALLSKY_SPLIT.get(frame);
    if (!p) {
      const W = ALLSKY_COLS * ALLSKY_W;
      const tiles: Gray[] = [];
      for (let n = 0; n < 768; n++) {
        const t = new Uint8Array(ALLSKY_W * ALLSKY_W);
        const ox = (n % ALLSKY_COLS) * ALLSKY_W, oy = Math.floor(n / ALLSKY_COLS) * ALLSKY_W;
        for (let r = 0; r < ALLSKY_W; r++) t.set(g.subarray((oy + r) * W + ox, (oy + r) * W + ox + ALLSKY_W), r * ALLSKY_W);
        tiles.push(t);
      }
      p = Promise.resolve(tiles);
      ALLSKY_SPLIT.set(frame, p);
      if (ALLSKY_SPLIT.size > 8) ALLSKY_SPLIT.delete(ALLSKY_SPLIT.keys().next().value as number);
    }
    return p;
  });
}

// ---------------------------------------------------------------------------------------------
// Rendering

/** Bilinear sample of a grey tile at continuous (col, row); no-data neighbours are skipped. */
export function sampleGray(t: Gray, w: number, col: number, row: number): number {
  const fx = Math.min(w - 1, Math.max(0, col - 0.5)), fy = Math.min(w - 1, Math.max(0, row - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(w - 1, y0 + 1);
  const ax = fx - x0, ay = fy - y0;
  const v00 = t[y0 * w + x0], v10 = t[y0 * w + x1], v01 = t[y1 * w + x0], v11 = t[y1 * w + x1];
  let s = 0, ws = 0;
  if (v00) { const k = (1 - ax) * (1 - ay); s += v00 * k; ws += k; }
  if (v10) { const k = ax * (1 - ay); s += v10 * k; ws += k; }
  if (v01) { const k = (1 - ax) * ay; s += v01 * k; ws += k; }
  if (v11) { const k = ax * ay; s += v11 * k; ws += k; }
  return ws > 1e-6 ? s / ws : 0;
}

/** Per-output-pixel lookup into the tiles of one level. */
export interface RenderPlan {
  wcs: TanWcs;
  level: Level;
  tiles: number[];      // npix of every tile needed
  slot: Int32Array;     // per output pixel: index into tiles
  col: Float32Array;
  row: Float32Array;
}

/** Distinct tiles touched by a WCS at a level (sampled on a coarse grid; used to pick the level). */
function tilesTouched(w: TanWcs, level: Level, grid = 40): number {
  const toVec = wcsBasis(w), v = [0, 0, 0], set = new Set<number>();
  for (let j = 0; j <= grid; j++) for (let i = 0; i <= grid; i++) {
    toVec(0.5 + (w.naxis1 * i) / grid, 0.5 + (w.naxis2 * j) / grid, v);
    set.add(locateInTile(v, level.order, level.width).npix);
  }
  return set.size;
}

/**
 * Pick the level: the coarsest order (3..5) whose pixels are no larger than the output pixels,
 * stepping to coarser orders (and finally the 64 px Allsky thumbnails) when the view would need
 * more than `maxRequests` tile downloads for `nFrames` frames.
 */
export function chooseLevel(w: TanWcs, nFrames: number, maxRequests = 60): Level {
  const s = wcsScaleDeg(w);
  let order = MIN_ORDER;
  while (order < MAX_ORDER && pixDeg(2 ** order * TILE_W) > s) order++;
  for (; order >= MIN_ORDER; order--) {
    const lv = { order, allsky: false, width: TILE_W };
    if (tilesTouched(w, lv) * nFrames <= maxRequests) return lv;
  }
  return { order: 3, allsky: true, width: ALLSKY_W };
}

export function planRender(w: TanWcs, level: Level): RenderPlan {
  const W = w.naxis1, H = w.naxis2, n = W * H;
  const slotArr = new Int32Array(n), col = new Float32Array(n), row = new Float32Array(n);
  const index = new Map<number, number>(), tiles: number[] = [];
  const toVec = wcsBasis(w), v = [0, 0, 0];
  for (let j = 0; j < H; j++) {
    const p2 = H - j; // canvas row j (top-down) -> FITS y
    for (let i = 0; i < W; i++) {
      toVec(i + 1, p2, v);
      const t = locateInTile(v, level.order, level.width);
      let k = index.get(t.npix);
      if (k === undefined) { k = tiles.length; tiles.push(t.npix); index.set(t.npix, k); }
      const o = j * W + i;
      slotArr[o] = k; col[o] = t.col; row[o] = t.row;
    }
  }
  return { wcs: w, level, tiles, slot: slotArr, col, row };
}

async function loadFrameTiles(plan: RenderPlan, frame: number, signal?: AbortSignal, onTile?: () => void): Promise<(Gray | null)[]> {
  if (plan.level.allsky) {
    const all = await loadAllsky(frame, signal);
    onTile?.();
    return plan.tiles.map((n) => (all ? all[n] ?? null : null));
  }
  return Promise.all(plan.tiles.map((n) => loadTile(plan.level.order, n, frame, signal).then((g) => { onTile?.(); return g; })));
}

/** Sample one frame through a plan: grey values per output pixel (0 = no data). */
function sampleFrame(plan: RenderPlan, tiles: (Gray | null)[]): Uint8Array {
  const n = plan.slot.length, out = new Uint8Array(n), w = plan.level.width;
  for (let o = 0; o < n; o++) {
    const t = tiles[plan.slot[o]];
    if (t) out[o] = Math.round(sampleGray(t, w, plan.col[o], plan.row[o]));
  }
  return out;
}

/** Display stretch of one channel: map its [p_lo, p_hi] percentiles onto 0..255. */
function stretchLut(values: Uint8Array, lo = 0.1, hi = 0.997): Uint8Array {
  const hist = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < values.length; i++) { const v = values[i]; if (v) { hist[v]++; count++; } }
  const lut = new Uint8Array(256);
  if (!count) return lut;
  const pick = (q: number) => { let acc = 0; for (let v = 1; v < 256; v++) { acc += hist[v]; if (acc >= q * count) return v; } return 255; };
  const a = pick(lo), b = Math.max(a + 12, pick(hi));
  for (let v = 1; v < 256; v++) lut[v] = Math.round(255 * Math.min(1, Math.max(0, (v - a) / (b - a))) ** 0.9);
  return lut;
}

export interface RenderResult {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  level: Level;
  frames: number[];
  lambdaUm: number[];
  tiles: number;
  coverage: number; // fraction of output pixels with data
}

/**
 * Render a HiPS layer for an arbitrary TAN WCS (any CD matrix, including rotation/flip) into RGBA.
 * Throws AbortError when `signal` aborts; throws an Error when no tile could be loaded.
 */
export async function renderHips(w: TanWcs, layer: HipsLayer, opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; maxRequests?: number } = {}): Promise<RenderResult> {
  const frames = LAYER_FRAMES[layer];
  const level = chooseLevel(w, frames.length, opts.maxRequests);
  const plan = planRender(w, level);
  const total = level.allsky ? frames.length : plan.tiles.length * frames.length;
  let done = 0;
  opts.onProgress?.(0, total);
  const tick = () => { done++; opts.onProgress?.(done, total); };
  const perFrame = await Promise.all(frames.map((f) => loadFrameTiles(plan, f, opts.signal, tick)));
  if (opts.signal?.aborted) throw abortError();
  if (perFrame.every((ts) => ts.every((t) => !t))) throw new Error('no SPHEREx tiles for this view');
  const chans = perFrame.map((ts) => sampleFrame(plan, ts));
  const luts = chans.map((c) => stretchLut(c));
  const n = plan.slot.length, rgba = new Uint8ClampedArray(n * 4);
  let covered = 0;
  for (let o = 0, j = 0; o < n; o++, j += 4) {
    if (chans.length === 3) {
      const r = chans[0][o], g = chans[1][o], b = chans[2][o];
      rgba[j] = luts[0][r]; rgba[j + 1] = luts[1][g]; rgba[j + 2] = luts[2][b];
      const has = r || g || b;
      rgba[j + 3] = has ? 255 : 0;
      if (has) covered++;
    } else {
      const v = chans[0][o], y = luts[0][v];
      rgba[j] = y; rgba[j + 1] = y; rgba[j + 2] = y; rgba[j + 3] = v ? 255 : 0;
      if (v) covered++;
    }
  }
  return { rgba, width: w.naxis1, height: w.naxis2, level, frames, lambdaUm: frames.map((f) => FRAME_UM[f]), tiles: plan.tiles.length, coverage: covered / n };
}

// ---------------------------------------------------------------------------------------------
// Spectrum at one position (for a later "symphony anywhere in the sky")

export interface HipsSpectrum {
  ra: number; dec: number; order: number;
  lambda_um: number[];
  /** Display-stretched brightness 0..1 (asinh, cut 0..40 MJy/sr), null for blank/missing frames. */
  value: (number | null)[];
}
const SPECTRA = new Map<string, Promise<HipsSpectrum>>();

/**
 * Fetch all 102 frame tiles at (ra, dec) and return the display-stretched value per frame, the
 * mean of non-empty pixels within `radiusPx` tile pixels (clamped to the tile). Lazy (nothing is
 * fetched before the call), cancellable via `signal`, cached per position/order/radius.
 */
export function sampleSpectrum(ra: number, dec: number, radiusPx = 1, opts: { order?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<HipsSpectrum> {
  const order = Math.max(MIN_ORDER, Math.min(MAX_ORDER, Math.round(opts.order ?? MAX_ORDER)));
  const key = `${ra.toFixed(5)},${dec.toFixed(5)},${order},${radiusPx}`;
  const hit = SPECTRA.get(key);
  if (hit) return hit;
  const v = radecToUnit(ra, dec);
  const { npix, col, row } = locateInTile(v, order, TILE_W);
  const r = Math.max(0, Math.round(radiusPx));
  const c0 = Math.floor(col), r0 = Math.floor(row);
  let done = 0;
  const p = Promise.all(FRAME_UM.map(async (_um, f) => {
    if (BLANK_FRAMES.includes(f)) { opts.onProgress?.(++done, CUBE_DEPTH); return null; }
    const t = await loadTile(order, npix, f, opts.signal);
    opts.onProgress?.(++done, CUBE_DEPTH);
    if (!t) return null;
    let s = 0, k = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = Math.min(TILE_W - 1, Math.max(0, c0 + dx)), y = Math.min(TILE_W - 1, Math.max(0, r0 + dy));
      const g = t[y * TILE_W + x];
      if (g) { s += g; k++; }
    }
    return k ? s / k / 254 : null;
  })).then((value) => ({ ra, dec, order, lambda_um: FRAME_UM.slice(), value }));
  SPECTRA.set(key, p);
  p.catch(() => { if (SPECTRA.get(key) === p) SPECTRA.delete(key); });
  if (SPECTRA.size > 64) SPECTRA.delete(SPECTRA.keys().next().value as string);
  return p;
}
