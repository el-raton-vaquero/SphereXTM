/**
 * Star Match "Listen": the microphone, analysed in the browser (Web Audio AnalyserNode). Nothing
 * is uploaded; the short recording kept for "Play both" stays in memory on this device.
 */
import { N_BANDS, bandPowers, displayLevels, profileFromPowers, type SongAnalysis } from './bands';

export interface ListenHandle {
  /** Finish early (or wait for the timer) and get the analysis. */
  finish(): Promise<{ analysis: SongAnalysis; recording: Blob | null }>;
  cancel(): void;
}

export async function startListening(opts: { seconds: number; onFrame: (levels: Float32Array, elapsed: number) => void; onAutoStop: () => void }): Promise<ListenHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 16384;
  an.smoothingTimeConstant = 0;
  src.connect(an);
  const binHz = ctx.sampleRate / an.fftSize;
  const db = new Float32Array(an.frequencyBinCount), pw = new Float64Array(an.frequencyBinCount);

  let recorder: MediaRecorder | null = null;
  const chunks: Blob[] = [];
  try {
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.start();
  } catch { recorder = null; }

  const frames: { e: number; bands: Float64Array }[] = [];
  const t0 = performance.now();
  let done = false;
  const tick = () => {
    an.getFloatFrequencyData(db);
    let e = 0;
    for (let k = 0; k < db.length; k++) { const v = Number.isFinite(db[k]) ? 10 ** (db[k] / 10) : 0; pw[k] = v; e += v; }
    const bands = bandPowers(pw, binHz);
    frames.push({ e, bands });
    const elapsed = (performance.now() - t0) / 1000;
    opts.onFrame(displayLevels(bands), elapsed);
    if (elapsed >= opts.seconds && !done) opts.onAutoStop();
  };
  const timer = setInterval(tick, 100);

  const close = () => {
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  };

  return {
    cancel() { if (done) return; done = true; try { recorder?.stop(); } catch { /* */ } close(); },
    async finish() {
      if (done) throw new Error('finished');
      done = true;
      const rec = new Promise<Blob | null>((resolve) => {
        if (!recorder || recorder.state === 'inactive') return resolve(null);
        recorder.onstop = () => resolve(chunks.length ? new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' }) : null);
        try { recorder.stop(); } catch { resolve(null); }
      });
      close();
      const recording = await rec;
      let emax = 0;
      for (const f of frames) emax = Math.max(emax, f.e);
      const floor = emax * 10 ** -4;
      const mean = new Float64Array(N_BANDS);
      let used = 0;
      for (const f of frames) { if (f.e < floor || f.e <= 0) continue; for (let b = 0; b < N_BANDS; b++) mean[b] += f.bands[b]; used++; }
      if (used < 5) throw new Error('silent');
      for (let b = 0; b < N_BANDS; b++) mean[b] /= used;
      const evolution: number[][] = [];
      for (let i = 0; i < frames.length; i += 5) {
        const acc = new Float64Array(N_BANDS);
        const part = frames.slice(i, i + 5);
        for (const f of part) for (let b = 0; b < N_BANDS; b++) acc[b] += f.bands[b] / part.length;
        evolution.push(Array.from(displayLevels(acc)));
      }
      return {
        analysis: { profile: Array.from(profileFromPowers(mean)), power: Array.from(mean), evolution, seconds: (performance.now() - t0) / 1000, frames: used },
        recording,
      };
    },
  };
}
