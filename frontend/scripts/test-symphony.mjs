// Unit tests for the star-symphony pure core (lib/symphony/core.ts).
// No test runner and no dependencies: Node >= 22.18 / 23.6 strips TypeScript types natively.
//   cd frontend && npm run test:symphony
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import * as core from '../lib/symphony/core.ts';

// lib/symphony/*.ts import each other without extensions (bundler resolution); teach Node to add '.ts'.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if ((spec.startsWith('./') || spec.startsWith('../')) && !/\.[cm]?[jt]s$/.test(spec) && ctx.parentURL?.includes('/lib/symphony/')) {
    try { return await next(spec + '.ts', ctx); } catch { /* fall through */ }
  }
  return next(spec, ctx);
}`));
const song = await import('../lib/symphony/export.ts');
const { composeSong, scoreToMidi, SONG_VOICES } = song;
const { crc32, makeZip } = await import('../lib/symphony/zip.ts');

const {
  BANDS, N_BANDS, bandIndexFor, binToBands, robustNormalize, finitePercentile, quantizeToScale, SCALES,
  pitchPosition, bandMidi, midiToHz, noteVelocity, noteDuration, stepLength, colourIndex, classifyColour,
  detectFeatures, analyseSpectrum, spectrumSeed, mulberry32, detectorPan, planckBands, encodeWav,
} = core;

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('102 bands, 17 per detector, ordered and contiguous inside each detector', () => {
  assert.equal(N_BANDS, 102);
  assert.equal(BANDS.length, 102);
  for (let i = 1; i < BANDS.length; i++) assert.ok(BANDS[i].center > BANDS[i - 1].center, `band ${i} not increasing`);
  for (let d = 1; d <= 6; d++) assert.equal(BANDS.filter((b) => b.detector === d).length, 17);
  assert.ok(Math.abs(BANDS[0].lo - 0.75) < 1e-9);
  assert.ok(Math.abs(BANDS[101].hi - 5.0) < 1e-9);
  for (let i = 0; i < BANDS.length; i++) if (i % 17) assert.ok(Math.abs(BANDS[i].lo - BANDS[i - 1].hi) < 1e-9);
});

test('bandIndexFor: inside, detector gaps go to the nearest band, out of range = -1', () => {
  assert.equal(bandIndexFor(0.76), 0);
  assert.equal(bandIndexFor(4.999), 101);
  assert.equal(bandIndexFor(BANDS[40].center), 40);
  const gap = bandIndexFor(1.095); // between D1 (..1.09) and D2 (1.10..)
  assert.ok(gap === 16 || gap === 17);
  assert.equal(bandIndexFor(0.3), -1);
  assert.equal(bandIndexFor(NaN), -1);
});

test('binToBands averages samples, ignores NaN, leaves empty bands NaN', () => {
  const c = BANDS[10].center;
  const out = binToBands([c, c, c, 9.9, BANDS[50].center], [1, 3, NaN, 7, 5]);
  assert.equal(out.length, 102);
  assert.equal(out[10], 2);
  assert.equal(out[50], 5);
  assert.ok(Number.isNaN(out[0]));
  assert.ok(Number.isNaN(out[101]));
});

test('robustNormalize clips to 0..1, keeps NaN, flat -> 0.5', () => {
  const v = Array.from({ length: 100 }, (_, i) => i);
  v.push(NaN, 1e6);
  const n = robustNormalize(v);
  assert.ok(Number.isNaN(n[100]));
  assert.equal(n[101], 1);
  assert.equal(n[0], 0);
  for (const x of n) if (Number.isFinite(x)) assert.ok(x >= 0 && x <= 1);
  const flat = robustNormalize([2, 2, 2, NaN]);
  assert.deepEqual([...flat].slice(0, 3), [0.5, 0.5, 0.5]);
  assert.ok(Number.isNaN(finitePercentile([NaN], 50)));
});

test('quantizeToScale snaps to pentatonic tones in any octave', () => {
  const maj = SCALES.majorPent;
  assert.equal(quantizeToScale(0, maj), 0);
  assert.equal(quantizeToScale(1, maj), 0);   // tie 0/2 goes down
  assert.equal(quantizeToScale(5.6, maj), 7);
  assert.equal(quantizeToScale(11, maj), 12);
  assert.equal(quantizeToScale(-1, maj), 0);
  assert.equal(quantizeToScale(-2, maj), -3);
  assert.equal(quantizeToScale(26, maj), 26);
  for (let s = -12; s <= 60; s += 0.25) {
    const q = quantizeToScale(s, SCALES.minorPent);
    assert.ok(SCALES.minorPent.includes(((q % 12) + 12) % 12), `${s} -> ${q} not in scale`);
    assert.ok(Math.abs(q - s) <= 1.5 + 1e-9);
  }
});

test('shorter wavelength = higher pitch; span ~4 octaves; monotonic non-decreasing', () => {
  assert.equal(pitchPosition(5.0), 0);
  assert.equal(pitchPosition(0.75), 1);
  const base = 50;
  let prev = Infinity;
  for (let i = 0; i < 102; i++) {
    const m = bandMidi(i, base, SCALES.majorPent);
    assert.ok(m <= prev, `band ${i} pitch went up with wavelength`);
    prev = m;
  }
  const span = bandMidi(0, base, SCALES.majorPent) - bandMidi(101, base, SCALES.majorPent);
  assert.ok(span >= 44 && span <= 50, `span ${span}`);
  assert.ok(Math.abs(midiToHz(69) - 440) < 1e-9);
  assert.ok(Math.abs(midiToHz(81) - 880) < 1e-9);
});

test('velocity, duration and step grow with brightness; silent for empty', () => {
  assert.equal(noteVelocity(NaN), 0);
  assert.equal(noteVelocity(0), 0);
  assert.ok(noteVelocity(0.2) < noteVelocity(0.8));
  assert.ok(noteVelocity(1) <= 1);
  assert.equal(noteDuration(NaN), 0);
  assert.ok(noteDuration(0.9) > noteDuration(0.3));
  assert.ok(stepLength(1) > stepLength(0));
});

test('colour index: blue spectrum > 0, red spectrum < 0, hysteresis holds', () => {
  const blue = BANDS.map((b) => 1 / b.center);
  const red = BANDS.map((b) => b.center);
  assert.ok(colourIndex(robustNormalize(blue)) > 0.3);
  assert.ok(colourIndex(robustNormalize(red)) < -0.3);
  assert.equal(classifyColour(0.5), 'blue');
  assert.equal(classifyColour(-0.5), 'red');
  assert.equal(classifyColour(0), 'neutral');
  assert.equal(classifyColour(0.13, 'blue'), 'blue');
  assert.equal(classifyColour(0.13), 'neutral');
});

function withDip(center, halfWidth, depth) {
  return BANDS.map((b) => (Math.abs(b.center - center) <= halfWidth ? 1 - depth : 1));
}

test('feature detection: water-ice dip at 3.05 um is detected, flat is not', () => {
  const flat = detectFeatures(BANDS.map(() => 1));
  assert.ok(flat.every((f) => !f.detected));
  const ice = detectFeatures(withDip(3.05, 0.15, 0.4));
  const h2o = ice.find((f) => f.id === 'h2o');
  assert.ok(h2o.detected, `h2o depth ${h2o.depth}`);
  assert.ok(Math.abs(h2o.depth - 0.4) < 0.05);
  assert.ok(h2o.strength > 0 && h2o.strength <= 1);
  assert.ok(h2o.bands.length > 0);
});

test('feature detection: CO2 4.27 and CO 4.67 dips; PAH emission at 3.3', () => {
  const co2 = detectFeatures(withDip(4.27, 0.05, 0.3)).find((f) => f.id === 'co2');
  assert.ok(co2.detected, `co2 ${co2.depth}`);
  const co = detectFeatures(withDip(4.67, 0.07, 0.3)).find((f) => f.id === 'co');
  assert.ok(co.detected, `co ${co.depth}`);
  const emis = detectFeatures(withDip(3.3, 0.07, -0.5));
  assert.ok(emis.find((f) => f.id === 'pah').detected);
  assert.ok(!emis.find((f) => f.id === 'ch4').detected);
  const abs = detectFeatures(withDip(3.3, 0.07, 0.4));
  assert.ok(abs.find((f) => f.id === 'ch4').detected);
});

test('feature detection is NaN-safe: empty windows are not detected', () => {
  const v = withDip(3.05, 0.15, 0.5).map((x, i) => (BANDS[i].center > 2.4 && BANDS[i].center < 3.9 ? NaN : x));
  const h2o = detectFeatures(v).find((f) => f.id === 'h2o');
  assert.ok(!h2o.detected);
  assert.ok(Number.isNaN(h2o.depth));
  // Non-positive continuum (background-subtracted blank sky) never "detects".
  assert.ok(detectFeatures(BANDS.map(() => -1)).every((f) => !f.detected));
});

test('analyseSpectrum + seed: deterministic, different spectra -> different seeds', () => {
  const a = analyseSpectrum(BANDS.map((b) => Math.sin(b.center * 3) + 2));
  const b = analyseSpectrum(BANDS.map((b) => Math.sin(b.center * 3) + 2));
  const c = analyseSpectrum(BANDS.map((b) => Math.cos(b.center * 5) + 2));
  assert.equal(a.seed, b.seed);
  assert.notEqual(a.seed, c.seed);
  assert.equal(a.valid, 102);
  assert.equal(a.peaks.length, 102);
  assert.ok(a.peaks.some(Boolean));
  assert.equal(spectrumSeed([NaN]), spectrumSeed([NaN]));
  const r1 = mulberry32(7), r2 = mulberry32(7);
  for (let i = 0; i < 5; i++) { const x = r1(); assert.equal(x, r2()); assert.ok(x >= 0 && x < 1); }
});

test('detector pan spreads D1..D6 left to right', () => {
  assert.equal(detectorPan(1), -0.7);
  assert.equal(detectorPan(6), 0.7);
  assert.ok(detectorPan(3) < detectorPan(4));
});

test('planckBands: hot star is blue, cool star is red', () => {
  const hot = planckBands(10000);
  const cool = planckBands(1000);
  assert.equal(hot.lambda_um.length, 102);
  assert.ok(colourIndex(robustNormalize(hot.intensity)) > 0.3);
  assert.ok(colourIndex(robustNormalize(cool.intensity)) < 0);
  assert.ok(Math.max(...hot.intensity) <= 1 + 1e-12);
});

test('encodeWav writes a valid 16-bit stereo header', () => {
  const buf = encodeWav([new Float32Array([0, 1, -1]), new Float32Array([0.5, 2, -2])], 48000);
  const v = new DataView(buf);
  const s = (o, n) => String.fromCharCode(...new Uint8Array(buf, o, n));
  assert.equal(s(0, 4), 'RIFF');
  assert.equal(s(8, 4), 'WAVE');
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), 48000);
  assert.equal(v.getUint32(40, true), 12);
  assert.equal(v.getInt16(44 + 4 * 1, true), 32767); // clipped
  assert.equal(v.getInt16(44 + 4 * 2 + 2, true), -32768);
});

test('real snapshot (WISE 0855) bins into many bands', () => {
  const path = fileURLToPath(new URL('../public/snapshots/wise-0855.json', import.meta.url));
  const snap = JSON.parse(readFileSync(path, 'utf8'));
  const frames = snap.search.frames;
  const out = binToBands(frames.map((f) => f.lambda_um), frames.map(() => 1));
  const filled = [...out].filter(Number.isFinite).length;
  assert.ok(filled >= 60, `only ${filled} bands filled`);
});

// ---------------------------------------------------------------- export.ts (fixed piece)

/** A spectrum with an H2O-ice dip, sampled at the band centres, with a few nulls. */
function icySpectrum() {
  const lambda_um = BANDS.map((b) => b.center);
  const intensity = BANDS.map((b, i) => {
    if (i === 5 || i === 60) return null;
    const cont = 2 - 0.25 * b.center + 0.05 * Math.sin(b.center * 9);
    return Math.abs(b.center - 3.05) <= 0.15 ? cont * 0.6 : cont;
  });
  return { lambda_um, intensity, label: 'test' };
}

test('composeSong is deterministic and seed-sensitive', () => {
  const a = composeSong(icySpectrum());
  const b = composeSong(icySpectrum());
  assert.deepEqual(a, b);
  assert.equal(a.seconds, 45);
  assert.ok(a.notes.length > 40, `only ${a.notes.length} notes`);
  const c = composeSong({ ...icySpectrum(), seed: 'other' });
  assert.notDeepEqual(a.notes, c.notes);
  assert.ok(a.bpm >= 60 && a.bpm <= 140);
  assert.match(a.key, /pentatonic/);
});

test('composeSong: form, ranges, ice voice and every voice present', () => {
  const s = composeSong(icySpectrum(), 45);
  assert.ok(s.features.includes('h2o'), `features ${s.features}`);
  for (const v of SONG_VOICES) assert.ok(s.notes.some((n) => n.voice === v), `no ${v} notes`);
  for (const n of s.notes) {
    assert.ok(n.t >= 0 && n.t < 45 && n.t + n.dur <= 45 + 1e-6, `note out of range ${JSON.stringify(n)}`);
    assert.ok(n.vel > 0 && n.vel <= 1 && n.pan >= -1 && n.pan <= 1);
    assert.ok(Number.isInteger(n.midi) && n.midi >= 0 && n.midi <= 127);
  }
  for (let i = 1; i < s.notes.length; i++) assert.ok(s.notes[i].t >= s.notes[i - 1].t, 'notes not sorted');
  // Climax (46-78%) is louder than the intro, the fade-out quieter than the climax.
  const mean = (a, b) => { const l = s.notes.filter((n) => n.voice === 'lead' && n.t >= a && n.t < b); return l.reduce((x, n) => x + n.vel, 0) / l.length; };
  assert.ok(mean(0.46 * 45, 0.78 * 45) > mean(0.14 * 45, 0.46 * 45) * 0.95);
  assert.ok(mean(0.85 * 45, 45) < mean(0.46 * 45, 0.78 * 45));
  // Longer pieces stretch.
  const long = composeSong(icySpectrum(), 90);
  assert.ok(Math.max(...long.notes.map((n) => n.t)) > 60);
});

test('composeSong: null bands are silent', () => {
  const lambda_um = BANDS.map((b) => b.center);
  const none = composeSong({ lambda_um, intensity: lambda_um.map(() => null) });
  assert.equal(none.notes.length, 0);
  // Only detector 6 (4.42-5.0 um, lowest pitches) measured: no melody note may come from D1-D5.
  const d6 = composeSong({ lambda_um, intensity: BANDS.map((b) => (b.detector === 6 ? 1 + Math.sin(b.center * 9) : null)) });
  const melody = d6.notes.filter((n) => n.voice === 'lead' || n.voice === 'ice');
  assert.ok(melody.length > 0);
  // Highest note a D6 band can make in this key, plus the octave "sparkle" on peaks.
  const key = Object.values(core.KEYS).find((k) => d6.key.startsWith(k.name + ' '));
  const keyRoot = key.root;
  const sc = SCALES[key.scale];
  const top = Math.max(...BANDS.filter((b) => b.detector === 6).map((b) => bandMidi(b.index, keyRoot + 12, sc)));
  for (const n of melody) assert.ok(n.midi <= top + 12, `note ${n.midi} above D6 range (${top})`);
});

// ---------------------------------------------------------------- composeSong play-along options

test('composeSong without options (or with an empty object) is the unchanged default piece', () => {
  const a = composeSong(icySpectrum(), 45);
  assert.deepEqual(composeSong(icySpectrum(), 45, undefined), a);
  assert.deepEqual(composeSong(icySpectrum(), 45, {}), a);
  assert.deepEqual(composeSong(icySpectrum(), 45, { bpm: undefined }), a);
});

/** A minor i-VI-III-VII, one chord per bar at 100 BPM, first beat at 0.3 s. */
const AM = { tonic: 9, mode: 'minor', bpm: 100, beatOffset: 0.3, chords: [
  { t: 0, dur: 2.7, root: 9, quality: 'min' }, { t: 2.7, dur: 2.4, root: 5, quality: 'maj' },
  { t: 5.1, dur: 2.4, root: 0, quality: 'maj' }, { t: 7.5, dur: 2.4, root: 7, quality: 'maj' },
] };
const pc = (m) => ((m % 12) + 12) % 12;
function chordAtT(chords, t) {
  const span = chords[chords.length - 1].t + chords[chords.length - 1].dur - chords[0].t;
  let tt = t;
  while (tt >= chords[0].t + span) tt -= span;
  let c = chords[0];
  for (const x of chords) if (x.t <= tt + 1e-6) c = x;
  return c;
}

for (const accompaniment of [false, true]) {
  test(`composeSong play-along (${accompaniment ? 'accompaniment' : 'stand-alone'}): in key, on the grid, chords followed`, () => {
    const s = composeSong(icySpectrum(), 30, { ...AM, accompaniment });
    assert.deepEqual(composeSong(icySpectrum(), 30, { ...AM, accompaniment }), s, 'not deterministic');
    assert.equal(s.seconds, 30);
    assert.equal(s.bpm, 100);
    assert.match(s.key, /^A minor/);
    const scale = new Set(song.alongScale('minor', 'diatonic').map((x) => pc(9 + x)));
    const six = 60 / 100 / 4;
    const melody = s.notes.filter((n) => n.voice === 'lead' || n.voice === 'ice');
    assert.ok(melody.length > 30, `only ${melody.length} melody notes`);
    let onBeat = 0;
    for (const n of melody) {
      assert.ok(scale.has(pc(n.midi)), `out of scale ${JSON.stringify(n)}`);
      const k = (n.t - 0.3) / six;
      assert.ok(Math.abs(k - Math.round(k)) < 0.002, `off the 16th grid ${JSON.stringify(n)}`);
      if (accompaniment) assert.ok(Math.round(k) % 2 === 0, `accompaniment uses 8ths ${JSON.stringify(n)}`);
      const units = n.dur / six;
      if (n.t + n.dur < 29.9) assert.ok(Math.abs(units - Math.round(units)) < 0.01 || n.voice === 'lead', `duration not whole 16ths ${JSON.stringify(n)}`);
      if (Math.round(k) % 4 === 0 && n.vel > 0.1) {
        const c = chordAtT(AM.chords, n.t);
        if (song.songChordPcs(c).includes(pc(n.midi))) onBeat++;
        else assert.ok(!song.songChordPcs(c).some((p) => scale.has(p) && Math.min(pc(p - n.midi), pc(n.midi - p)) <= 4), `on-beat note not a chord tone ${JSON.stringify(n)} over ${JSON.stringify(c)}`);
      }
    }
    assert.ok(onBeat > 5);
    // pad follows the progression (incl. after it loops), bass on the roots
    const pads = s.notes.filter((n) => n.voice === 'pad');
    const bass = s.notes.filter((n) => n.voice === 'bass');
    assert.ok(pads.length >= 3 * 10 && bass.length >= 10);
    for (const n of pads) assert.ok(song.songChordPcs(chordAtT(AM.chords, n.t + 0.01)).includes(pc(n.midi)), `pad ${JSON.stringify(n)}`);
    for (const n of bass) assert.equal(pc(n.midi), chordAtT(AM.chords, n.t + 0.01).root, `bass ${JSON.stringify(n)}`);
    assert.ok(pads.some((n) => n.t > 20 && pc(n.midi) === 5), 'progression did not loop');
    for (const n of s.notes) assert.ok(n.t >= 0 && n.t < 30 && n.t + n.dur <= 30 + 1e-6 && n.vel > 0 && n.vel <= 1);
    if (accompaniment) {
      const full = composeSong(icySpectrum(), 30, { ...AM });
      const mean = (sc, v) => { const l = sc.notes.filter((n) => n.voice === v); return l.reduce((x, n) => x + n.vel, 0) / l.length; };
      assert.ok(mean(s, 'pad') < mean(full, 'pad') && mean(s, 'bass') < mean(full, 'bass'), 'accompaniment should be softer');
      assert.ok(Math.min(...bass.map((n) => n.midi)) >= 48, 'no low bass in accompaniment');
      const med = (l) => l.map((n) => n.midi).sort((x, y) => x - y)[l.length >> 1];
      assert.ok(med(melody) >= med(full.notes.filter((n) => n.voice === 'lead')) + 6, 'accompaniment melody is higher');
    }
  });
}

test('composeSong play-along: pentatonic scale, default progression, ice voice and null bands', () => {
  const s = composeSong(icySpectrum(), 20, { tonic: 2, mode: 'major', scale: 'pentatonic', bpm: 128, beatOffset: -0.1 });
  const scale = new Set([0, 2, 4, 7, 9].map((x) => pc(2 + x)));
  for (const n of s.notes) if (n.voice === 'lead' || n.voice === 'ice') assert.ok(scale.has(pc(n.midi)), `out of D major pentatonic ${JSON.stringify(n)}`);
  assert.ok(s.notes.some((n) => n.voice === 'ice'), 'h2o band lost its ice voice');
  // default progression D Bm G A
  const roots = [...new Set(s.notes.filter((n) => n.voice === 'bass').map((n) => pc(n.midi)))];
  assert.deepEqual(roots.slice(0, 4), [2, 11, 7, 9]);
  const lambda_um = BANDS.map((b) => b.center);
  assert.equal(composeSong({ lambda_um, intensity: lambda_um.map(() => null) }, 20, { bpm: 120 }).notes.length, 0);
  const d6 = composeSong({ lambda_um, intensity: BANDS.map((b) => (b.detector === 6 ? 1 + Math.sin(b.center * 9) : null)) }, 30, { ...AM, accompaniment: true });
  const mel = d6.notes.filter((n) => n.voice === 'lead' || n.voice === 'ice');
  assert.ok(mel.length > 0);
  for (const n of mel) assert.ok(n.midi <= 60 + 9 + 12, `D6-only melody too high ${n.midi}`); // longest wavelengths = lowest notes
  assert.ok(scoreToMidi(s).length > 100);
});

/** Walk a Standard MIDI File and return its chunk/event structure. */
function parseMidi(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  assert.equal(id(0), 'MThd');
  assert.equal(v.getUint32(4), 6);
  const header = { format: v.getUint16(8), ntracks: v.getUint16(10), division: v.getUint16(12) };
  let o = 14;
  const tracks = [];
  while (o < bytes.length) {
    assert.equal(id(o), 'MTrk', `chunk at ${o}`);
    const len = v.getUint32(o + 4);
    const end = o + 8 + len;
    assert.ok(end <= bytes.length, 'chunk overruns file');
    let p = o + 8;
    const vlq = () => { let n = 0, b; do { b = bytes[p++]; n = (n << 7) | (b & 0x7f); } while (b & 0x80); return n; };
    const tr = { name: '', tempo: 0, program: -1, on: 0, off: 0, cc10: 0, eot: false, ticks: 0 };
    while (p < end) {
      tr.ticks += vlq();
      const st = bytes[p++];
      assert.ok(st & 0x80, 'running status not expected');
      if (st === 0xff) {
        const type = bytes[p++]; const l = vlq();
        if (type === 0x03) tr.name = String.fromCharCode(...bytes.subarray(p, p + l));
        if (type === 0x51) tr.tempo = (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2];
        if (type === 0x2f) { tr.eot = true; assert.equal(p + l, end, 'end-of-track is not last'); }
        p += l;
      } else if ((st & 0xf0) === 0xc0) tr.program = bytes[p++];
      else if ((st & 0xf0) === 0x90) { if (bytes[p + 1] > 0) tr.on++; p += 2; }
      else if ((st & 0xf0) === 0x80) { tr.off++; p += 2; }
      else if ((st & 0xf0) === 0xb0) { if (bytes[p] === 10) tr.cc10++; p += 2; }
      else assert.fail(`unexpected status ${st.toString(16)}`);
    }
    assert.equal(p, end);
    assert.ok(tr.eot, 'track without end-of-track');
    tracks.push(tr);
    o = end;
  }
  return { header, tracks };
}

test('scoreToMidi writes a valid type-1 SMF: header, tempo, one named track per voice', () => {
  const s = composeSong(icySpectrum());
  const midi = scoreToMidi(s);
  assert.ok(midi instanceof Uint8Array);
  const { header, tracks } = parseMidi(midi);
  assert.equal(header.format, 1);
  assert.equal(header.division, 480);
  assert.equal(header.ntracks, 1 + SONG_VOICES.length);
  assert.equal(tracks.length, header.ntracks);
  assert.equal(tracks[0].tempo, Math.round(60e6 / s.bpm));
  assert.match(tracks[0].name, /StarChord/);
  SONG_VOICES.forEach((voice, k) => {
    const tr = tracks[k + 1];
    const n = s.notes.filter((x) => x.voice === voice).length;
    assert.ok(tr.name.toLowerCase().startsWith(voice), `track ${k + 1} name ${tr.name}`);
    assert.ok(tr.program >= 0 && tr.program < 128);
    assert.equal(tr.on, n, `${voice} note-ons`);
    assert.equal(tr.off, n, `${voice} note-offs`);
    if (n) assert.ok(tr.cc10 >= 1, `${voice} has no pan`);
  });
  // Silent score still produces a valid file.
  const empty = parseMidi(scoreToMidi(composeSong({ lambda_um: [1, 2], intensity: [null, null] })));
  assert.equal(empty.tracks.length, 5);
});

test('makeZip: CRC-32 check value and a well-formed STORE archive', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const a = new Uint8Array([1, 2, 3]), b = new Uint8Array(1000).fill(7);
  const z = makeZip([{ name: 'a.wav', data: a }, { name: 'b.mid', data: b }]);
  const v = new DataView(z.buffer);
  assert.equal(v.getUint32(0, true), 0x04034b50);
  const eocd = z.length - 22;
  assert.equal(v.getUint32(eocd, true), 0x06054b50);
  assert.equal(v.getUint16(eocd + 10, true), 2);
  const cdOff = v.getUint32(eocd + 16, true);
  assert.equal(cdOff + v.getUint32(eocd + 12, true), eocd);
  assert.equal(v.getUint32(cdOff, true), 0x02014b50);
  // Second entry's local header sits where the central directory says.
  const cd2 = cdOff + 46 + 5;
  assert.equal(v.getUint32(v.getUint32(cd2 + 42, true), true), 0x04034b50);
  assert.equal(v.getUint32(cd2 + 20, true), 1000);
});

for (const [name, fn] of tests) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n     ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${tests.length} passed`);
