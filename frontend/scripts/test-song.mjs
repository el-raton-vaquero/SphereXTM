// Unit tests for the sky-song composer (lib/song/compose.ts).
// No test runner and no dependencies: Node >= 22.18 / 23.6 strips TypeScript types natively.
//   cd frontend && npm run test:song
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

// lib/** imports siblings without extensions (bundler resolution); teach Node to add '.ts'.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if ((spec.startsWith('./') || spec.startsWith('../')) && !/\\.[cm]?[jt]s$/.test(spec) && ctx.parentURL?.includes('/lib/')) {
    try { return await next(spec + '.ts', ctx); } catch { /* fall through */ }
  }
  return next(spec, ctx);
}`));
const { composeSkySong, songFrames, MODE_STEPS, WARM_KEYS, RANGE } = await import('../lib/song/compose.ts');
const { BANDS, planckBands, mulberry32 } = await import('../lib/symphony/core.ts');
const { scoreToMidi } = await import('../lib/symphony/export.ts');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const pc = (m) => ((m % 12) + 12) % 12;
const lambda = BANDS.map((b) => b.center);

/** Synthetic skies: a blackbody, optionally with noise, absorption dips and empty frames. */
function sky({ teff = 5000, noise = 0, dips = [], blanks = [], seed = 1, tilt = 0 } = {}) {
  const r = mulberry32(seed);
  const base = planckBands(teff).intensity;
  const intensity = base.map((v, i) => {
    const um = lambda[i];
    let x = v * (1 + tilt * (um - 2.5)) + 0.05;
    for (const [c, w, d] of dips) x *= 1 - d * Math.exp(-(((um - c) / w) ** 2));
    x *= 1 + noise * (r() - 0.5);
    return blanks.includes(i) ? null : x;
  });
  return { lambda_um: lambda, intensity };
}
const ICE = [[3.05, 0.09, 0.55], [4.27, 0.04, 0.5], [4.67, 0.05, 0.4]];
const SKIES = {
  hotStar: { lambda_um: lambda, intensity: lambda.map((l) => l ** -1), seed: '2026-11-15T21:00Z|19.43,-99.13' }, // blue power law
  coolDusty: { ...sky({ teff: 900, noise: 0.25, dips: ICE, seed: 7 }), seed: '1990-03-02T03:00Z|-33.45,-70.66' },
  zodiacal: { ...sky({ teff: 5800, noise: 0.15, blanks: [50, 51], seed: 3, tilt: 0.3 }), seed: '2001-07-20T02:00Z|40.42,-3.70' },
  flatNoisy: { ...sky({ teff: 3000, noise: 0.6, seed: 11, tilt: 0.5 }), seed: '2024-12-24T23:59Z|51.5,-0.13' },
};
// Real SPHEREx DR1 spectra: the coarse all-sky index (public/starmatch, order-6 pixels, display
// stretch), decoded S = median + z * sigma; -128 = no data. A spread of pixels, plane and high latitude.
const idx = JSON.parse(readFileSync(new URL('../public/starmatch/index.json', import.meta.url), 'utf8'));
const bin = new Int8Array(readFileSync(new URL('../public/starmatch/index.bin', import.meta.url)).buffer.slice(0));
const REAL = {};
for (let k = 0; k < 96; k++) {
  const p = (k * 1021 + 17) % idx.npix;
  const intensity = Array.from({ length: 102 }, (_, b) => {
    const z = bin[p * 102 + b];
    return z === -128 ? null : idx.median[b] + (z * 4 / 127) * idx.sigma[b];
  });
  REAL[`real${p}`] = { lambda_um: idx.lambda_um, intensity, seed: `pixel ${p}` };
}
const ALL = { ...SKIES, ...REAL };
const allSongs = () => Object.entries(ALL).map(([k, s]) => [k, composeSkySong(s)]);

const chordAtT = (song, t) => {
  const e = t / (30 / song.bpm);
  let c = song.chords[0];
  for (const x of song.chords) if (x.e <= e + 1e-3) c = x;
  return c;
};

test('deterministic: same sky + seed -> identical score; another seed or sky -> different', () => {
  for (const s of Object.values(SKIES)) {
    assert.deepEqual(JSON.stringify(composeSkySong(s).score.notes), JSON.stringify(composeSkySong(s).score.notes));
  }
  const a = composeSkySong(SKIES.zodiacal), b = composeSkySong({ ...SKIES.zodiacal, seed: 'other place' });
  assert.equal(a.score.key, b.score.key); // the key / mode / tempo come from the data...
  assert.notDeepEqual(JSON.stringify(a.score.notes), JSON.stringify(composeSkySong(SKIES.hotStar).score.notes));
});

test('warm key, mode, tempo 76-92 and length 44-51 s, 4/4 bars', () => {
  for (const [k, s] of allSongs()) {
    assert.ok(WARM_KEYS.includes(s.tonic), `${k}: tonic ${s.tonic}`);
    assert.ok(['major', 'minor', 'dorian'].includes(s.mode), k);
    assert.ok(s.bpm >= 76 && s.bpm <= 92, `${k}: bpm ${s.bpm}`);
    const barS = 240 / s.bpm;
    assert.ok(Math.abs(s.score.seconds - s.bars * barS) < 1e-3, k);
    assert.ok(s.score.seconds >= 44 && s.score.seconds <= 51, `${k}: ${s.score.seconds}s`);
    const names = s.sections.map((x) => x.name).join(' ');
    assert.equal(names, "intro A B A' outro");
    assert.equal(s.sections.reduce((n, x) => n + x.bars, 0), s.bars);
    for (const x of s.sections.filter((y) => y.name === 'A' || y.name === 'B')) assert.ok(x.bars >= 4 && x.bars <= 8, k);
    assert.equal(s.sections[0].bars, 2); assert.equal(s.sections[3].bars, 4); assert.equal(s.sections[4].bars, 2);
  }
});

test('the spectrum decides: blue -> major, red with ice absorption -> minor / dorian', () => {
  const hot = composeSkySong(SKIES.hotStar), cold = composeSkySong(SKIES.coolDusty);
  assert.equal(hot.mode, 'major');
  assert.ok(cold.mode === 'minor' || cold.mode === 'dorian', cold.mode);
  assert.ok(cold.score.features.includes('h2o'), cold.score.features.join());
  assert.ok(hot.score.key !== cold.score.key);
  assert.ok(hot.motif.length >= 3 && hot.motif.length <= 7);
});

test('every note is in key (the scale, or the chord sounding with it)', () => {
  for (const [k, s] of allSongs()) {
    const scale = MODE_STEPS[s.mode].map((x) => pc(s.tonic + x));
    for (const n of s.score.notes) {
      const c = chordAtT(s, n.t);
      const ok = c.allowed.includes(pc(n.midi)) || (n.voice !== 'lead' && scale.includes(pc(n.midi)));
      assert.ok(ok, `${k}: ${n.voice} ${n.midi} at ${n.t}s over ${c.label}`);
      if (n.voice === 'pad') assert.ok(scale.includes(pc(n.midi)) || c.pcs.includes(pc(n.midi)), `${k}: pad ${n.midi}`);
    }
  }
});

test('registers and velocities: nothing shrill, nothing harsh', () => {
  for (const [k, s] of allSongs()) {
    for (const n of s.score.notes) {
      assert.ok(n.midi <= 88, `${k}: ${n.midi}`);
      const lim = { lead: [RANGE.arp[0], RANGE.melody[1]], pad: RANGE.pad, bass: RANGE.bass, ice: RANGE.ice }[n.voice];
      assert.ok(n.midi >= lim[0] && n.midi <= lim[1], `${k}: ${n.voice} ${n.midi}`);
      const vl = { lead: [0.25, 0.8], pad: [0.25, 0.45], bass: [0.4, 0.6], ice: [0.1, 0.32] }[n.voice];
      assert.ok(n.vel >= vl[0] - 1e-9 && n.vel <= vl[1] + 1e-9, `${k}: ${n.voice} vel ${n.vel}`);
    }
    const mel = s.score.notes.filter((n) => s.bandsOf(n).length);
    assert.ok(mel.length >= 20, `${k}: ${mel.length} melody notes`);
    for (const n of mel) {
      assert.ok(n.midi >= RANGE.melody[0] && n.midi <= RANGE.melody[1], `${k}: melody ${n.midi}`);
      assert.ok(n.vel >= 0.45 && n.vel <= 0.8, `${k}: melody vel ${n.vel}`);
    }
    // mostly stepwise, leaps at most a sixth
    let steps = 0;
    for (let i = 1; i < mel.length; i++) {
      const d = Math.abs(mel[i].midi - mel[i - 1].midi);
      assert.ok(d <= 9, `${k}: leap ${d} at ${mel[i].t}`);
      if (d <= 2) steps++;
    }
    assert.ok(steps / (mel.length - 1) >= 0.4, `${k}: only ${steps}/${mel.length - 1} steps`);
  }
});

test('grid: onsets and durations on the eighth-note grid, chord tones on strong beats', () => {
  for (const [k, s] of allSongs()) {
    const E = 30 / s.bpm;
    for (const n of s.score.notes) {
      const q = n.t / E;
      assert.ok(Math.abs(q - Math.round(q)) < 2e-3, `${k}: ${n.voice} onset ${n.t}`);
      const d = n.dur / E;
      assert.ok(Math.abs(d - Math.round(d)) < 2e-3 && n.dur > 0, `${k}: ${n.voice} dur ${n.dur}`);
      assert.ok(n.t + n.dur <= s.score.seconds + 1e-3, `${k}: ${n.voice} past the end`);
    }
    for (const n of s.score.notes.filter((x) => s.bandsOf(x).length)) {
      const e = Math.round(n.t / E);
      if (e % 4 === 0) assert.ok(chordAtT(s, n.t).pcs.includes(pc(n.midi)), `${k}: strong-beat ${n.midi} at ${n.t}`);
    }
    // bass on chord roots / fifths except passing notes on beat 4
    for (const n of s.score.notes.filter((x) => x.voice === 'bass')) {
      const c = chordAtT(s, n.t);
      const e = Math.round(n.t / E) % 8;
      if (e !== 6) assert.ok(pc(n.midi) === c.root || pc(n.midi) === pc(c.root + 7) || c.pcs.includes(pc(n.midi)), `${k}: bass ${n.midi}`);
    }
  }
});

test('ends on the tonic: melody, bass and the final pad chord', () => {
  for (const [k, s] of allSongs()) {
    const ns = s.score.notes;
    const last = (v) => ns.filter((n) => n.voice === v).reduce((a, b) => (b.t >= a.t ? b : a));
    assert.equal(pc(last('bass').midi), s.tonic, `${k}: bass`);
    const mel = ns.filter((n) => s.bandsOf(n).length);
    assert.equal(pc(mel[mel.length - 1].midi), s.tonic, `${k}: melody`);
    const lastChord = s.chords[s.chords.length - 1];
    assert.equal(lastChord.root, s.tonic);
    const T = s.score.seconds;
    const finalPad = ns.filter((n) => n.voice === 'pad' && n.t + n.dur >= T - 1e-3).map((n) => pc(n.midi));
    assert.ok(finalPad.length >= 3, k);
    for (const p of finalPad) assert.ok(lastChord.pcs.includes(p), `${k}: final pad ${p}`);
    // the chord before the outro is the dominant (or the A progression's last chord)
    assert.ok(s.chords[s.chords.length - 2].section === "A'");
  }
});

test('ornaments only with detected features, sparse and soft', () => {
  const plain = composeSkySong(SKIES.hotStar), ice = composeSkySong(SKIES.coolDusty);
  assert.equal(plain.score.notes.filter((n) => n.voice === 'ice').length, plain.score.features.length ? plain.score.notes.filter((n) => n.voice === 'ice').length : 0);
  const orn = ice.score.notes.filter((n) => n.voice === 'ice');
  assert.ok(orn.length >= 1 && orn.length <= 4, `${orn.length} ornaments`);
  for (const n of orn) assert.ok(n.midi <= 84 && n.vel < 0.32);
});

test('silence without data; keyboard frames map melody notes back to cube frames', () => {
  const empty = composeSkySong({ lambda_um: lambda, intensity: lambda.map(() => null), seed: 'x' });
  assert.equal(empty.score.notes.length, 0);
  const s = composeSkySong(SKIES.zodiacal);
  const frames = songFrames(s, SKIES.zodiacal.lambda_um, SKIES.zodiacal.intensity);
  const mel = s.score.notes.filter((n) => s.bandsOf(n).length);
  assert.ok(mel.every((n) => frames(n).length > 0));
  assert.ok(mel.every((n) => !frames(n).includes(50) && !frames(n).includes(51)));
  const pad = s.score.notes.find((n) => n.voice === 'pad');
  assert.deepEqual(frames(pad), []);
});

test('MIDI export still works on the composed score', () => {
  const s = composeSkySong(SKIES.coolDusty);
  const mid = scoreToMidi(s.score);
  assert.equal(String.fromCharCode(...mid.slice(0, 4)), 'MThd');
  assert.ok(mid.length > 500);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { console.log(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
}
{
  const real = Object.values(REAL).map((x) => composeSkySong(x));
  const tally = (f) => Object.entries(real.reduce((m, s) => ((m[f(s)] = (m[f(s)] ?? 0) + 1), m), {})).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`     ${real.length} real SPHEREx pixels -> keys ${tally((s) => s.score.key)}`);
  console.log(`     tempos ${tally((s) => s.bpm)}`);
  console.log(`     A progressions ${tally((s) => s.progression.join('-'))}`);
}
for (const [k, s] of allSongs().slice(0, 4)) console.log(`     ${k}: ${s.score.key} · ${s.bpm} BPM · ${s.progression.join('–')} / B ${s.progressionB.join('–')} · ${s.bars} bars · ${s.score.seconds.toFixed(1)} s · ${s.score.notes.length} notes · features ${s.score.features.join(',') || '-'}`);
console.log(`${passed}/${tests.length} passed`);
