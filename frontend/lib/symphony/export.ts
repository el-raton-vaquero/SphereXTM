/**
 * Listar star symphony — fixed-piece export.
 *
 * composeSong() turns a real spectrum into a deterministic ~45 s piece with a musical form,
 * using the same data -> sound mapping as the live symphony (core.ts):
 *  - each of the 102 bands is a pentatonic note, shorter wavelength = higher pitch;
 *  - normalised brightness -> velocity, note length and how long the melody lingers (rhythm);
 *  - spectral slope (blue / neutral / red colour index) -> key, scale and pad chords;
 *  - detected H2O-ice / CO2 / CO / CH4 absorptions -> the 'ice' voice (feature timbre);
 *  - empty (null) bands are silent.
 * Form: intro (pad + a few of the brightest peaks) -> melody sweep long->short wavelength ->
 * climax sweep back with harmony, octave sparkles, ice layer and pulsing bass -> fade-out.
 *
 * composeSong / scoreToMidi are pure (no DOM). playScore / renderScoreToWav use Web Audio and
 * the SAME voices + reverb + limiter as the live engine (voices.ts). downloadBlob needs a DOM.
 */
import {
  analyseSpectrum, bandMidi, BANDS, binToBands, detectorPan, encodeWav, KEYS, mulberry32, N_BANDS,
  noteDuration, noteVelocity, pitchPosition, quantizeToScale, REST_BELOW, SCALES, stepLength,
  type FeatureId, type ScaleId, type SpectralColour,
} from './core';
import { buildChain, playPadNote, playVoice, type Voice } from './voices';

export interface SongInput { lambda_um: number[]; intensity: (number | null)[]; seed?: string; label?: string }
export interface SongNote { t: number; dur: number; midi: number; vel: number; voice: 'lead' | 'pad' | 'ice' | 'bass'; pan: number }
export interface SongScore { seconds: number; bpm: number; notes: SongNote[]; key: string; features: string[]; input: SongInput }

export type SongVoice = SongNote['voice'];

/** A chord of the song to play along with (seconds from the start of the score). */
export interface SongChord { t: number; dur: number; root: number; quality: 'maj' | 'min' | 'dim' }

/**
 * Optional "play along" options for composeSong. When any is given, the piece is composed in the
 * song's key / mode / tempo / chords instead of the spectrum's own colour key (see composeAlong).
 */
export interface ComposeOptions {
  /** Tonic pitch class 0-11 (C = 0). Default: the spectral-colour key's root. */
  tonic?: number;
  mode?: 'major' | 'minor';
  /** Default 'diatonic' (7 notes); 'pentatonic' = major / minor pentatonic of the key. */
  scale?: 'diatonic' | 'pentatonic';
  /** Tempo of the beat grid (default 100). */
  bpm?: number;
  /** Time (s) of a beat of the grid (default 0); the grid extends both ways. */
  beatOffset?: number;
  /** Chord progression; looped if it ends before the piece. Default: I-vi-IV-V / i-VI-III-VII per bar. */
  chords?: SongChord[];
  /** Length of the piece (overrides the `seconds` argument; clamped 2..600). */
  seconds?: number;
  /** Sit under / around a mix: softer pad, light bass, melody an octave up, no sparkles. */
  accompaniment?: boolean;
}
export const SONG_VOICES: readonly SongVoice[] = ['lead', 'pad', 'ice', 'bass'];

/** Same feature -> timbre table as the live engine. */
const FEATURE_VOICE: Record<FeatureId, Voice> = { h2o: 'shimmer', co2: 'bell', co: 'hollow', ch4: 'breath', pah: 'glow' };
/** Absorptions that get the 'ice' voice. */
const ICE_FEATURES: readonly FeatureId[] = ['h2o', 'co2', 'co', 'ch4'];
const SCALE_NAME: Record<ScaleId, string> = {
  majorPent: 'major pentatonic', minorPent: 'minor pentatonic', suspendedPent: 'suspended pentatonic',
};

/** FNV-1a of a string. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function thirdFor(c: SpectralColour): number {
  return c === 'blue' ? 16 : c === 'red' ? 15 : 14; // same as the live drone
}

/**
 * Compose a fixed piece from a spectrum. Deterministic: same input (+ seed) -> identical score.
 * `seconds` (default 45, clamped 10..600) is the length of the music; renders add a reverb tail.
 */
export function composeSong(input: SongInput, seconds = 45, options?: ComposeOptions): SongScore {
  if (options && Object.values(options).some((v) => v !== undefined)) return composeAlong(input, options.seconds ?? seconds, options);
  const T = Math.min(600, Math.max(10, Number.isFinite(seconds) ? seconds : 45));
  const lam = input.lambda_um ?? [];
  const inten = (input.intensity ?? []).map((v) => (v === null || v === undefined ? NaN : Number(v)));
  const a = analyseSpectrum(binToBands(lam, inten));
  const key = KEYS[a.colour];
  const scale = SCALES[key.scale];
  const keyName = `${key.name} ${SCALE_NAME[key.scale]}`;
  const features = a.features
    .filter((f) => f.detected)
    .sort((x, y) => y.strength - x.strength || x.id.localeCompare(y.id))
    .map((f) => f.id as string);

  // Melody sections: intro 14%, A 32%, climax 32%, outro 22%.
  const tIntro = T * 0.14, tA = T * 0.46, tClimax = T * 0.78;
  const avgStep = (tA - tIntro) / N_BANDS;
  const bpm = Math.round(Math.min(140, Math.max(60, 60 / (4 * avgStep))));
  const beat = 60 / bpm;

  const out: SongScore = { seconds: T, bpm, notes: [], key: keyName, features, input };
  if (a.valid < 3) return out; // nothing measured -> silence

  const norm = a.norm;
  const rng = mulberry32((a.seed ^ hashString(input.seed ?? '')) >>> 0);
  const base = key.root + 12;
  const notes: SongNote[] = [];
  const iceBands = new Set<number>();
  for (const f of a.features) if (f.detected && ICE_FEATURES.includes(f.id)) f.bands.forEach((b) => iceBands.add(b));
  const iceStrength = Math.max(0, ...a.features.filter((f) => f.detected && ICE_FEATURES.includes(f.id)).map((f) => f.strength));

  /** Dynamics over the form: soft intro, growing melody, climax peak at 62%, fade-out. */
  const env = (t: number): number => {
    const x = t / T;
    if (x < 0.14) return 0.55;
    if (x < 0.46) return 0.72 + 0.13 * ((x - 0.14) / 0.32);
    if (x < 0.78) return 1 - 0.5 * Math.abs(x - 0.62) / 0.16 * 0.3;
    return 0.85 - 0.6 * ((x - 0.78) / 0.22);
  };
  const push = (t: number, dur: number, midi: number, vel: number, voice: SongVoice, pan: number) => {
    if (!(vel > 0) || t >= T - 0.05 || t < 0) return;
    notes.push({ t, dur: Math.max(0.05, Math.min(dur, T - t)), midi: Math.round(midi), vel: clamp01(vel), voice, pan: Math.max(-1, Math.min(1, pan)) });
  };
  const qs = (semis: number) => quantizeToScale(semis, scale);
  const finite = (i: number) => Number.isFinite(norm[i]);
  const melodyNote = (i: number, t: number, velScale: number, durScale: number, harmony: boolean, sparkleP: number) => {
    const v = norm[i];
    const midi = bandMidi(i, base, scale);
    const voice: SongVoice = iceBands.has(i) ? 'ice' : 'lead';
    const vel = noteVelocity(v) * env(t) * velScale;
    const dur = noteDuration(v) * durScale;
    const pan = detectorPan(BANDS[i].detector);
    push(t + (rng() - 0.5) * 0.012 + 0.006, dur, midi, vel, voice, pan);
    if (harmony && v > 0.6) push(t + 0.02, dur * 0.8, base + qs(midi - base - 4), vel * 0.45, 'lead', -pan * 0.5);
    if (a.peaks[i] && rng() < sparkleP) push(t + 0.09, dur * 0.7, midi + 12, vel * 0.35, voice, pan);
  };
  /** A sweep through the bands in `order`, stretched to fill [t0, t1] with the live rhythm. */
  const sweep = (order: number[], t0: number, t1: number, velScale: number, harmony: boolean, sparkleP: number) => {
    const lens = order.map((i) => (finite(i) ? stepLength(norm[i]) : stepLength(0) * 0.5));
    const k = (t1 - t0) / lens.reduce((s, x) => s + x, 0);
    let t = t0;
    order.forEach((i, j) => {
      const v = norm[i];
      if (finite(i) && v >= REST_BELOW && (v > 0.5 || rng() < 0.35 + v)) melodyNote(i, t, velScale, 1, harmony, sparkleP);
      t += lens[j] * k;
    });
  };

  const longToShort = Array.from({ length: N_BANDS }, (_, j) => N_BANDS - 1 - j);
  const shortToLong = Array.from({ length: N_BANDS }, (_, j) => j);
  const ranked = shortToLong.filter(finite).sort((x, y) => norm[y] - norm[x] || x - y);

  // ---- intro: the brightest peaks, slowly, over the pad
  const introPicks = ranked.filter((i) => a.peaks[i]).slice(0, 3);
  if (introPicks.length < 2) introPicks.push(...ranked.filter((i) => !introPicks.includes(i)).slice(0, 2 - introPicks.length));
  introPicks.sort((x, y) => y - x).forEach((i, j) => {
    melodyNote(i, tIntro * (0.4 + 0.18 * j), 0.8, 1.3, false, 0);
  });

  // ---- A: melody sweep long -> short wavelength (as the live music box starts)
  sweep(longToShort, tIntro, tA, 1, false, 0.6);

  // ---- climax: sweep back short -> long, louder, with harmony and more sparkle
  sweep(shortToLong, tA, tClimax, 1.12, true, 0.85);

  // ---- outro: the brightest bands, long -> short, slowing and fading; last note = brightest band
  const outroPicks = ranked.slice(0, Math.min(8, ranked.length)).sort((x, y) => y - x);
  const tLast = T - Math.min(4, T * 0.09);
  outroPicks.forEach((i, j) => {
    const x = outroPicks.length > 1 ? j / (outroPicks.length - 1) : 0;
    const t = tClimax + 0.4 + (tLast - 1 - tClimax - 0.4) * Math.pow(x, 0.8);
    melodyNote(i, t, 0.9, 1.2, false, 0);
  });
  if (ranked.length) melodyNote(ranked[0], tLast, 0.9, 2.5, false, 0);

  // ---- pad chords (drone voicing; roots move along the scale) + bass
  const chordTones = (r: number) => [0, 7, 12, thirdFor(a.colour)].map((s) => key.root + qs(r + s));
  // [start, end, chord root (semis above key root), pad level, bass pattern]
  type Sec = [number, number, number, number, 'none' | 'bar' | 'half' | 'hold'];
  const half = (t0: number, t1: number) => (t0 + t1) / 2;
  const third = (t0: number, t1: number, k: number) => t0 + ((t1 - t0) * k) / 3;
  const secs: Sec[] = [
    [0, tIntro, 0, 0.75, 'none'],
    [tIntro, half(tIntro, tA), 0, 0.85, 'bar'],
    [half(tIntro, tA), tA, qs(5), 0.85, 'bar'],
    [tA, third(tA, tClimax, 1), qs(9), 1, 'half'],
    [third(tA, tClimax, 1), third(tA, tClimax, 2), qs(5), 1, 'half'],
    [third(tA, tClimax, 2), tClimax, qs(7), 1, 'half'],
    [tClimax, T, 0, 0.8, 'hold'],
  ];
  for (const [s0, s1, r, lvl, bass] of secs) {
    const overlap = s1 >= T ? 0 : 0.6;
    chordTones(r).forEach((m, j) => push(s0, s1 - s0 + overlap, m, lvl * (j === 3 ? 0.6 : 1), 'pad', j % 2 ? 0.35 : -0.35));
    const br = key.root + qs(r);
    if (bass === 'bar' || bass === 'half') {
      const step = bass === 'bar' ? 4 * beat : 2 * beat;
      let k = 0;
      for (let t = s0; t < s1 - 0.2; t += step, k++) {
        const m = bass === 'half' && k % 2 ? key.root + qs(r + 7) : br;
        push(t, Math.max(0.4, Math.min(step * 0.85, s1 - t)), m, (bass === 'bar' ? 0.5 : 0.7) * env(t), 'bass', 0);
      }
    } else if (bass === 'hold') {
      push(s0, (s1 - s0) * 0.75, br, 0.5, 'bass', 0);
    }
  }

  // ---- ice layer: the live symphony's sustained shimmer, held through the climax
  if (iceStrength > 0) {
    const semis = [36, 43, 48];
    semis.forEach((s, j) => push(tA + j * 1.2, tClimax - tA - j * 1.2 + 1.5, key.root + qs(s), 0.35 + 0.4 * iceStrength, 'ice', j % 2 ? 0.5 : -0.5));
  }

  // Stable order, rounded times, and no duplicate (voice, pitch) onsets within 10 ms.
  for (const n of notes) { n.t = r4(n.t); n.dur = r4(n.dur); n.vel = r4(n.vel); n.pan = r4(n.pan); }
  notes.sort((x, y) => x.t - y.t || SONG_VOICES.indexOf(x.voice) - SONG_VOICES.indexOf(y.voice) || x.midi - y.midi || y.vel - x.vel);
  const lastOn = new Map<string, number>();
  out.notes = notes.filter((n) => {
    const k = `${n.voice}:${n.midi}`;
    const p = lastOn.get(k);
    if (p !== undefined && n.t - p < 0.01) return false;
    lastOn.set(k, n.t);
    return true;
  });
  return out;
}

// ---------------------------------------------------------------- play along

const NOTE_EN = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const DIATONIC = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] } as const;
const TRIAD_STEPS: Record<SongChord['quality'], number[]> = { maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6] };
const pcOf = (m: number) => ((Math.round(m) % 12) + 12) % 12;

/** Pitch classes of a chord. */
export function songChordPcs(c: Pick<SongChord, 'root' | 'quality'>): number[] {
  return (TRIAD_STEPS[c.quality] ?? TRIAD_STEPS.maj).map((s) => pcOf(c.root + s));
}

/** The scale (semitones above the tonic) the play-along piece uses. */
export function alongScale(mode: 'major' | 'minor', scale: 'diatonic' | 'pentatonic' = 'diatonic'): readonly number[] {
  if (scale === 'pentatonic') return mode === 'major' ? SCALES.majorPent : SCALES.minorPent;
  return DIATONIC[mode];
}

/**
 * The play-along piece. Same data -> sound mapping as composeSong (shorter wavelength = higher
 * pitch, brightness = velocity / note length / how long the sweep lingers, null bands silent,
 * ice / CO2 / CO / CH4 bands on the 'ice' voice), but:
 *  - pitches are degrees of the song's key (diatonic or pentatonic), not the colour key;
 *  - every onset sits on the song's beat grid (8ths, or 16ths for faint bands outside
 *    accompaniment) and durations are whole 16ths;
 *  - a melody note on a beat snaps to the nearest tone of the chord sounding there (if in scale);
 *  - the pad plays the chord progression, the bass its roots.
 * Form: about a bar of pad, then the melody sweeps long -> short wavelength and back short -> long.
 * Deterministic (no humanising jitter, so the grid stays exact).
 */
function composeAlong(input: SongInput, seconds: number, o: ComposeOptions): SongScore {
  const T = Math.min(600, Math.max(2, Number.isFinite(seconds) ? seconds : 30));
  const lam = input.lambda_um ?? [];
  const inten = (input.intensity ?? []).map((v) => (v === null || v === undefined ? NaN : Number(v)));
  const a = analyseSpectrum(binToBands(lam, inten));
  const tonic = pcOf(Number.isFinite(o.tonic) ? (o.tonic as number) : KEYS[a.colour].root);
  const mode = o.mode ?? (a.colour === 'red' ? 'minor' : 'major');
  const scaleKind = o.scale ?? 'diatonic';
  const steps = alongScale(mode, scaleKind);
  const inScale = new Set(steps.map((s) => pcOf(tonic + s)));
  const bpm = Math.min(240, Math.max(40, Number.isFinite(o.bpm) && (o.bpm as number) > 0 ? (o.bpm as number) : 100));
  const beat = 60 / bpm, six = beat / 4, bar = 4 * beat;
  const off0 = Number.isFinite(o.beatOffset) ? (o.beatOffset as number) : 0;
  const off = ((off0 % beat) + beat) % beat;
  const acc = !!o.accompaniment;
  const features = a.features
    .filter((f) => f.detected)
    .sort((x, y) => y.strength - x.strength || x.id.localeCompare(y.id))
    .map((f) => f.id as string);
  const out: SongScore = { seconds: T, bpm, notes: [], key: `${NOTE_EN[tonic]} ${mode} (${scaleKind})`, features, input };
  if (a.valid < 3) return out; // nothing measured -> silence

  // ---- chord timeline: the given progression (looped), or a default one per bar from the grid
  let prog: SongChord[] = (o.chords ?? [])
    .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.dur) && c.dur > 0 && Number.isFinite(c.root))
    .map((c) => ({ t: c.t, dur: c.dur, root: pcOf(c.root), quality: TRIAD_STEPS[c.quality] ? c.quality : 'maj' }))
    .sort((x, y) => x.t - y.t);
  if (!prog.length) {
    const deg: [number, SongChord['quality']][] = mode === 'major'
      ? [[0, 'maj'], [9, 'min'], [5, 'maj'], [7, 'maj']]
      : [[0, 'min'], [8, 'maj'], [3, 'maj'], [10, 'maj']];
    prog = deg.map(([s, q], k) => ({ t: off + k * bar, dur: bar, root: pcOf(tonic + s), quality: q }));
  }
  const p0 = prog[0].t, pEnd = Math.max(...prog.map((c) => c.t + c.dur)), span = pEnd - p0;
  /** Chord sounding at t and when it ends (before the first: the first; after the last: loop). */
  const chordAt = (t: number): { c: SongChord; end: number } => {
    let tt = t, shift = 0;
    if (t >= pEnd && span > 0) { const k = Math.floor((t - p0) / span); tt = t - k * span; shift = k * span; }
    const eps = 1e-3; // chord times are rounded: treat boundaries within 1 ms as equal
    let c = prog[0];
    for (const x of prog) { if (x.t <= tt + eps) c = x; else break; }
    const next = prog.find((x) => x.t > tt + eps);
    const end = tt < p0 - eps ? p0 : Math.min(c.t + c.dur > tt + eps ? c.t + c.dur : Infinity, next ? next.t : pEnd);
    return { c, end: Math.max(t + 0.05, end + shift) };
  };
  const segs: { t0: number; t1: number; c: SongChord }[] = [];
  for (let t = 0; t < T - 1e-6;) {
    const { c, end } = chordAt(t);
    const t1 = Math.min(T, end);
    const last = segs[segs.length - 1];
    if (last && last.c.root === c.root && last.c.quality === c.quality) last.t1 = t1;
    else segs.push({ t0: t, t1, c });
    t = t1;
  }
  const chordPcsAt = (t: number) => songChordPcs((segs.find((g) => t >= g.t0 - 1e-6 && t < g.t1 - 1e-6) ?? segs[segs.length - 1]).c);

  const norm = a.norm;
  const rng = mulberry32((a.seed ^ hashString(input.seed ?? '') ^ 0x2c1b3c6d) >>> 0);
  const notes: SongNote[] = [];
  const push = (t: number, dur: number, midi: number, vel: number, voice: SongVoice, pan: number) => {
    if (!(vel > 0) || t >= T - 0.05 || t < 0) return;
    notes.push({ t, dur: Math.max(0.05, Math.min(dur, T - t)), midi: Math.round(midi), vel: clamp01(vel), voice, pan: Math.max(-1, Math.min(1, pan)) });
  };
  const iceBands = new Set<number>();
  for (const f of a.features) if (f.detected && ICE_FEATURES.includes(f.id)) f.bands.forEach((b) => iceBands.add(b));
  const finite = (i: number) => Number.isFinite(norm[i]);

  // melody register: in accompaniment the tonic sits in C4..B4 and spans 28 semitones (above the
  // vocal / chord middle of most mixes); stand-alone: an octave lower, 3 octaves
  const base = (acc ? 60 : 48) + tonic;
  const spanSemis = acc ? 28 : 36;
  /** Gentle dynamics: one-bar fade-in, last two beats softer. */
  const env = (t: number) => (0.7 + 0.3 * Math.min(1, t / bar)) * (t > T - 2 * beat ? 0.75 : 1);

  const mStart = Math.min(T * 0.12, bar), mEnd = T - Math.max(beat, T * 0.03);
  const mid = (mStart + mEnd) / 2;
  const snap = (t: number, unit: number) => off + Math.round((t - off) / unit) * unit;
  const slots = new Map<number, { i: number; v: number; t: number; loud: number; harmony: boolean }>();
  const sweep = (order: number[], t0: number, t1: number, loud: number, harmony: boolean) => {
    const lens = order.map((i) => (finite(i) ? stepLength(norm[i]) : stepLength(0) * 0.5));
    const k = (t1 - t0) / lens.reduce((s, x) => s + x, 0);
    let t = t0;
    order.forEach((i, j) => {
      const v = norm[i];
      if (finite(i) && v >= REST_BELOW && (v > 0.5 || rng() < 0.35 + v)) {
        const unit = acc || v >= 0.55 ? 2 * six : six;
        let q = snap(t, unit);
        if (q < t0 - 1e-6) q += unit;
        if (q < mEnd) {
          const slot = Math.round((q - off) / six);
          const prev = slots.get(slot);
          if (!prev || v > prev.v) slots.set(slot, { i, v, t: q, loud, harmony }); // brighter band wins the slot
        }
      }
      t += lens[j] * k;
    });
  };
  if (mEnd - mStart > 4 * six) {
    sweep(Array.from({ length: N_BANDS }, (_, j) => N_BANDS - 1 - j), mStart, mid, 1, false);
    sweep(Array.from({ length: N_BANDS }, (_, j) => j), mid, mEnd, acc ? 1.05 : 1.12, !acc);
  }
  const maxUnits = acc ? 8 : 16;
  for (const [slot, n] of [...slots.entries()].sort((x, y) => x[0] - y[0])) {
    const { i, v, t } = n;
    let midi = base + quantizeToScale(pitchPosition(BANDS[i].center) * spanSemis, steps);
    const onBeat = ((slot % 4) + 4) % 4 === 0;
    const chord = chordPcsAt(t);
    if (onBeat) {
      // nearest chord tone that is also in the scale (ties go down)
      for (let d = 0; d <= 4; d++) {
        if (chord.includes(pcOf(midi - d)) && inScale.has(pcOf(midi - d))) { midi -= d; break; }
        if (chord.includes(pcOf(midi + d)) && inScale.has(pcOf(midi + d))) { midi += d; break; }
      }
    }
    const units = Math.min(maxUnits, Math.max(1, Math.round(noteDuration(v) / six)));
    const vel = noteVelocity(v) * env(t) * n.loud * (acc ? 0.7 : 1) * (onBeat ? 1 : 0.85);
    const pan = detectorPan(BANDS[i].detector);
    const voice: SongVoice = iceBands.has(i) ? 'ice' : 'lead';
    push(t, units * six, midi, vel, voice, pan);
    if (n.harmony && v > 0.6) {
      for (let d = 3; d <= 9; d++) { // a chord tone (in scale) a third to a sixth below
        const m = midi - d;
        if (chord.includes(pcOf(m)) && inScale.has(pcOf(m))) { push(t, units * six * 0.8, m, vel * 0.45, 'lead', -pan * 0.5); break; }
      }
    }
    if (!acc && a.peaks[i] && v > 0.6 && rng() < 0.5) push(t, units * six * 0.7, midi + 12, vel * 0.3, voice, pan);
  }

  // ---- pad: the chord progression (close voicing); bass: the chord roots
  const padLo = acc ? 55 : 50, padVel = acc ? 0.4 : 0.8;
  segs.forEach((g, k) => {
    const len = g.t1 - g.t0;
    const overlap = k === segs.length - 1 ? 0 : 0.25;
    songChordPcs(g.c).forEach((pc, j) => push(g.t0, len + overlap, padLo + pcOf(pc - padLo), padVel * env(g.t0), 'pad', j % 2 ? 0.35 : -0.35));
    const root = pcOf(g.c.root);
    if (acc) push(g.t0, len * 0.9, 48 + root, 0.3 * env(g.t0), 'bass', 0);
    else for (let t = g.t0; t < g.t1 - 0.1; t += 2 * beat) push(t, Math.max(0.2, Math.min(2 * beat * 0.9, g.t1 - t)), 36 + root, 0.6 * env(t), 'bass', 0);
  });

  // ---- ice layer (as in the fixed piece): a sustained high chord tone on the feature timbre
  // through the middle of the piece, following the chords
  const iceStrength = Math.max(0, ...a.features.filter((f) => f.detected && ICE_FEATURES.includes(f.id)).map((f) => f.strength));
  if (iceStrength > 0) {
    segs.forEach((g, k) => {
      if (g.t0 < T * 0.3 || g.t0 >= T * 0.85) return;
      const pcs = songChordPcs(g.c), pc5 = inScale.has(pcs[2]) ? pcs[2] : pcs[0];
      push(g.t0, g.t1 - g.t0, base + 12 + pcOf(pc5 - base), (0.3 + 0.35 * iceStrength) * (acc ? 0.6 : 1), 'ice', k % 2 ? 0.5 : -0.5);
    });
  }

  for (const n of notes) { n.t = r4(n.t); n.dur = r4(n.dur); n.vel = r4(n.vel); n.pan = r4(n.pan); }
  notes.sort((x, y) => x.t - y.t || SONG_VOICES.indexOf(x.voice) - SONG_VOICES.indexOf(y.voice) || x.midi - y.midi || y.vel - x.vel);
  const lastOn = new Map<string, number>();
  out.notes = notes.filter((n) => {
    const k = `${n.voice}:${n.midi}`;
    const p = lastOn.get(k);
    if (p !== undefined && n.t - p < 0.01) return false;
    lastOn.set(k, n.t);
    return true;
  });
  return out;
}

// ---------------------------------------------------------------- MIDI

const PPQ = 480;
/** channel, General MIDI program (0-based), track name, reverb send. */
const MIDI_VOICE: Record<SongVoice, { ch: number; program: number; name: string; reverb: number }> = {
  lead: { ch: 0, program: 11, name: 'Lead (spectrum melody) - Vibraphone', reverb: 70 },
  pad: { ch: 1, program: 89, name: 'Pad (spectral colour) - Warm Pad', reverb: 90 },
  ice: { ch: 2, program: 98, name: 'Ice (absorption features) - Crystal', reverb: 100 },
  bass: { ch: 3, program: 38, name: 'Bass - Synth Bass', reverb: 30 },
};

function vlq(n: number): number[] {
  n = Math.max(0, Math.floor(n));
  const out = [n & 0x7f];
  while ((n >>>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

function textBytes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out.push(c < 128 ? c : 63); // MIDI text is ASCII: non-ASCII -> '?'
  }
  return out;
}

function meta(type: number, data: number[]): number[] {
  return [0xff, type, ...vlq(data.length), ...data];
}

function chunk(id: string, data: number[]): number[] {
  const n = data.length;
  return textBytes(id).concat([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], data);
}

/** Standard MIDI File, type 1: a tempo/conductor track + one track per voice (lead, pad, ice, bass). */
export function scoreToMidi(score: SongScore): Uint8Array {
  const bpm = Math.max(20, Math.min(300, score.bpm || 90));
  const ticksPerSec = (PPQ * bpm) / 60;
  const tick = (s: number) => Math.max(0, Math.round(s * ticksPerSec));
  const tracks: number[][] = [];

  const usPerQuarter = Math.round(60e6 / bpm);
  const title = score.input.label ? `Listar - ${score.input.label}` : 'Listar - star symphony';
  tracks.push([
    0, ...meta(0x03, textBytes(title)),
    0, ...meta(0x01, textBytes(`Generated algorithmically from SPHEREx measurements (NASA SPHEREx / IRSA). Key: ${score.key}.`)),
    0, ...meta(0x51, [(usPerQuarter >> 16) & 255, (usPerQuarter >> 8) & 255, usPerQuarter & 255]),
    0, ...meta(0x58, [4, 2, 24, 8]),
    tick(score.seconds), ...meta(0x2f, []),
  ]);

  for (const voice of SONG_VOICES) {
    const mv = MIDI_VOICE[voice];
    const ch = mv.ch;
    // [tick, order (0 off, 1 cc, 2 on), seq, bytes]
    const ev: [number, number, number, number[]][] = [];
    const notes = score.notes.filter((n) => n.voice === voice).sort((x, y) => x.t - y.t || x.midi - y.midi);
    const ends: { start: number; end: number; midi: number; vel: number; pan: number }[] = [];
    const sounding = new Map<number, (typeof ends)[number]>();
    for (const n of notes) {
      const midi = Math.max(0, Math.min(127, Math.round(n.midi)));
      const s = tick(n.t);
      const prev = sounding.get(midi);
      // Same pitch re-struck while still sounding: end the previous one there.
      if (prev && prev.end > s) prev.end = Math.max(prev.start + 1, s);
      const e = { start: s, end: Math.max(s + 1, tick(n.t + n.dur)), midi, vel: n.vel, pan: n.pan };
      sounding.set(midi, e);
      ends.push(e);
    }
    let seq = 0;
    let lastPan = -1;
    for (const e of ends) {
      const pan = Math.max(0, Math.min(127, Math.round(((e.pan + 1) / 2) * 127)));
      if (pan !== lastPan) { ev.push([e.start, 1, seq++, [0xb0 | ch, 10, pan]]); lastPan = pan; }
      ev.push([e.start, 2, seq++, [0x90 | ch, e.midi, Math.max(1, Math.min(127, Math.round(e.vel * 127)))]]);
      ev.push([e.end, 0, seq++, [0x80 | ch, e.midi, 64]]);
    }
    ev.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    const data: number[] = [
      0, ...meta(0x03, textBytes(mv.name)),
      0, 0xc0 | ch, mv.program,
      0, 0xb0 | ch, 7, 100,
      0, 0xb0 | ch, 91, mv.reverb,
    ];
    let last = 0;
    for (const [t, , , bytes] of ev) {
      for (const b of vlq(t - last)) data.push(b);
      for (const b of bytes) data.push(b);
      last = t;
    }
    const endT = Math.max(last, tick(score.seconds));
    data.push(...vlq(endT - last), ...meta(0x2f, []));
    tracks.push(data);
  }

  const header = chunk('MThd', [0, 1, 0, tracks.length, (PPQ >> 8) & 255, PPQ & 255]);
  const bytes = header.concat(...tracks.map((t) => chunk('MTrk', t)));
  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------- audio

/** Timbre of the 'ice' voice: the live feature voice of the strongest detected absorption. */
function iceTimbre(score: SongScore): Voice {
  const f = score.features.find((id) => (ICE_FEATURES as readonly string[]).includes(id)) as FeatureId | undefined;
  return f ? FEATURE_VOICE[f] : 'shimmer';
}

/** Schedule every note of `score` on `ctx` at absolute time `t0`. Returns all sources. */
function scheduleScore(score: SongScore, ctx: BaseAudioContext, dest: AudioNode, t0: number, voices?: readonly SongVoice[]) {
  const chain = buildChain(ctx, dest, 1);
  const ice = iceTimbre(score);
  const srcs: AudioScheduledSourceNode[] = [];
  for (const n of score.notes) {
    if (voices && !voices.includes(n.voice)) continue;
    const at = t0 + n.t;
    if (n.voice === 'pad' || n.voice === 'bass') srcs.push(...playPadNote(chain, at, n.midi, n.vel, n.dur, n.pan, n.voice));
    else srcs.push(...playVoice(chain, at, n.midi, n.vel, n.dur, n.pan, n.voice === 'ice' ? ice : 'soft'));
  }
  return { chain, srcs };
}

/** Real-time playback through the live symphony's voices, reverb and limiter. */
export function playScore(
  score: SongScore, ctx: AudioContext, dest?: AudioNode,
  opts?: { onNote?(n: SongNote): void; startAt?: number },
): { stop(): void; duration: number } {
  const t0 = Math.max(ctx.currentTime, opts?.startAt ?? ctx.currentTime + 0.1);
  const { chain, srcs } = scheduleScore(score, ctx, dest ?? ctx.destination, t0);
  const timers: ReturnType<typeof setTimeout>[] = [];
  if (opts?.onNote) {
    const cb = opts.onNote;
    for (const n of score.notes) {
      const ms = (t0 + n.t - ctx.currentTime) * 1000;
      timers.push(setTimeout(() => cb(n), Math.max(0, ms)));
    }
  }
  let stopped = false;
  return {
    duration: score.seconds,
    stop() {
      if (stopped) return;
      stopped = true;
      timers.forEach(clearTimeout);
      const now = ctx.currentTime;
      try {
        chain.master.gain.cancelScheduledValues(now);
        chain.master.gain.setValueAtTime(chain.master.gain.value, now);
        chain.master.gain.linearRampToValueAtTime(0, now + 0.15);
      } catch { /* closed context */ }
      setTimeout(() => {
        for (const s of srcs) { try { s.stop(); } catch { /* not started / already stopped */ } }
        try { chain.master.disconnect(); } catch { /* */ }
      }, 200);
    },
  };
}

type OfflineCtor = typeof OfflineAudioContext;

/** Offline render of (some voices of) a score: 16-bit stereo WAV, normalised to -1 dBFS, 1.5 s tail. */
export async function renderScoreToWav(score: SongScore, sampleRate = 44100, voices?: readonly SongVoice[]): Promise<Blob> {
  const g = globalThis as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  const Ctor = g.OfflineAudioContext || g.webkitOfflineAudioContext;
  if (!Ctor) throw new Error('OfflineAudioContext is not supported in this environment');
  const len = Math.ceil((score.seconds + 1.5) * sampleRate);
  const ctx = new Ctor(2, len, sampleRate);
  scheduleScore(score, ctx, ctx.destination, 0, voices);
  const buf = await ctx.startRendering();
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  let peak = 0;
  for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const gain = peak > 1e-6 ? 0.891 / peak : 1; // -1 dBFS
  // Short fade at the very end so the file never ends on a click.
  const fade = Math.min(L.length, Math.round(sampleRate * 0.25));
  const l = new Float32Array(L.length), r = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) {
    const f = i >= L.length - fade ? (L.length - i) / fade : 1;
    l[i] = L[i] * gain * f; r[i] = R[i] * gain * f;
  }
  return new Blob([encodeWav([l, r], sampleRate)], { type: 'audio/wav' });
}

/** Save a Blob as a file (browser only). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** File-name-safe slug for downloads. */
export function songSlug(label?: string): string {
  const s = (label ?? '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_]+/g, '-').slice(0, 48);
  return s ? `listar-${s}` : 'listar-symphony';
}
