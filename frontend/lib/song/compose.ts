/**
 * StarChord "Your sky song" composer: the data decides, the rules compose.
 *
 * The real 102-band SPHEREx spectrum of the zenith patch chooses
 *  - the key (one of the warm keys C D Eb F G A Bb, from the spectral colour index),
 *  - the mode (blue / flat -> major; red or ice / gas absorption -> minor or dorian),
 *  - the tempo (76-92 BPM, from mean brightness and spectral texture),
 *  - the chord progressions (from a curated set, picked by peak / absorption counts),
 *  - the melody's motif (the spectrum's shape downsampled to 4-8 points -> scale-degree steps),
 *  - the rhythm family (smooth vs. textured spectrum) and the note velocities (band brightness),
 *  - sparse bell ornaments when H2O-ice / CO2 / CO / CH4 / PAH features are detected.
 * Fixed composition rules (ours): the form (intro 2 - A - B - A' 4 - outro 2 bars, ~45-50 s,
 * 4/4), voice-led pads (MIDI 48-67), bass on roots / fifths (33-48), melody in A3-E5 (57-76)
 * with chord tones on strong beats, 2-bar call / response phrases, and a cadence on the tonic.
 *
 * Pure and deterministic (no DOM, no Math.random): same spectrum + seed -> identical score.
 * Returns the symphony's SongScore so playScore / renderScoreToWav / scoreToMidi keep working.
 * Read-only use of lib/symphony (core analysis + feature detection, export types).
 */
import { analyseSpectrum, bandIndexFor, BANDS, BANDS_PER_DETECTOR, binToBands, detectorPan, mulberry32, N_BANDS, type FeatureId } from '../symphony/core';
import type { SongInput, SongNote, SongScore } from '../symphony/export';

export type SongMode = 'major' | 'minor' | 'dorian';
export type SectionName = 'intro' | 'A' | 'B' | "A'" | 'outro';

export const MODE_STEPS: Record<SongMode, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
};
/** Warm keys, dark (flat side) -> bright (sharp side) of the circle of fifths: Eb Bb F C G D A. */
export const WARM_KEYS: readonly number[] = [3, 10, 5, 0, 7, 2, 9];
const NOTE_EN = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** A chord token: a scale degree 0-6, or 'V' = major dominant (harmonic minor). */
type Tok = number | 'V';
const PROGRESSIONS: Record<SongMode, readonly (readonly Tok[])[]> = {
  major: [[0, 4, 5, 3], [0, 5, 3, 4], [5, 3, 0, 4], [0, 3, 5, 4]], // I-V-vi-IV, I-vi-IV-V, vi-IV-I-V, I-IV-vi-V
  minor: [[0, 5, 2, 6], [0, 3, 6, 2], [0, 5, 3, 'V']], // i-VI-III-VII, i-iv-VII-III, i-VI-iv-V
  dorian: [[0, 3, 6, 2], [0, 3, 0, 6]], // i-IV-VII-III, i-IV-i-VII
};
/** Pre-dominant and dominant of each mode (B extension and the final cadence). */
const PRE: Record<SongMode, Tok> = { major: 3, minor: 3, dorian: 3 };
const DOM: Record<SongMode, Tok> = { major: 4, minor: 'V', dorian: 6 };

/** Melody, pad, bass, arpeggio and ornament registers (MIDI). */
export const RANGE = {
  melody: [57, 76], pad: [48, 67], bass: [33, 48], arp: [55, 67], ice: [60, 84],
} as const satisfies Record<string, readonly [number, number]>;

/** Rhythm cells in eighth notes (negative = rest). Bar 1 of a phrase: */
const BAR1_SMOOTH: readonly (readonly number[])[] = [[2, 2, 2, 2], [3, 1, 2, 2], [4, 2, 2], [3, 1, 3, 1]];
const BAR1_TEXTURED: readonly (readonly number[])[] = [[2, 1, 1, 2, 2], [2, 2, 1, 1, 2], [3, 1, 2, 1, 1], [1, 1, 2, 2, 2]];
/** Bar 2: call (open, final note on beat 3), answer (long final note on beat 1), cadence (flows on). */
const BAR2_CALL: readonly (readonly number[])[] = [[2, 2, 3, -1], [4, 3, -1]];
const BAR2_ANSWER: readonly number[] = [6, -2];
const BAR2_FLOW: readonly number[] = [2, 2, 2, 2];

const ORNAMENT_FEATURES: readonly FeatureId[] = ['h2o', 'co2', 'co', 'ch4', 'pah'];
const ABSORPTIONS: readonly FeatureId[] = ['h2o', 'co2', 'co', 'ch4'];

export interface SongChordInfo {
  /** Start and length in eighth notes from the start of the piece. */
  e: number;
  len: number;
  root: number;
  /** Triad pitch classes (root, third, fifth). */
  pcs: number[];
  /** Pitch classes allowed over this chord: the mode's scale, with the chord's own tones substituted. */
  allowed: number[];
  label: string;
  section: SectionName;
}

export interface SkySong {
  score: SongScore;
  /** Tonic pitch class (C = 0). */
  tonic: number;
  mode: SongMode;
  bpm: number;
  bars: number;
  /** Roman numerals of the A and B progressions. */
  progression: string[];
  progressionB: string[];
  sections: { name: SectionName; bar: number; bars: number }[];
  chords: SongChordInfo[];
  /** The motif: scale-degree steps taken from the spectrum's contour. */
  motif: number[];
  /** Data features that drove the choices (for the readout / debugging). */
  traits: { colourIndex: number; texture: number; brightness: number; absorption: number; peaks: number };
  /** SPHEREx band indices (0-101) behind a melody note; [] for the accompaniment. */
  bandsOf(n: SongNote): readonly number[];
}

/** FNV-1a of a string. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const pcOf = (m: number) => ((Math.round(m) % 12) + 12) % 12;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

function buildChord(tonic: number, mode: SongMode, tok: Tok) {
  const steps = MODE_STEPS[mode];
  const d = tok === 'V' ? 4 : tok;
  const at = (k: number) => pcOf(tonic + steps[(d + k) % 7]);
  const root = at(0);
  const third = tok === 'V' ? pcOf(root + 4) : at(2);
  const fifth = at(4);
  const seventh = at(6);
  const i3 = pcOf(third - root), i5 = pcOf(fifth - root);
  const quality = i3 === 4 ? 'maj' : i5 === 6 ? 'dim' : 'min';
  const label = quality === 'maj' ? ROMAN[d] : ROMAN[d].toLowerCase() + (quality === 'dim' ? '°' : '');
  const scale = steps.map((s) => pcOf(tonic + s));
  // A chord tone outside the scale (the raised 7th of a harmonic-minor V) replaces its neighbour.
  const allowed = scale.map((p) => ([root, third, fifth].includes(p) ? p : [root, third, fifth].includes(pcOf(p + 1)) && !scale.includes(pcOf(p + 1)) ? pcOf(p + 1) : p));
  return { root, pcs: [root, third, fifth], seventh, label, allowed: [...new Set(allowed)].sort((a, b) => a - b) };
}

/** Nearest MIDI note >= / <= m (searching outward) whose pitch class is in `pcs`; ties go `prefer`. */
function nearestIn(m: number, pcs: readonly number[], prefer: 1 | -1 = -1, exclude: readonly number[] = []): number {
  for (let d = 0; d <= 12; d++) {
    const a = m + prefer * d, b = m - prefer * d;
    if (pcs.includes(pcOf(a)) && !exclude.includes(pcOf(a))) return a;
    if (pcs.includes(pcOf(b)) && !exclude.includes(pcOf(b))) return b;
  }
  return m;
}

/** Chord tone within a 4th of the candidate m, closest to the previous note (then to m). */
function chordToneNear(m: number, prev: number, pcs: readonly number[]): number {
  let best = nearestIn(m, pcs), cost = Infinity;
  for (let c = m - 4; c <= m + 4; c++) {
    if (!pcs.includes(pcOf(c))) continue;
    const k = Math.abs(c - prev) + 0.6 * Math.abs(c - m) + (c === prev ? 1.5 : 0);
    if (k < cost - 1e-9) { cost = k; best = c; }
  }
  return best;
}

/** Move `steps` scale positions from m (m snapped into the allowed set first). */
function stepIn(m: number, steps: number, pcs: readonly number[]): number {
  let x = nearestIn(m, pcs);
  const dir = Math.sign(steps);
  for (let k = 0; k < Math.abs(steps); k++) {
    x += dir;
    while (!pcs.includes(pcOf(x))) x += dir;
  }
  return x;
}

/** Every voicing of `pcs` inside [lo, hi] with no semitone between neighbouring voices. */
function voicings(pcs: readonly number[], lo: number, hi: number): number[][] {
  const opts = pcs.map((pc) => {
    const o: number[] = [];
    for (let m = lo; m <= hi; m++) if (pcOf(m) === pc) o.push(m);
    return o;
  });
  const out: number[][] = [];
  const rec = (k: number, acc: number[]) => {
    if (k === opts.length) {
      const v = [...acc].sort((a, b) => a - b);
      for (let i = 1; i < v.length; i++) if (v[i] - v[i - 1] < 2) return;
      if (v[v.length - 1] - v[0] > 16) return;
      out.push(v);
      return;
    }
    for (const m of opts[k]) rec(k + 1, [...acc, m]);
  };
  rec(0, []);
  return out;
}

/** Smoothest voicing after `prev` (or a central one to start). */
function voiceLead(pcs: readonly number[], prev: readonly number[] | null): number[] | null {
  const vs = voicings(pcs, RANGE.pad[0], RANGE.pad[1]);
  if (!vs.length) return null;
  let best = vs[0], bestCost = Infinity;
  for (const v of vs) {
    let cost = 0;
    if (prev && prev.length) {
      if (prev.length === v.length) v.forEach((m, i) => { cost += Math.abs(m - prev[i]); });
      else for (const m of v) cost += Math.min(...prev.map((p) => Math.abs(p - m)));
    } else {
      cost = Math.abs(v.reduce((s, m) => s + m, 0) / v.length - 58);
    }
    if (v[0] < 52) cost += 3; // low close thirds get muddy
    if (cost < bestCost - 1e-9) { best = v; bestCost = cost; }
  }
  return best;
}

/**
 * Compose the sky song. `targetSeconds` (default 47.5) picks the bar count; the music lasts
 * bars * 4 beats, between about 44.5 and 50.5 s at 76-92 BPM.
 */
export function composeSkySong(input: SongInput, targetSeconds = 47.5): SkySong {
  const lam = input.lambda_um ?? [];
  const inten = (input.intensity ?? []).map((v) => (v === null || v === undefined ? NaN : Number(v)));
  const a = analyseSpectrum(binToBands(lam, inten));
  const norm = a.norm;
  const finite = (i: number) => Number.isFinite(norm[i]);
  const valid: number[] = [];
  for (let i = 0; i < N_BANDS; i++) if (finite(i)) valid.push(i);

  // ---------------------------------------------------------------- data traits
  let rough = 0, nr = 0, bright = 0;
  for (const i of valid) bright += norm[i];
  bright = valid.length ? bright / valid.length : 0;
  for (let i = 1; i < N_BANDS; i++) {
    if (i % BANDS_PER_DETECTOR === 0 || !finite(i) || !finite(i - 1)) continue;
    rough += Math.abs(norm[i] - norm[i - 1]); nr++;
  }
  rough = nr ? rough / nr : 0;
  const texture = clamp((rough - 0.02) / 0.1, 0, 1);
  const peaks = a.peaks.filter(Boolean).length;
  const detected = a.features.filter((f) => f.detected);
  const absorption = detected.filter((f) => ABSORPTIONS.includes(f.id)).reduce((s, f) => s + f.strength, 0);
  const absCount = detected.filter((f) => ABSORPTIONS.includes(f.id)).length;
  const ornamentStrength = Math.max(0, ...detected.filter((f) => ORNAMENT_FEATURES.includes(f.id)).map((f) => f.strength));
  const ci = a.colourIndex;
  const dseed = a.seed >>> 0; // hash of the spectrum's shape (data)
  const frac = (shift: number) => ((dseed >>> shift) % 1000) / 1000;

  // ---------------------------------------------------------------- key, mode, tempo, form
  // Colour relative to the real sky: across the DR1 all-sky index the colour index has
  // percentiles 5/25/50/75/95 = 0.39/0.63/0.73/0.80/0.85; rc = 0 at the median, ~ -1.5..+1.1.
  const rc = ci < 0.72 ? (ci - 0.72) / 0.22 : (ci - 0.72) / 0.12;
  const keyIdx = clamp(Math.round(3 + 3 * rc + (frac(0) - 0.5) * 1.2), 0, 6);
  const tonic = WARM_KEYS[keyIdx];
  const mode: SongMode = absorption > 0.5 ? 'minor'
    : rc < -0.45 ? (absorption > 0 || rc < -1 ? 'minor' : 'dorian')
      : absorption > 0 ? 'dorian' : 'major';
  const tempoF = clamp(0.55 * clamp(texture / 0.6, 0, 1) + 0.45 * clamp((bright - 0.3) / 0.22, 0, 1) + (frac(10) - 0.5) * 0.3, 0, 1);
  const bpm = Math.round(76 + 16 * tempoF);
  const E = 30 / bpm; // eighth note (s)
  const barS = 8 * E;
  const target = clamp(Number.isFinite(targetSeconds) ? targetSeconds : 47.5, 30, 70);
  let N = 16;
  for (const n of [16, 18, 20, 22, 24]) if (Math.abs(n * barS - target) < Math.abs(N * barS - target)) N = n;
  const rest = N - 8;
  const bBars = Math.min(8, rest - 4), aBars = rest - bBars;
  const sections: SkySong['sections'] = [
    { name: 'intro', bar: 0, bars: 2 },
    { name: 'A', bar: 2, bars: aBars },
    { name: 'B', bar: 2 + aBars, bars: bBars },
    { name: "A'", bar: 2 + aBars + bBars, bars: 4 },
    { name: 'outro', bar: N - 2, bars: 2 },
  ];
  const T = N * barS;

  // ---------------------------------------------------------------- harmony
  const list = PROGRESSIONS[mode];
  const pIdx = (peaks + 2 * absCount + (dseed >>> 4)) % list.length;
  const qIdx = (pIdx + 1 + ((dseed >>> 9) % (list.length - 1))) % list.length;
  const progA = list[pIdx], progB = list[qIdx];
  const chords: SongChordInfo[] = [];
  const addChord = (e: number, len: number, tok: Tok, section: SectionName) => {
    const c = buildChord(tonic, mode, tok);
    chords.push({ e, len, root: c.root, pcs: c.pcs, allowed: c.allowed, label: c.label, section });
  };
  const toks: { e: number; len: number; tok: Tok; section: SectionName }[] = [];
  const put = (bar: number, tok: Tok, section: SectionName, half = 0) => toks.push({ e: bar * 8 + half * 4, len: half ? 4 : 8, tok, section });
  put(0, 0, 'intro'); put(1, progA[3], 'intro');
  for (let k = 0; k < aBars; k++) put(2 + k, progA[k % 4], 'A');
  const b0 = 2 + aBars;
  for (let k = 0; k < bBars; k++) {
    const ext = bBars % 4 === 2 && k >= bBars - 2; // 6-bar B: 4 bars + a 2-bar pre-dominant -> dominant build
    put(b0 + k, ext ? (k === bBars - 2 ? PRE[mode] : DOM[mode]) : progB[k % 4], 'B');
  }
  const a2 = b0 + bBars;
  for (let k = 0; k < 4; k++) {
    const tok = progA[k];
    if (k === 3 && tok !== DOM[mode]) {
      toks.push({ e: (a2 + k) * 8, len: 4, tok, section: "A'" });
      toks.push({ e: (a2 + k) * 8 + 4, len: 4, tok: DOM[mode], section: "A'" });
    } else put(a2 + k, tok, "A'");
  }
  toks.push({ e: (N - 2) * 8, len: 16, tok: 0, section: 'outro' });
  for (const t of toks) addChord(t.e, t.len, t.tok, t.section);
  function chordIndexAt(e: number) {
    let k = 0;
    for (let i = 0; i < chords.length; i++) if (chords[i].e <= e) k = i;
    return k;
  }
  const chordAt = (e: number) => chords[chordIndexAt(e)];
  const sectionAt = (e: number) => sections.filter((s) => s.bar * 8 <= e).pop()!;

  const features = detected
    .slice()
    .sort((x, y) => y.strength - x.strength || x.id.localeCompare(y.id))
    .map((f) => f.id as string);
  const score: SongScore = { seconds: r4(T), bpm, notes: [], key: `${NOTE_EN[tonic]} ${mode}`, features, input };
  const bandMap = new WeakMap<SongNote, number[]>();
  const song: SkySong = {
    score, tonic, mode, bpm, bars: N,
    progression: progA.map((t) => buildChord(tonic, mode, t).label),
    progressionB: progB.map((t) => buildChord(tonic, mode, t).label),
    sections, chords, motif: [],
    traits: { colourIndex: r4(ci), texture: r4(texture), brightness: r4(bright), absorption: r4(absorption), peaks },
    bandsOf: (n) => bandMap.get(n) ?? [],
  };
  if (a.valid < 3) return song; // nothing measured -> silence (we never invent a song)

  const rng = mulberry32((dseed ^ hashString(input.seed ?? '') ^ 0x5bd1e995) >>> 0);
  const notes: SongNote[] = [];
  const push = (e: number, len: number, midi: number, vel: number, voice: SongNote['voice'], pan: number): SongNote => {
    const n: SongNote = { t: e * E, dur: len * E, midi: Math.round(midi), vel: clamp(vel, 0, 1), voice, pan: clamp(pan, -1, 1) };
    notes.push(n);
    return n;
  };

  // ---------------------------------------------------------------- motif from the spectrum
  const M = clamp(4 + Math.round(4 * texture + (frac(14) - 0.5)), 4, 8);
  const segs: { bands: number[]; v: number }[] = [];
  for (let j = 0; j < M; j++) {
    const bands = valid.slice(Math.floor((j * valid.length) / M), Math.floor(((j + 1) * valid.length) / M));
    const v = bands.length ? bands.reduce((s, i) => s + norm[i], 0) / bands.length : bright;
    segs.push({ bands, v });
  }
  const vmin = Math.min(...segs.map((s) => s.v)), vmax = Math.max(...segs.map((s) => s.v));
  const contour = segs.map((s) => (vmax - vmin > 1e-9 ? (s.v - vmin) / (vmax - vmin) : 0.5));
  const motif: number[] = [];
  let leaps = 0;
  for (let j = 1; j < M; j++) {
    const d = contour[j] - contour[j - 1];
    const ad = Math.abs(d);
    let mag = ad < 0.06 ? 0 : Math.max(1, Math.min(3, Math.round(ad * 3.5)));
    if (mag >= 2 && ++leaps > (M > 5 ? 2 : 1)) mag = 1; // mostly stepwise: one or two leaps (a 3rd-5th)
    if (mag === 0 && motif.length && motif[motif.length - 1] === 0) mag = 1; // no long repeated notes
    motif.push(mag * (d < 0 ? -1 : 1));
  }
  song.motif = motif.slice();
  const segBright = segs.map((s) => s.v);

  // ---------------------------------------------------------------- melody
  const [LO, HI] = RANGE.melody;
  // phrase centres: mid-register for A (room to move both ways), a fourth higher for the B climax
  const cA = 65, cB = 70;
  const smooth = texture < 0.45;
  const bar1A = (smooth ? BAR1_SMOOTH : BAR1_TEXTURED)[(peaks + (dseed >>> 13)) % 4];
  const bar1B = BAR1_TEXTURED[(peaks + absCount + (dseed >>> 17)) % 4];
  const bar2Call = BAR2_CALL[(dseed >>> 21) % 2];
  /** Dynamics of the form, 0..1: soft A, growing to the climax at the end of B, softer A'. */
  const dyn = (e: number) => {
    const s = sectionAt(e);
    const p = (e - s.bar * 8) / (s.bars * 8);
    return s.name === 'A' ? 0.35 + 0.15 * p : s.name === 'B' ? 0.6 + 0.4 * p : s.name === "A'" ? 0.5 - 0.15 * p : 0.25;
  };
  const melody: SongNote[] = [];
  const longEnds: SongNote[] = [];
  let noteNo = 0;
  let lastMel = 0;

  type End = 'open' | 'home' | 'lead';
  const phrase = (bar: number, bar1: readonly number[], bar2: readonly number[], steps: readonly number[], center: number, end: End, finalTonic = 0) => {
    const ev: { e: number; len: number }[] = [];
    let e = bar * 8;
    for (const d of [...bar1, ...bar2]) { if (d > 0) ev.push({ e, len: d }); e += Math.abs(d); }
    let prev = 0, prev2 = -1;
    // the motif, then its retrograde inversion: an arch that comes back to where it started
    const arch = [...steps, ...steps.slice().reverse().map((x) => -x)];
    ev.forEach((x, k) => {
      const ch = chordAt(x.e);
      const strong = x.e % 4 === 0;
      const last = k === ev.length - 1;
      let m: number;
      if (k === 0) {
        m = nearestIn(center, ch.pcs, 1);
        while (m > HI) m -= 12;
        while (m < LO) m += 12;
        // a new phrase starts near where the last one ended (at most a fifth away)
        if (lastMel && Math.abs(m - lastMel) > 7) m = nearestIn(lastMel + clamp(m - lastMel, -7, 7), ch.pcs, m > lastMel ? -1 : 1);
      } else {
        let st = arch.length ? arch[(k - 1) % arch.length] : 1;
        // gap fill: after a leap, turn back by step
        if (k >= 2 && Math.abs(prev - prev2) > 4) st = prev > prev2 ? -1 : 1;
        m = stepIn(prev, st, ch.allowed);
        // keep the contour inside the register and near the section's centre: turn back by step
        if (m > HI || m < LO || Math.abs(m - center) > 7) {
          const turn = stepIn(prev, m > prev ? -1 : 1, ch.allowed);
          if (Math.abs(turn - center) < Math.abs(m - center) || m > HI || m < LO) m = turn;
        }
        if (m === prev && prev === prev2) m = stepIn(m, m > center ? -1 : 1, ch.allowed);
        if (strong) m = chordToneNear(m, prev, ch.pcs);
        if (last && end === 'open') m = nearestIn(m, ch.pcs, -1, ch.pcs.length > 1 && ch.pcs.includes(tonic) ? [tonic] : []);
        if (last && end === 'home') m = nearestIn(m, ch.pcs.includes(tonic) ? [tonic] : ch.pcs, -1);
        if (last && end === 'lead') {
          const up = stepIn(finalTonic, 1, ch.allowed), down = stepIn(finalTonic, -1, ch.allowed);
          m = Math.abs(up - prev) <= Math.abs(down - prev) ? up : down;
        }
      }
      while (m > HI) m -= 12;
      while (m < LO) m += 12;
      if (!ch.allowed.includes(pcOf(m))) m = nearestIn(m, ch.allowed);
      if (k > 0 && Math.abs(m - prev) > 9) {
        // never a leap wider than a sixth: the nearest note of the same kind within a fifth
        const kind = strong || last ? (last && end !== 'open' ? [pcOf(m)] : ch.pcs) : ch.allowed;
        let alt = nearestIn(prev + clamp(m - prev, -7, 7), kind, m > prev ? -1 : 1);
        if (Math.abs(alt - prev) > 9 || alt > HI || alt < LO) alt = nearestIn(prev + clamp(m - prev, -7, 7), ch.pcs, m > prev ? -1 : 1);
        if (alt <= HI && alt >= LO) m = alt;
      }
      const seg = noteNo % M;
      noteNo++;
      const vel = clamp(0.45 + 0.35 * (0.35 * segBright[seg] + 0.65 * dyn(x.e)) + (strong ? 0.03 : 0) - (last ? 0.03 : 0), 0.45, 0.8);
      const n = push(x.e, x.len, m, vel, 'lead', detectorPan(BANDS[segs[seg].bands[0] ?? 0].detector) * 0.25);
      bandMap.set(n, segs[seg].bands);
      melody.push(n);
      if (last && x.len >= 3) longEnds.push(n);
      prev2 = prev; prev = m; lastMel = m;
    });
    return prev;
  };
  const answerSteps = motif.map((s, j) => (j >= Math.floor(motif.length / 2) ? -s : s)); // mirrored tail
  const inverted = motif.map((s) => -clamp(s, -2, 2)); // light inversion
  const descending = motif.map((s) => -Math.abs(s) || -1);

  // A: call / answer (and a sequence a chord tone higher in longer A sections)
  for (let p = 0; p < aBars / 2; p++) {
    const bar = 2 + 2 * p;
    const lastOfA = p === aBars / 2 - 1;
    if (p % 2 === 0) phrase(bar, bar1A, bar2Call, motif, cA + (p ? 3 : 0), 'open');
    else phrase(bar, bar1A, BAR2_ANSWER, answerSteps, cA - 2, lastOfA ? 'open' : 'home');
  }
  // B: sequence up -> light inversion -> climax -> descending answer
  const bPlan: [readonly number[], number][] = [[motif, cB], [inverted, cB + 2], [motif, cB + 3], [descending, cB]];
  for (let p = 0; p < bBars / 2; p++) {
    const [steps, c] = bPlan[p];
    phrase(b0 + 2 * p, bar1B, p === bBars / 2 - 1 || p % 2 === 1 ? BAR2_ANSWER : bar2Call, steps, Math.min(c, HI - 4), 'open');
  }
  // A': the motif restated, then the cadence that flows into the tonic
  phrase(a2, bar1A, bar2Call, motif, cA, 'open');
  const finalTonic = nearestIn(62, [tonic], -1) < LO ? nearestIn(62, [tonic], -1) + 12 : nearestIn(62, [tonic], -1);
  phrase(a2 + 2, bar1A, BAR2_FLOW, answerSteps, cA - 2, 'lead', finalTonic);
  // outro: the tonic, held
  {
    const e = (N - 2) * 8;
    const n = push(e, 8, finalTonic, 0.5, 'lead', 0);
    bandMap.set(n, segs[(noteNo - 1 + M) % M]?.bands ?? []);
    melody.push(n);
    longEnds.push(n);
  }

  // ---------------------------------------------------------------- pad (voice-led) + bass
  const rich = peaks >= 4 || texture > 0.5;
  const padVel = (s: SectionName) => (s === 'intro' ? 0.28 : s === 'A' ? 0.34 : s === 'B' ? 0.42 : s === "A'" ? 0.36 : 0.3);
  const bassVel = (s: SectionName) => (s === 'intro' ? 0.42 : s === 'A' ? 0.48 : s === 'B' ? 0.56 : s === "A'" ? 0.5 : 0.45);
  let prevV: number[] | null = null;
  const open = new Map<number, SongNote>();
  chords.forEach((c, k) => {
    const sev = c.section !== 'outro' && c.section !== 'intro' && (c.section === 'B' || (rich && toks[k].tok !== 0));
    let pcs = sev ? [...c.pcs, buildChord(tonic, mode, toks[k].tok).seventh] : c.pcs;
    let v = voiceLead(pcs, prevV);
    if (!v) { pcs = c.pcs; v = voiceLead(pcs, prevV)!; }
    const keep = new Set<number>();
    for (const m of v) {
      const held = open.get(m);
      if (held) { held.dur += c.len * E; keep.add(m); continue; }
      const n = push(c.e, c.len, m, padVel(c.section), 'pad', (m % 2 ? 0.3 : -0.3));
      open.set(m, n); keep.add(m);
    }
    for (const [m, n] of [...open]) {
      if (keep.has(m)) continue;
      n.dur += 2 * E; // a beat of overlap: the old chord tone fades under the new one
      open.delete(m);
    }
    prevV = v;

    // bass
    const root = c.root + 36 <= RANGE.bass[1] ? c.root + 36 : c.root + 24;
    const fifth = root + 7 <= RANGE.bass[1] ? root + 7 : root - 5;
    const bv = bassVel(c.section);
    if (c.section === 'intro' || c.section === 'outro') {
      for (let e = c.e; e < c.e + c.len; e += 8) push(e, 8, root, c.section === 'outro' && e > c.e ? bv - 0.05 : bv, 'bass', 0);
    } else if (c.len === 8) {
      push(c.e, 4, root, bv, 'bass', 0);
      const next = chords[k + 1];
      if (c.section === 'B' && next && next.root !== c.root && rng() < 0.55) {
        // an occasional passing note on beat 4, a scale step from the next root
        const nr = next.root + 36 <= RANGE.bass[1] ? next.root + 36 : next.root + 24;
        const pass = stepIn(nr, fifth > nr ? 1 : -1, c.allowed);
        push(c.e + 4, 2, fifth, bv - 0.04, 'bass', 0);
        push(c.e + 6, 2, clamp(pass, RANGE.bass[0], RANGE.bass[1]), bv - 0.08, 'bass', 0);
      } else push(c.e + 4, 4, fifth, bv - 0.04, 'bass', 0);
    } else push(c.e, c.len, root, bv, 'bass', 0);
  });
  for (const n of notes) if (n.voice === 'pad' && n.t + n.dur > T) n.dur = T - n.t;

  // ---------------------------------------------------------------- B: a quiet arpeggio under the melody
  for (let bar = b0; bar < b0 + bBars; bar++) {
    for (const off of [2, 4, 6]) {
      const e = bar * 8 + off;
      const c = chordAt(e);
      const tones: number[] = [];
      for (let m = RANGE.arp[0]; m <= RANGE.arp[1]; m++) if (c.pcs.includes(pcOf(m))) tones.push(m);
      const j = off / 2 - 1 + (bar % 2);
      const m = tones[Math.min(tones.length - 1, j)];
      if (m === undefined || melody.some((x) => x.midi === m && Math.abs(x.t - e * E) < 1e-6)) continue;
      push(e, 2, m, 0.28 + 0.08 * dyn(e), 'lead', 0.4);
    }
  }

  // ---------------------------------------------------------------- ice / gas / PAH bell ornaments
  if (ornamentStrength > 0 && longEnds.length) {
    const want = Math.min(longEnds.length, ornamentStrength >= 0.6 ? 4 : features.length > 1 ? 3 : 2);
    const picks = new Set<number>([longEnds.length - 1]);
    let guard = 0;
    while (picks.size < want && guard++ < 50) picks.add(Math.floor(rng() * longEnds.length));
    [...picks].sort((x, y) => x - y).forEach((k, j) => {
      const n = longEnds[k];
      const e = Math.round(n.t / E) + 2;
      if (e + 4 > N * 8) return;
      const m = n.midi + 12 <= RANGE.ice[1] ? n.midi + 12 : n.midi;
      push(e, 4, m, 0.16 + 0.12 * ornamentStrength, 'ice', j % 2 ? 0.5 : -0.5);
    });
  }

  // ---------------------------------------------------------------- tidy
  const order: SongNote['voice'][] = ['lead', 'pad', 'ice', 'bass'];
  for (const n of notes) { n.t = r4(n.t); n.dur = r4(n.dur); n.vel = r4(n.vel); n.pan = r4(n.pan); }
  notes.sort((x, y) => x.t - y.t || order.indexOf(x.voice) - order.indexOf(y.voice) || x.midi - y.midi || y.vel - x.vel);
  score.notes = notes;
  return song;
}

/** Cube frames (indices into `lambda`) behind a melody note, for lighting the spectral keyboard. */
export function songFrames(song: SkySong, lambda: readonly number[], value: readonly (number | null)[]): (n: SongNote) => number[] {
  const byBand = new Map<number, number[]>();
  lambda.forEach((um, f) => {
    if (value[f] === null || value[f] === undefined) return;
    const b = bandIndexFor(um);
    if (b < 0) return;
    const l = byBand.get(b);
    if (l) l.push(f); else byBand.set(b, [f]);
  });
  return (n) => song.bandsOf(n).flatMap((b) => byBand.get(b) ?? []);
}
