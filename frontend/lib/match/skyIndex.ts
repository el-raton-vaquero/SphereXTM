/**
 * Star Match: the all-sky spectral index in public/starmatch/ (built offline from the real
 * SPHEREx DR1 HiPS cube at IRSA; see public/starmatch/index.json for provenance and encoding).
 *
 *   index.json  metadata: order, npix, lambda_um[102], valid[102], per-band sky median (and
 *               scale), int8 encoding (z = value / scale; a sentinel marks missing values)
 *   index.bin   int8 z-scores, npix x 102 row-major (per-band robust z vs the sky median)
 *   coords.bin  Float32 (RA, Dec) of every pixel centre, deg
 *
 * Nothing is synthesised here: when the files are missing the loader says so ('missing').
 */

export interface SkyIndex {
  order: number;
  npix: number;
  nbands: number;
  lambdaUm: number[];
  valid: boolean[];
  /** Per-band sky median in 8-bit display grey units (1..255) of the HiPS PNG tiles. */
  median: number[];
  /** Per-band robust spread (grey units) used for the z-scores, when the index records it. */
  spread: number[] | null;
  /** int8 value -> z multiplier. */
  zPerUnit: number;
  /** int8 sentinel for "no data" (or null). */
  missing: number | null;
  z: Int8Array;
  coords: Float32Array;
  meta: Record<string, unknown>;
}

export class IndexMissingError extends Error {
  constructor() { super('index not built yet'); this.name = 'IndexMissingError'; }
}

const BASE = '/starmatch';

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
function numArr(v: unknown): number[] | null {
  return Array.isArray(v) && v.length && v.every((x) => typeof x === 'number' || x === null) ? (v as (number | null)[]).map((x) => (x === null ? NaN : x)) : null;
}
function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const parts = k.split('.');
    let cur: unknown = o;
    for (const p of parts) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[p] : undefined;
    if (cur !== undefined) return cur;
  }
  return undefined;
}

/** Interpret index.json (tolerant to a few naming variants; see the file itself for the truth). */
export function parseMeta(meta: Record<string, unknown>) {
  const order = num(pick(meta, ['order', 'healpix_order', 'hpx_order'])) ?? 6;
  const npix = num(pick(meta, ['npix', 'n_pix'])) ?? 12 * 4 ** order;
  const lambdaUm = numArr(pick(meta, ['lambda_um', 'lambda'])) ?? [];
  const nbands = num(pick(meta, ['nbands', 'n_bands', 'depth'])) ?? (lambdaUm.length || 102);
  const validRaw = pick(meta, ['valid', 'valid_bands']);
  const valid = Array.isArray(validRaw) ? validRaw.map((v) => Boolean(v)) : Array.from({ length: nbands }, () => true);
  let median = numArr(pick(meta, ['median', 'median_gray', 'sky_median', 'median_grey'])) ?? Array.from({ length: nbands }, () => NaN);
  let spread = numArr(pick(meta, ['spread', 'scale', 'mad', 'sigma', 'robust_scale', 'robust_sigma', 'iqr_sigma', 'median_scale']));
  // values stored as 0..1 display units: convert to grey units
  const units = String(pick(meta, ['median_units', 'units', 'value_units']) ?? '');
  const finite = median.filter(Number.isFinite);
  if ((finite.length && Math.max(...finite) <= 1.0001) || /0\.\.1|unit|fraction/i.test(units)) {
    median = median.map((m) => m * 254);
    if (spread) spread = spread.map((s) => s * 254);
  }
  const zScale = num(pick(meta, ['z_scale', 'zscale', 'quant_scale', 'encoding.scale', 'encoding.z_scale', 'int8_scale', 'scale_int8']));
  const zStep = num(pick(meta, ['z_step', 'encoding.step', 'encoding.z_step', 'lsb']));
  const zPerUnit = zStep ?? (zScale ? 1 / zScale : 1 / 16);
  const missRaw = pick(meta, ['missing', 'nodata', 'no_data', 'encoding.missing', 'encoding.nodata', 'sentinel', 'encoding.sentinel']);
  const missing = typeof missRaw === 'number' ? missRaw : -128;
  return { order, npix, nbands, lambdaUm, valid, median, spread, zPerUnit, missing };
}

let cached: Promise<SkyIndex> | null = null;

export function loadSkyIndex(): Promise<SkyIndex> {
  if (cached) return cached;
  cached = (async () => {
    const res = await fetch(`${BASE}/index.json`, { cache: 'force-cache' });
    if (res.status === 404) throw new IndexMissingError();
    if (!res.ok) throw new Error(`index.json HTTP ${res.status}`);
    let meta: Record<string, unknown>;
    try { meta = await res.json(); } catch { throw new IndexMissingError(); }
    const m = parseMeta(meta);
    const [zb, cb] = await Promise.all([
      fetch(`${BASE}/index.bin`).then((r) => { if (!r.ok) throw new IndexMissingError(); return r.arrayBuffer(); }),
      fetch(`${BASE}/coords.bin`).then((r) => { if (!r.ok) throw new IndexMissingError(); return r.arrayBuffer(); }),
    ]);
    if (zb.byteLength < m.npix * m.nbands || cb.byteLength < m.npix * 8) throw new Error('starmatch index truncated');
    return { ...m, z: new Int8Array(zb, 0, m.npix * m.nbands), coords: new Float32Array(cb, 0, m.npix * 2), meta };
  })();
  cached.catch(() => { cached = null; });
  return cached;
}
