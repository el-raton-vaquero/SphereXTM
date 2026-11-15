// Unit tests for Star Match's music analysis (lib/match/musicAnalysis.ts) on synthetic songs.
// No test runner and no dependencies: Node >= 22.18 / 23.6 strips TypeScript types natively.
//   cd frontend && npm run test:match
import assert from 'node:assert/strict';
import { register } from 'node:module';

// lib/match/*.ts import each other without extensions (bundler resolution); teach Node to add '.ts'.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if ((spec.startsWith('./') || spec.startsWith('../')) && !/\.[cm]?[jt]s$/.test(spec) && /\\/lib\\/(match|symphony)\\//.test(ctx.parentURL ?? '')) {
    try { return await next(spec + '.ts', ctx); } catch { /* fall through */ }
  }
  return next(spec, ctx);
}`));
const M = await import('../lib/match/musicAnalysis.ts');

// ---------------------------------------------------------------- synthetic songs

const SR = 22050;

/** Deterministic noise. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Add a harmonic tone (MIDI note) with a plucked envelope. */
function tone(buf, t, dur, midi, amp, harmonics = 5) {
  const f = 440 * 2 ** ((midi - 69) / 12);
  const s0 = Math.floor(t * SR), n = Math.floor(dur * SR);
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const tt = i / SR;
    const env = Math.min(1, tt / 0.01) * Math.exp(-tt * 2.5) * Math.min(1, (n - i) / (0.02 * SR));
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += Math.sin(2 * Math.PI * f * h * tt) / h;
    buf[s0 + i] += amp * env * v;
  }
}

function kick(buf, t, amp = 0.8) {
  const s0 = Math.floor(t * SR), n = Math.floor(0.25 * SR);
  let ph = 0;
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const tt = i / SR, f = 50 + 90 * Math.exp(-tt * 30);
    ph += (2 * Math.PI * f) / SR;
    buf[s0 + i] += amp * Math.sin(ph) * Math.exp(-tt * 12);
  }
}

function noiseHit(buf, t, dur, amp, r) {
  const s0 = Math.floor(t * SR), n = Math.floor(dur * SR);
  let lp = 0;
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const w = r() * 2 - 1;
    lp = 0.3 * w + 0.7 * lp;
    buf[s0 + i] += amp * (w - lp) * Math.exp((-i / SR) * (3 / dur));
  }
}

/**
 * A loop: chords (root, quality) one per bar, block chord + bass root on every beat, optional
 * melody on chord tones, drums (kick 1+3, snare 2+4, hats 8ths). `lead` = silence before beat 1.
 */
function song({ bpm, chords, bars, lead = 0.3, drums = true, seed = 1 }) {
  const beat = 60 / bpm, len = lead + bars * 4 * beat + 1;
  const buf = new Float32Array(Math.ceil(len * SR));
  const r = rng(seed);
  for (let b = 0; b < bars; b++) {
    const [root, q] = chords[b % chords.length];
    const third = q === 'min' ? 3 : 4;
    for (let k = 0; k < 4; k++) {
      const t = lead + (b * 4 + k) * beat;
      for (const s of [0, third, 7]) tone(buf, t, beat * 0.95, 60 + ((root + s) % 12), 0.12);
      tone(buf, t, beat * 0.9, 36 + root, 0.25, 3);
      tone(buf, t + beat / 2, beat * 0.45, 72 + ((root + [0, third, 7, 12][(b + k) % 4]) % 12), 0.08, 3);
      if (drums) {
        if (k % 2 === 0) kick(buf, t); else noiseHit(buf, t, 0.15, 0.35, r);
        noiseHit(buf, t, 0.03, 0.06, r); noiseHit(buf, t + beat / 2, 0.03, 0.06, r);
      }
    }
  }
  let pk = 0;
  for (const v of buf) pk = Math.max(pk, Math.abs(v));
  for (let i = 0; i < buf.length; i++) buf[i] *= 0.9 / pk;
  return buf;
}

/** C-major arpeggio C E G C' in 8ths at 120 BPM (no drums). */
function arpeggio(bpm = 120, bars = 8, lead = 0.25) {
  const beat = 60 / bpm, buf = new Float32Array(Math.ceil((lead + bars * 4 * beat + 1) * SR));
  const seq = [60, 64, 67, 72, 67, 64, 60, 55];
  for (let i = 0; i < bars * 8; i++) tone(buf, lead + (i * beat) / 2, beat * 0.5, seq[i % 8], i % 2 ? 0.25 : 0.4);
  return buf;
}

// ---------------------------------------------------------------- tests

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const pcOf = (name) => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(name);
const near = (bpm, want, tol = 1) => Math.abs(bpm - want) <= tol;
/** Beat offset matches `lead` modulo the beat period (within `tol` s). */
const phaseOk = (off, lead, bpm, tol = 0.035) => { const p = 60 / bpm; const d = Math.abs(((off - lead) % p + p * 1.5) % p - p / 2); return d <= tol; };

test('chroma of a pure A4 peaks at A; of a C-major triad at C, E, G', () => {
  const a = new Float32Array(SR * 2);
  for (let i = 0; i < a.length; i++) a[i] = Math.sin((2 * Math.PI * 440 * i) / SR);
  const ca = M.chromagram(a, SR).mean;
  assert.equal(ca.indexOf(1), 9);
  const c = new Float32Array(SR * 2);
  tone(c, 0, 2, 60, 0.3, 1); tone(c, 0, 2, 64, 0.3, 1); tone(c, 0, 2, 67, 0.3, 1);
  const cc = M.chromagram(c, SR).mean;
  const top3 = cc.map((v, i) => [v, i]).sort((x, y) => y[0] - x[0]).slice(0, 3).map((x) => x[1]).sort((x, y) => x - y);
  assert.deepEqual(top3, [0, 4, 7]);
});

test('Krumhansl-Schmuckler on its own profiles returns the right key; relative keys', () => {
  assert.deepEqual([M.estimateKey(M.KK_MAJOR).tonic, M.estimateKey(M.KK_MAJOR).mode], [0, 'major']);
  const aMinor = Array.from({ length: 12 }, (_, pc) => M.KK_MINOR[(pc - 9 + 12) % 12]);
  const k = M.estimateKey(aMinor);
  assert.deepEqual([k.tonic, k.mode], [9, 'minor']);
  assert.ok(k.confidence > 0.3);
  assert.deepEqual(M.relativeKey(9, 'minor'), { tonic: 0, mode: 'major' });
  assert.deepEqual(M.relativeKey(2, 'major'), { tonic: 11, mode: 'minor' });
});

test('C-major arpeggio at 120 BPM: C major, 120 BPM, beat phase', () => {
  const lead = 0.25;
  const m = M.analyseMusic(arpeggio(120, 10, lead), SR);
  assert.deepEqual([m.tonic, m.mode], [0, 'major'], `key ${m.tonic} ${m.mode}`);
  assert.ok(near(m.bpm, 120), `bpm ${m.bpm}`);
  assert.ok(phaseOk(m.beatOffset, lead, m.bpm), `offset ${m.beatOffset}`);
});

test('A-minor i-VI-III-VII at 100 BPM with drums: A minor, 100 BPM, chords Am F C G on the bars', () => {
  const lead = 0.3;
  const prog = [[9, 'min'], [5, 'maj'], [0, 'maj'], [7, 'maj']];
  const m = M.analyseMusic(song({ bpm: 100, chords: prog, bars: 16, lead }), SR);
  assert.deepEqual([m.tonic, m.mode], [9, 'minor'], `key ${m.tonic} ${m.mode}`);
  assert.ok(near(m.bpm, 100), `bpm ${m.bpm}`);
  assert.ok(phaseOk(m.beatOffset, lead, m.bpm), `offset ${m.beatOffset}`);
  const bar = 2.4;
  // after the first bar, the chord at the middle of every bar is the one played
  let right = 0, total = 0;
  for (let b = 1; b < 15; b++) {
    const t = lead + b * bar + bar / 2;
    const c = m.chords.find((x) => t >= x.t && t < x.t + x.dur);
    const [root, q] = prog[b % 4];
    total++;
    if (c && c.root === root && c.quality === q) right++;
  }
  assert.ok(right / total >= 0.9, `chords right ${right}/${total}: ${JSON.stringify(m.chords.slice(0, 8))}`);
  for (const c of m.chords) assert.ok(M.keyChords(9, 'minor').some((k) => k.root === c.root && k.quality === c.quality));
});

test('D-major I-V-vi-IV at 128 BPM with drums: D major, 128 BPM', () => {
  const lead = 0.12;
  const prog = [[2, 'maj'], [9, 'maj'], [11, 'min'], [7, 'maj']];
  const m = M.analyseMusic(song({ bpm: 128, chords: prog, bars: 16, lead, seed: 7 }), SR);
  assert.deepEqual([m.tonic, m.mode], [2, 'major'], `key ${m.tonic} ${m.mode}`);
  assert.ok(near(m.bpm, 128), `bpm ${m.bpm}`);
  assert.ok(phaseOk(m.beatOffset, lead, m.bpm), `offset ${m.beatOffset}`);
  assert.ok(m.chords.length >= 8);
});

test('a slow 72 BPM ballad without drums is not doubled beyond 180 / halved below 60', () => {
  const m = M.analyseMusic(song({ bpm: 72, chords: [[4, 'min'], [0, 'maj'], [7, 'maj'], [2, 'maj']], bars: 8, drums: false }), SR);
  assert.ok(near(m.bpm, 72, 1.5) || near(m.bpm, 144, 3), `bpm ${m.bpm}`);
  assert.deepEqual([m.tonic, m.mode], [4, 'minor'], `key ${m.tonic} ${m.mode}`);
});

test('48 kHz input is decimated and gives the same answer', () => {
  const x = arpeggio(120, 8, 0.25);
  const up = new Float32Array(x.length * 2);
  for (let i = 0; i < up.length; i++) up[i] = x[i >> 1];
  const m = M.analyseMusic(up, SR * 2);
  assert.deepEqual([m.tonic, m.mode], [0, 'major']);
  assert.ok(near(m.bpm, 120), `bpm ${m.bpm}`);
});

test('silence throws "silent"', () => {
  assert.throws(() => M.analyseMusic(new Float32Array(SR * 3), SR), /silent/);
});

test('key chords and names', () => {
  assert.deepEqual(M.keyChords(0, 'major').map((c) => M.chordName(c, 'en', { tonic: 0, mode: 'major' })), ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'B°']);
  assert.deepEqual(M.keyChords(9, 'minor').map((c) => M.chordName(c, 'es', { tonic: 9, mode: 'minor' })), ['Lam', 'Si°', 'Do', 'Rem', 'Mim', 'Fa', 'Sol', 'Mi']);
  assert.equal(M.noteName(10, 'en', { tonic: 5, mode: 'major' }), 'B♭');
  assert.equal(M.noteName(6, 'es', { tonic: 2, mode: 'major' }), 'Fa♯');
  assert.equal(M.noteName(3, 'en', { tonic: 0, mode: 'minor' }), 'E♭');
  assert.equal(pcOf('A'), 9);
});

for (const [name, fn] of tests) {
  const t0 = performance.now();
  try {
    fn();
    passed++;
    console.log(`ok   ${name} (${Math.round(performance.now() - t0)} ms)`);
  } catch (e) {
    console.error(`FAIL ${name}\n     ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${tests.length} passed`);
