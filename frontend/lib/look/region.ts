/**
 * "What did SPHEREx see there?" for a pointed (RA, Dec), from REAL SPHEREx pixels only:
 *   1. a StarChord preset snapshot (public/snapshots) when its centre is within 1 deg, else
 *   2. the live science backend (/v2/search at the pointed position, small field).
 * Never substitutes synthetic or other-survey pixels. The colour composite is a false-colour
 * rendering of real frames: blue = D1+D2 (0.75-1.62 um), green = D3+D4 (1.63-3.82 um),
 * red = D5+D6 (3.83-5.0 um), each a median of background-subtracted frames.
 */
import { LIVE_ENABLED, searchLive } from '../prism/api';
import { computeLevels, medianStack } from '../prism/imaging';
import { PRESETS } from '../prism/presets';
import { loadSnapshot, loadSnapshotIndex } from '../prism/snapshot';
import type { Frame, Progress, SearchResult } from '../prism/types';
import { sepDeg } from './sky';

export const SNAPSHOT_RADIUS_DEG = 1;
export const LIVE_FOV_ARCMIN = 10;

export interface RegionImage {
  origin: 'snapshot' | 'live';
  /** Snapshot id / preset id when the image comes from a preset. */
  presetId?: string;
  presetName?: string;
  /** Distance between the pointed position and the image centre, degrees. */
  offsetDeg: number;
  centre: { ra: number; dec: number };
  generated: string;
  n: number;
  pixscaleArcsec: number;
  fovArcmin: number;
  rgba: Uint8ClampedArray;
  nFrames: number;
  bands: { b: number; g: number; r: number }; // frames per channel
  dates: [string, string] | null;
  search: SearchResult;
}

export interface NearTarget { id: string; name: string; ra: number; dec: number; sep: number }

/** StarChord presets sorted by angular distance from (ra, dec). */
export function targetsByDistance(ra: number, dec: number): NearTarget[] {
  return PRESETS.map((p) => ({ id: p.id, name: p.name, ra: p.ra, dec: p.dec, sep: sepDeg(ra, dec, p.ra, p.dec) })).sort((a, b) => a.sep - b.sep);
}

function channel(frames: Frame[], dets: number[]): { img: Float32Array | null; count: number } {
  const set = frames.filter((f) => dets.includes(f.detector));
  if (!set.length) return { img: null, count: 0 };
  return { img: medianStack(set), count: set.length };
}

/** False-colour RGBA composite of real frames (see module comment). */
export function composite(search: SearchResult): { rgba: Uint8ClampedArray; bands: { b: number; g: number; r: number } } {
  const n = search.grid.n;
  const rgba = new Uint8ClampedArray(n * n * 4);
  const B = channel(search.frames, [1, 2]), G = channel(search.frames, [3, 4]), R = channel(search.frames, [5, 6]);
  const chans = [R, G, B];
  const soft = 0.1, norm = Math.asinh(1 / soft);
  const levels = chans.map((c) => (c.img ? computeLevels(c.img, 'asinh') : null));
  for (let i = 0; i < n * n; i++) {
    let anyValid = false;
    for (let k = 0; k < 3; k++) {
      const c = chans[k].img, lv = levels[k];
      let t = 0;
      if (c && lv) {
        const v = c[i];
        if (Number.isFinite(v)) {
          anyValid = true;
          t = (v - lv.lo) / (lv.hi - lv.lo || 1);
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          t = Math.asinh(t / soft) / norm;
        }
      }
      rgba[i * 4 + k] = 10 + t * 235;
    }
    rgba[i * 4 + 3] = anyValid ? 255 : 0;
  }
  return { rgba, bands: { b: B.count, g: G.count, r: R.count } };
}

function dateRange(frames: Frame[]): [string, string] | null {
  if (!frames.length) return null;
  const ds = frames.map((f) => f.date).filter(Boolean).sort();
  return ds.length ? [ds[0].slice(0, 10), ds[ds.length - 1].slice(0, 10)] : null;
}

export class RegionUnavailable extends Error {
  constructor(readonly reason: 'no-live' | 'no-coverage' | 'failed', message: string) { super(message); }
}

/**
 * Load real SPHEREx pixels for a pointed position. Throws RegionUnavailable when neither a
 * nearby snapshot nor the live service can provide them.
 */
export async function loadRegion(ra: number, dec: number, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<RegionImage> {
  const idx = await loadSnapshotIndex();
  let best: { id: string; name: string; ra: number; dec: number; generated_utc: string; sep: number } | null = null;
  for (const e of idx) {
    const s = sepDeg(ra, dec, e.ra, e.dec);
    if (!best || s < best.sep) best = { ...e, sep: s };
  }
  if (best && best.sep <= SNAPSHOT_RADIUS_DEG) {
    const { snapshot, search } = await loadSnapshot(best.id, onProgress, signal);
    const { rgba, bands } = composite(search);
    return {
      origin: 'snapshot', presetId: best.id, presetName: snapshot.name || best.name, offsetDeg: best.sep,
      centre: { ra: search.grid.wcs.crval[0], dec: search.grid.wcs.crval[1] }, generated: snapshot.generated_utc.slice(0, 10),
      n: search.grid.n, pixscaleArcsec: search.grid.pixscale_arcsec, fovArcmin: (search.grid.n * search.grid.pixscale_arcsec) / 60,
      rgba, nFrames: search.frames.length, bands, dates: dateRange(search.frames), search,
    };
  }
  if (!LIVE_ENABLED) throw new RegionUnavailable('no-live', 'live search not configured');
  let search: SearchResult;
  try {
    search = await searchLive({ ra, dec, fov: LIVE_FOV_ARCMIN, max_frames: 48 }, onProgress, signal);
  } catch (e) {
    const err = e as { errorType?: string; kind?: string; message?: string };
    if (err.kind === 'aborted') throw e;
    if (err.errorType === 'no_coverage') throw new RegionUnavailable('no-coverage', err.message ?? 'no coverage');
    throw new RegionUnavailable('failed', err.message ?? 'live search failed');
  }
  if (!search.frames.length) throw new RegionUnavailable('no-coverage', 'no frames');
  const { rgba, bands } = composite(search);
  return {
    origin: 'live', offsetDeg: sepDeg(ra, dec, search.grid.wcs.crval[0], search.grid.wcs.crval[1]),
    centre: { ra: search.grid.wcs.crval[0], dec: search.grid.wcs.crval[1] }, generated: (search.provenance.generated_utc || '').slice(0, 10),
    n: search.grid.n, pixscaleArcsec: search.grid.pixscale_arcsec, fovArcmin: (search.grid.n * search.grid.pixscale_arcsec) / 60,
    rgba, nFrames: search.frames.length, bands, dates: dateRange(search.frames), search,
  };
}
