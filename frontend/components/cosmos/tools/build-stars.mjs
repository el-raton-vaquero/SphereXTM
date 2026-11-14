// Converts the Yale Bright Star Catalogue (BSC5, VizieR V/50) TSV export into
// the compact binary used by /cosmos (public/cosmos/bsc5.bin).
//
//   curl -o bsc.tsv "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?-source=V/50/catalog&-out=HR,Name,RAJ2000,DEJ2000,Vmag,B-V&-out.max=10000"
//   node components/cosmos/tools/build-stars.mjs bsc.tsv public/cosmos/bsc5.bin
//
// Format (little endian): "BSC5" magic, uint32 n, then n records of 6 bytes:
//   uint16 ra  = round(RA_deg / 360 * 65535)        (J2000, ~20 arcsec step)
//   int16  dec = round(Dec_deg / 90 * 32767)        (J2000, ~10 arcsec step)
//   uint8  mag = round((Vmag + 2) * 20)             (0.05 mag step)
//   int8   bv  = round(B-V * 50), 127 = unknown     (0.02 mag step)
// Records are sorted bright -> faint.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: node build-stars.mjs <bsc.tsv> <out.bin>');
  process.exit(1);
}

const sex = (s, hours) => {
  const parts = s.trim().split(/\s+/);
  if (parts.length < 2) return NaN;
  const sign = parts[0].startsWith('-') ? -1 : 1;
  const [a, b, c = '0'] = parts.map((p) => Math.abs(parseFloat(p)));
  const v = sign * (a + b / 60 + parseFloat(c) / 3600);
  return hours ? v * 15 : v;
};

const rows = [];
for (const line of readFileSync(input, 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#')) continue;
  const cols = line.split('\t');
  if (cols.length < 6 || !/^\s*\d+\s*$/.test(cols[0])) continue;
  const ra = sex(cols[2], true);
  const dec = sex(cols[3], false);
  const v = parseFloat(cols[4]);
  const bv = parseFloat(cols[5]);
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(v)) continue;
  rows.push({ ra, dec, v, bv });
}
rows.sort((a, b) => a.v - b.v);

const buf = Buffer.alloc(8 + rows.length * 6);
buf.write('BSC5', 0, 'ascii');
buf.writeUInt32LE(rows.length, 4);
rows.forEach((r, i) => {
  const o = 8 + i * 6;
  buf.writeUInt16LE(Math.round(((((r.ra % 360) + 360) % 360) / 360) * 65535), o);
  buf.writeInt16LE(Math.round((r.dec / 90) * 32767), o + 2);
  buf.writeUInt8(Math.max(0, Math.min(255, Math.round((r.v + 2) * 20))), o + 4);
  buf.writeInt8(Number.isFinite(r.bv) ? Math.max(-100, Math.min(126, Math.round(r.bv * 50))) : 127, o + 5);
});
writeFileSync(output, buf);
console.log(`${rows.length} stars -> ${output} (${buf.length} bytes); brightest V=${rows[0].v}`);
