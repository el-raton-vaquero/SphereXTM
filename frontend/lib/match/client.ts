/**
 * Star Match orchestration on the main thread: worker RPC (with an inline fallback), the coarse
 * all-sky search and the "keep searching" deep search over full-resolution SPHEREx tiles.
 *
 * Tiles come from hipsRender.loadTile (the same IRSA DR1 HiPS cube, LRU cache and 8-request
 * throttle as the rest of StarChord); hipsRender.ts itself is not modified.
 */
import { BLANK_FRAMES, CUBE_DEPTH, isAbort, loadTile } from '../look/hipsRender';
import { analyseSamples, type SongAnalysis } from './bands';
import { sepDeg } from './healpix';
import { coarseSearch, compareTile, type CoarseHit, type CoarseInput, type FineHit, type TileInput } from './search';
import type { SkyIndex } from './skyIndex';

export { isAbort };
export type { CoarseHit, FineHit, SongAnalysis };

type Kind = 'analyse' | 'coarse' | 'tile';
let worker: Worker | null | undefined;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./match.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result); else p.reject(new Error(e.data.error));
    };
    worker.onerror = () => {
      for (const p of pending.values()) p.reject(new Error('worker failed'));
      pending.clear();
      worker?.terminate();
      worker = null; // later calls run inline
    };
  } catch {
    worker = null;
  }
  return worker;
}

function call<T>(kind: Kind, payload: unknown, transfer: Transferable[] = []): Promise<T> {
  const w = getWorker();
  if (!w) {
    return new Promise<T>((resolve, reject) => setTimeout(() => {
      try {
        if (kind === 'analyse') { const p = payload as { samples: Float32Array; sampleRate: number }; resolve(analyseSamples(p.samples, p.sampleRate) as T); }
        else if (kind === 'coarse') resolve(coarseSearch(payload as CoarseInput) as T);
        else resolve(compareTile(payload as TileInput) as T);
      } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
    }, 0));
  }
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ id, kind, payload }, transfer);
  });
}

export function analyseInWorker(samples: Float32Array, sampleRate: number): Promise<SongAnalysis> {
  return call<SongAnalysis>('analyse', { samples, sampleRate }, [samples.buffer]);
}

export function coarseInWorker(song: number[], idx: SkyIndex, top = 50): Promise<{ hits: CoarseHit[]; compared: number }> {
  // the index arrays are copied (structured clone) so the cached index stays usable
  return call('coarse', { song, z: idx.z, coords: idx.coords, npix: idx.npix, nbands: idx.nbands, valid: idx.valid, zPerUnit: idx.zPerUnit, missing: idx.missing, top, minSepDeg: 3 });
}

// ---------------------------------------------------------------------------------------------
// Deep search

export const DEEP_ORDER = 5;
export const TILE_W = 512;

export interface DeepProgress {
  regionsDone: number;
  regionsTotal: number;
  compared: number;
  best: FineHit[];
  current?: { npix: number; ra: number; dec: number; loaded: number };
}

/** Keep the global best list: top `n`, at least `minSepArcmin` apart. */
export function mergeBest(list: FineHit[], add: FineHit[], n = 8, minSepArcmin = 2): FineHit[] {
  const all = [...list, ...add].sort((a, b) => b.r - a.r);
  const out: FineHit[] = [];
  for (const h of all) {
    if (out.length >= n) break;
    if (out.some((o) => sepDeg(o.ra, o.dec, h.ra, h.dec) * 60 < minSepArcmin)) continue;
    out.push(h);
  }
  return out;
}

/** Order-5 tiles holding the coarse hits, in hit order, without repeats. */
export function regionsFor(hits: CoarseHit[], indexOrder: number): { npix: number; ra: number; dec: number }[] {
  const shift = 4 ** Math.max(0, indexOrder - DEEP_ORDER);
  const seen = new Set<number>(), out: { npix: number; ra: number; dec: number }[] = [];
  for (const h of hits) {
    const t = Math.floor(h.pix / shift);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({ npix: t, ra: h.ra, dec: h.dec });
  }
  return out;
}

async function loadRegion(npix: number, valid: boolean[], signal: AbortSignal, onTile: () => void): Promise<(Uint8Array | null)[]> {
  return Promise.all(Array.from({ length: CUBE_DEPTH }, async (_, f) => {
    if (BLANK_FRAMES.includes(f) || valid[f] === false) { onTile(); return null; }
    try {
      const t = await loadTile(DEEP_ORDER, npix, f, signal);
      onTile();
      return t;
    } catch (e) {
      if (isAbort(e)) throw e;
      onTile();
      return null; // a failed frame is just a missing band
    }
  }));
}

/**
 * Compare every pixel of region after region until `maxRegions`, the end of the list, or abort.
 * Region n+1 downloads while region n is compared in the worker.
 */
export async function deepSearch(opts: {
  song: number[]; idx: SkyIndex; hits: CoarseHit[]; maxRegions?: number; signal: AbortSignal;
  onProgress: (p: DeepProgress) => void;
}): Promise<DeepProgress> {
  const { song, idx, signal } = opts;
  const regions = regionsFor(opts.hits, idx.order).slice(0, opts.maxRegions ?? 30);
  const state: DeepProgress = { regionsDone: 0, regionsTotal: regions.length, compared: 0, best: [] };
  const emit = () => opts.onProgress({ ...state, best: state.best.slice() });
  const counts = new Map<number, number>();
  const start = (i: number) => {
    const reg = regions[i];
    counts.set(reg.npix, 0);
    const p = loadRegion(reg.npix, idx.valid, signal, () => {
      const c = (counts.get(reg.npix) ?? 0) + 1;
      counts.set(reg.npix, c);
      if (state.current?.npix === reg.npix) { state.current.loaded = c; emit(); }
    });
    p.catch(() => {});
    return p;
  };
  let next = regions.length ? start(0) : null;
  for (let i = 0; i < regions.length; i++) {
    if (signal.aborted) break;
    const reg = regions[i];
    state.current = { ...reg, loaded: counts.get(reg.npix) ?? 0 };
    emit();
    let frames: (Uint8Array | null)[];
    try {
      frames = await (next as Promise<(Uint8Array | null)[]>);
    } catch (e) {
      if (isAbort(e)) break;
      throw e;
    }
    next = i + 1 < regions.length ? start(i + 1) : null;
    if (signal.aborted) break;
    const copies: (Uint8Array | null)[] = frames.map((t) => (t ? t.slice() : null));
    const transfer: Transferable[] = [];
    for (const t of copies) if (t) transfer.push(t.buffer as ArrayBuffer);
    const res = await call<{ hits: FineHit[]; compared: number }>('tile', {
      song, frames: copies, valid: idx.valid, median: idx.median, spread: idx.spread, order: DEEP_ORDER, npix: reg.npix, width: TILE_W, keep: 6,
    } satisfies TileInput, transfer);
    state.compared += res.compared;
    state.best = mergeBest(state.best, res.hits);
    state.regionsDone = i + 1;
    emit();
  }
  state.current = undefined;
  emit();
  return state;
}
