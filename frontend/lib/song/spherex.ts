/**
 * Real SPHEREx data for the zenith patch, from the IRSA DR1 all-sky HiPS cube (lib/look/hipsRender).
 *
 *  - spectrum: sampleSpectrum() at HiPS order 3 (51"/px), mean of the tile pixels within
 *    SPECTRUM_RADIUS_PX (about 7 arcmin), so the song describes the patch rather than one pixel.
 *    Values are the cube's display stretch (asinh, cut 0..40 MJy/sr) mapped to 0..1: a picture
 *    of the data, not calibrated fluxes.
 *  - image: the cube's colour composite (4.0 / 2.19 / 1.00 um as R / G / B), north up, east left.
 *
 * Order 3 is used for the spectrum (and the 600 px / 9 deg image also resolves to order 3):
 * every order needs one 512 px tile per frame, and the coarser order averages a wider patch.
 */
import { northUpWcs } from '../look/hips';
import { BLANK_FRAMES, CUBE_DEPTH, FRAME_UM, isAbort, loadTile, locateInTile, radecToUnit, renderHips, sampleSpectrum, type HipsSpectrum } from '../look/hipsRender';

export const SPECTRUM_ORDER = 3;
export const SPECTRUM_RADIUS_PX = 8;
export const IMAGE_FOV_DEG = 9;
export { FRAME_UM, CUBE_DEPTH, isAbort };

/**
 * Fetch the 102-frame spectrum of the zenith patch. `onFrame(f, ok)` fires as each frame's tile
 * arrives (for the "tuning" keyboard); frames 50/51 are blank in the cube and report ok = false.
 */
export async function zenithSpectrum(ra: number, dec: number, opts: { signal?: AbortSignal; onFrame?: (frame: number, ok: boolean, value?: number | null) => void } = {}): Promise<HipsSpectrum> {
  const { npix, col, row } = locateInTile(radecToUnit(ra, dec), SPECTRUM_ORDER, 512);
  // Per-frame arrival callbacks: the same tile requests that sampleSpectrum makes (shared cache),
  // with a provisional value computed exactly like sampleSpectrum (mean of non-empty pixels).
  const watchers = FRAME_UM.map((_, f) => {
    if (BLANK_FRAMES.includes(f)) { opts.onFrame?.(f, false, null); return Promise.resolve(); }
    return loadTile(SPECTRUM_ORDER, npix, f, opts.signal).then((t) => {
      if (!t) { opts.onFrame?.(f, false, null); return; }
      opts.onFrame?.(f, true, patchMean(t, col, row, SPECTRUM_RADIUS_PX));
    }, () => { /* reported by sampleSpectrum */ });
  });
  const spec = await sampleSpectrum(ra, dec, SPECTRUM_RADIUS_PX, { order: SPECTRUM_ORDER, signal: opts.signal });
  await Promise.all(watchers);
  if (spec.value.every((v) => v === null)) throw new Error('no SPHEREx data at the zenith');
  return spec;
}

function patchMean(t: Uint8Array, col: number, row: number, r: number): number | null {
  const c0 = Math.floor(col), r0 = Math.floor(row);
  let s = 0, k = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dy * dy > r * r) continue;
    const x = Math.min(511, Math.max(0, c0 + dx)), y = Math.min(511, Math.max(0, r0 + dy));
    const g = t[y * 512 + x];
    if (g) { s += g; k++; }
  }
  return k ? s / k / 254 : null;
}

/** Colour image of the zenith patch (north up), as a canvas. */
export async function zenithImage(ra: number, dec: number, px = 600, signal?: AbortSignal): Promise<{ canvas: HTMLCanvasElement; coverage: number }> {
  const w = northUpWcs(ra, dec, IMAGE_FOV_DEG, px, px);
  const r = await renderHips(w, 'color', { signal, maxRequests: 60 });
  const canvas = document.createElement('canvas');
  canvas.width = r.width; canvas.height = r.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(r.rgba), r.width, r.height), 0, 0);
  return { canvas, coverage: r.coverage };
}
