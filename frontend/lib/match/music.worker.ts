/// <reference lib="webworker" />
/**
 * Star Match music worker: key / tempo / chords of the user's song (musicAnalysis.ts), in its own
 * worker so it runs in parallel with the sky search. Messages: { id, samples, sampleRate } ->
 * { id, ok, result | error }.
 */
import { analyseMusic } from './musicAnalysis';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<{ id: number; samples: Float32Array; sampleRate: number }>) => {
  const { id, samples, sampleRate } = e.data;
  try {
    ctx.postMessage({ id, ok: true, result: analyseMusic(samples, sampleRate) });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
