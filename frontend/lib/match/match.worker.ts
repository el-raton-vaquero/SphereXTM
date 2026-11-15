/// <reference lib="webworker" />
/**
 * Star Match worker: song analysis, coarse all-sky search and full-resolution tile comparison
 * off the main thread. Messages: { id, kind, payload } -> { id, ok, result | error }.
 */
import { analyseSamples } from './bands';
import { coarseSearch, compareTile, type CoarseInput, type TileInput } from './search';

type Req =
  | { id: number; kind: 'analyse'; payload: { samples: Float32Array; sampleRate: number } }
  | { id: number; kind: 'coarse'; payload: CoarseInput }
  | { id: number; kind: 'tile'; payload: TileInput };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<Req>) => {
  const { id, kind, payload } = e.data;
  try {
    let result: unknown;
    if (kind === 'analyse') result = analyseSamples(payload.samples, payload.sampleRate);
    else if (kind === 'coarse') result = coarseSearch(payload);
    else result = compareTile(payload);
    ctx.postMessage({ id, ok: true, result });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
