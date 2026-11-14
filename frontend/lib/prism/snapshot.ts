// Cached-snapshot loader: /snapshots/<id>.json contains REAL SPHEREx data captured earlier
// by frontend/scripts/prism_snapshot.py. It is always labelled
// "Real SPHEREx data — cached snapshot <date>" in the UI and never mixed with live results.
import { angularSepArcsec } from './coords';
import { decodeSearch } from './decode';
import type { Progress, SearchResult, Snapshot } from './types';

export interface SnapshotIndexEntry { id: string; name: string; ra: number; dec: number; fov: number; generated_utc: string; n_frames: number }

let indexPromise: Promise<SnapshotIndexEntry[]> | null = null;

export function loadSnapshotIndex(): Promise<SnapshotIndexEntry[]> {
  if (!indexPromise) {
    indexPromise = fetch('/snapshots/index.json')
      .then((r) => (r.ok ? r.json() : { snapshots: [] }))
      .then((j) => (Array.isArray(j?.snapshots) ? j.snapshots : []))
      .catch(() => []);
  }
  return indexPromise;
}

/** Snapshot whose centre lies within `tolArcsec` of the requested position. */
export async function findSnapshot(ra: number, dec: number, tolArcsec = 30): Promise<SnapshotIndexEntry | null> {
  const idx = await loadSnapshotIndex();
  let best: SnapshotIndexEntry | null = null;
  let bestSep = Infinity;
  for (const e of idx) {
    const sep = angularSepArcsec(ra, dec, e.ra, e.dec);
    if (sep < bestSep) { bestSep = sep; best = e; }
  }
  return best && bestSep <= tolArcsec ? best : null;
}

export interface LoadedSnapshot { snapshot: Snapshot; search: SearchResult }

/** Fetch a snapshot with byte-level progress. */
export async function loadSnapshot(id: string, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<LoadedSnapshot> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('invalid snapshot id');
  const res = await fetch(`/snapshots/${id}.json`, { signal });
  if (!res.ok) throw new Error(`snapshot ${id}: HTTP ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || undefined;
  let text: string;
  if (res.body && typeof TextDecoder !== 'undefined') {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let done = 0;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      chunks.push(value);
      done += value.byteLength;
      onProgress({ stage: 'snapshot', done, total, message: `${(done / 1e6).toFixed(1)} MB` });
    }
    const all = new Uint8Array(done);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.byteLength; }
    text = new TextDecoder().decode(all);
  } else {
    text = await res.text();
  }
  const snapshot = JSON.parse(text) as Snapshot;
  if (snapshot.kind !== 'prism-snapshot' || !snapshot.search) throw new Error(`snapshot ${id}: unexpected format`);
  return { snapshot, search: decodeSearch(snapshot.search) };
}
