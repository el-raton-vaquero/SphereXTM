// Builds public/sky/constellations.json: constellation stick figures as pairs of star indices
// into public/cosmos/bsc5.bin, so the lines follow each star's proper motion in /sky.
//
// Source: d3-celestial by Olaf Frohn (BSD 3-Clause), data/constellations.lines.json
// (IAU constellations, "modern" Western figures), J2000 vertex coordinates:
//
//   curl -o lines.json https://cdn.jsdelivr.net/npm/d3-celestial@0.7.35/data/constellations.lines.json
//   node lib/sky/tools/build-constellations.mjs lines.json public/cosmos/bsc5.bin public/sky/constellations.json
//
// Every vertex is snapped to the nearest BSC5 star within 0.25 deg (vertices are star positions).
// Segments whose ends do not match a BSC5 star (a handful of faint vertices) are dropped.
// Output: { "source": ..., "lines": { "And": [i0, j0, i1, j1, ...], ... } }
import { readFileSync, writeFileSync } from 'node:fs';

const [, , linesPath, bscPath, outPath] = process.argv;
if (!linesPath || !bscPath || !outPath) {
  console.error('usage: node build-constellations.mjs <lines.json> <bsc5.bin> <out.json>');
  process.exit(1);
}

const bsc = readFileSync(bscPath);
if (bsc.toString('ascii', 0, 4) !== 'BSC5') throw new Error('bsc5.bin: bad magic');
const n = bsc.readUInt32LE(4);
const R = Math.PI / 180;
const stars = [];
for (let i = 0; i < n; i++) {
  const o = 8 + i * 6;
  const ra = (bsc.readUInt16LE(o) / 65535) * 360 * R;
  const dec = (bsc.readInt16LE(o + 2) / 32767) * 90 * R;
  stars.push([Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)]);
}
const cosLimit = Math.cos(0.25 * R);
function nearest(raDeg, decDeg) {
  const ra = raDeg * R;
  const dec = decDeg * R;
  const v = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  let best = -1;
  let bestDot = cosLimit;
  for (let i = 0; i < n; i++) {
    const s = stars[i];
    const d = s[0] * v[0] + s[1] * v[1] + s[2] * v[2];
    if (d > bestDot) { bestDot = d; best = i; }
  }
  return best;
}

const src = JSON.parse(readFileSync(linesPath, 'utf8'));
const lines = {};
let kept = 0;
let dropped = 0;
for (const f of src.features) {
  const segs = [];
  for (const path of f.geometry.coordinates) {
    const idx = path.map(([ra, dec]) => nearest(((ra % 360) + 360) % 360, dec));
    for (let k = 0; k + 1 < idx.length; k++) {
      if (idx[k] >= 0 && idx[k + 1] >= 0 && idx[k] !== idx[k + 1]) { segs.push(idx[k], idx[k + 1]); kept++; }
      else dropped++;
    }
  }
  if (segs.length) lines[f.id] = segs;
}
const out = {
  source: 'd3-celestial (c) 2015 Olaf Frohn, BSD 3-Clause; constellations.lines.json v0.7.35, vertices snapped to BSC5 (V/50)',
  lines,
};
writeFileSync(outPath, JSON.stringify(out));
console.log(`${Object.keys(lines).length} constellations, ${kept} segments kept, ${dropped} dropped -> ${outPath}`);
