// Builds public/sky/bsc5pm.bin: proper motions for every star of public/cosmos/bsc5.bin, in the
// same record order, so the /sky planetarium can propagate positions over millennia.
//
// Source: Yale Bright Star Catalogue 5th Rev. Ed. (Hoffleit & Warren 1991, NASA ADC / CDS V/50),
// binary distribution of the Harvard-Smithsonian Telescope Data Center (same catalogue, J2000
// FK5 positions + annual proper motions). CDS VizieR (and its CfA mirror) were unreachable on
// 2026-11-14, so the TDC copy was used:
//
//   curl -o BSC5 http://tdc-www.harvard.edu/catalogs/BSC5
//   node lib/sky/tools/build-pm.mjs BSC5 public/cosmos/bsc5.bin public/sky/bsc5pm.bin
//
// TDC BSC5 format (little endian): 28-byte header of 7 int32 (STAR0, STAR1, STARN<0 = J2000,
// STNUM, MPROP, NMAG, NBENT=32), then records of 32 bytes:
//   float32 XNO, float64 RA (rad), float64 Dec (rad), char[2] spectral type, int16 V*100,
//   float32 pmRA* (rad/yr, mu_alpha * cos(delta); verified against Hipparcos for Arcturus,
//   Sirius, Vega and 61 Cyg), float32 pmDec (rad/yr).
//
// Output format (little endian): "BSCP" magic, uint32 n (== bsc5.bin count), then n records of
//   int16  pmRA* = mu_alpha * cos(delta)  in mas/yr  (clamped to +-32767)
//   int16  pmDec                          in mas/yr
//   uint16 HR number (0 = unmatched), used to attach proper names (lib/sky/names.ts)
// Record i belongs to star i of bsc5.bin. Stars that could not be matched get (0, 0, 0).
import { readFileSync, writeFileSync } from 'node:fs';

const [, , tdcPath, bscPath, outPath, mode] = process.argv;
if (!tdcPath || !bscPath || !outPath) {
  console.error('usage: node build-pm.mjs <BSC5 (TDC)> <public/cosmos/bsc5.bin> <out.bin> [--check]');
  process.exit(1);
}

const RAD2MAS = (180 / Math.PI) * 3600 * 1000;
const tdc = readFileSync(tdcPath);
const nTdc = -tdc.readInt32LE(8);
const nbent = tdc.readInt32LE(24);
if (nTdc <= 0 || nbent !== 32 || tdc.readInt32LE(16) !== 1) throw new Error('unexpected TDC BSC5 header');
const T = [];
for (let i = 0; i < nTdc; i++) {
  const o = 28 + i * 32;
  const hr = Math.round(tdc.readFloatLE(o));
  const ra = tdc.readDoubleLE(o + 4);
  const dec = tdc.readDoubleLE(o + 12);
  const v = tdc.readInt16LE(o + 22) / 100;
  const pmra = tdc.readFloatLE(o + 24) * RAD2MAS; // already mu_alpha* (checked: Arcturus -1093 mas/yr)
  const pmdec = tdc.readFloatLE(o + 28) * RAD2MAS;
  if (ra === 0 && dec === 0) continue; // the few BSC5 entries without positions
  T.push({ hr, ra: (ra * 180) / Math.PI, dec: (dec * 180) / Math.PI, v, pmra, pmdec });
}

if (mode === '--check') {
  const extra = (process.argv[6] || '').split(',').filter(Boolean).map(Number);
  for (const hr of extra) {
    const s = T.find((t) => t.hr === hr);
    if (s) console.log(`HR ${hr}: ra ${s.ra.toFixed(2)} dec ${s.dec.toFixed(2)} V ${s.v}`);
  }
  for (const hr of [5340, 8085, 8086, 4550, 2491, 7001]) {
    const s = T.find((t) => t.hr === hr);
    if (s) console.log(`HR ${hr}: ra ${s.ra.toFixed(4)} dec ${s.dec.toFixed(4)} V ${s.v} pmRA* ${s.pmra.toFixed(1)} pmDec ${s.pmdec.toFixed(1)} mas/yr`);
  }
}

// Decode bsc5.bin (same quantisation as components/cosmos/stars.ts).
const bsc = readFileSync(bscPath);
if (bsc.toString('ascii', 0, 4) !== 'BSC5') throw new Error('bsc5.bin: bad magic');
const n = bsc.readUInt32LE(4);

// Spatial hash on 1-degree cells for the match.
const cell = (ra, dec) => `${Math.floor(((ra % 360) + 360) % 360)}:${Math.floor(dec + 90)}`;
const grid = new Map();
for (const t of T) {
  const k = cell(t.ra, t.dec);
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(t);
}
const sep = (a1, d1, a2, d2) => {
  const r = Math.PI / 180;
  const c = Math.sin(d1 * r) * Math.sin(d2 * r) + Math.cos(d1 * r) * Math.cos(d2 * r) * Math.cos((a1 - a2) * r);
  return (Math.acos(Math.min(1, Math.max(-1, c))) / r) * 3600;
};

const REC = 6;
const out = Buffer.alloc(8 + n * REC);
out.write('BSCP', 0, 'ascii');
out.writeUInt32LE(n, 4);
let matched = 0;
let maxPm = 0;
const used = new Set();
for (let i = 0; i < n; i++) {
  const o = 8 + i * 6;
  const ra = (bsc.readUInt16LE(o) / 65535) * 360;
  const dec = (bsc.readInt16LE(o + 2) / 32767) * 90;
  const v = bsc.readUInt8(o + 4) / 20 - 2;
  let best = null;
  let bestScore = Infinity;
  for (let da = -1; da <= 1; da++) {
    for (let dd = -1; dd <= 1; dd++) {
      const list = grid.get(cell(ra + da, dec + dd));
      if (!list) continue;
      for (const t of list) {
        if (used.has(t)) continue;
        const s = sep(ra, dec, t.ra, t.dec);
        if (s > 60) continue; // quantisation is <= 20"
        const dm = Math.abs(t.v - v);
        if (dm > 0.08) continue; // V quantised to 0.05 mag
        const score = s + dm * 300;
        if (score < bestScore) { bestScore = score; best = t; }
      }
    }
  }
  let pr = 0, pd = 0;
  if (best) {
    used.add(best);
    matched++;
    pr = Math.max(-32767, Math.min(32767, Math.round(best.pmra)));
    pd = Math.max(-32767, Math.min(32767, Math.round(best.pmdec)));
    maxPm = Math.max(maxPm, Math.hypot(pr, pd));
  }
  out.writeInt16LE(pr, 8 + i * REC);
  out.writeInt16LE(pd, 8 + i * REC + 2);
  out.writeUInt16LE(best ? best.hr : 0, 8 + i * REC + 4);
}
writeFileSync(outPath, out);
console.log(`${matched}/${n} stars matched -> ${outPath} (${out.length} bytes); max |pm| ${maxPm} mas/yr`);
