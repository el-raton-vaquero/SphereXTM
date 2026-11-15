/**
 * Which SPHEREx frames a melody note belongs to, for lighting the keyboard during playback.
 * Uses the same band -> pitch mapping as the composer (lib/symphony/core: key from the spectral
 * colour, pentatonic scale, 4-octave span), so a lit key is exactly the band(s) whose data
 * produced that pitch. Read-only use of the symphony core.
 */
import { analyseSpectrum, bandIndexFor, bandMidi, binToBands, KEYS, SCALES } from '../symphony/core';

export function noteFrameMap(lambda: readonly number[], intensity: readonly (number | null)[]): (midi: number) => number[] {
  const a = analyseSpectrum(binToBands(lambda, intensity.map((v) => (v === null ? NaN : v))));
  const key = KEYS[a.colour];
  const scale = SCALES[key.scale];
  const base = key.root + 12;
  const byMidi = new Map<number, number[]>();
  lambda.forEach((um, f) => {
    if (intensity[f] === null) return;
    const b = bandIndexFor(um);
    if (b < 0) return;
    const m = Math.round(bandMidi(b, base, scale));
    const list = byMidi.get(m);
    if (list) list.push(f); else byMidi.set(m, [f]);
  });
  return (midi: number) => byMidi.get(midi) ?? byMidi.get(midi - 12) ?? [];
}
