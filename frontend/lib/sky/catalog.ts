/**
 * Star catalogue for the /sky planetarium: Yale BSC5 positions/magnitudes/colours
 * (public/cosmos/bsc5.bin) + proper motions and HR numbers (public/sky/bsc5pm.bin).
 * See public/cosmos/README.md and public/sky/README.md for sources and formats.
 */
import { bvToRGB } from '../../components/cosmos/astro';
import { STAR_NAMES } from './names';

export interface SkyCatalog {
  n: number;
  /** J2000 unit vectors (EQJ, astronomy-engine axes), 3 per star, at epoch J2000.0. */
  vec: Float64Array;
  /** Tangent-plane proper-motion basis * μ, radians per year, 3 per star (μα* eα + μδ eδ). */
  pmVec: Float64Array;
  ra: Float32Array; // deg J2000
  dec: Float32Array; // deg J2000
  vmag: Float32Array;
  bv: Float32Array; // NaN if unknown
  rgb: Float32Array;
  pmRa: Int16Array; // mas/yr, μα·cosδ
  pmDec: Int16Array; // mas/yr
  hr: Uint16Array;
}

const MAS = Math.PI / 180 / 3600 / 1000;

export function decodeSkyCatalog(bsc: ArrayBuffer, pm: ArrayBuffer | null): SkyCatalog {
  const view = new DataView(bsc);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'BSC5') throw new Error('bsc5.bin: bad magic');
  const n = view.getUint32(4, true);
  let pv: DataView | null = null;
  if (pm) {
    pv = new DataView(pm);
    const m = String.fromCharCode(pv.getUint8(0), pv.getUint8(1), pv.getUint8(2), pv.getUint8(3));
    if (m !== 'BSCP' || pv.getUint32(4, true) !== n || pm.byteLength < 8 + n * 6) pv = null;
  }
  const cat: SkyCatalog = {
    n,
    vec: new Float64Array(n * 3),
    pmVec: new Float64Array(n * 3),
    ra: new Float32Array(n),
    dec: new Float32Array(n),
    vmag: new Float32Array(n),
    bv: new Float32Array(n),
    rgb: new Float32Array(n * 3),
    pmRa: new Int16Array(n),
    pmDec: new Int16Array(n),
    hr: new Uint16Array(n),
  };
  const D = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const o = 8 + i * 6;
    const ra = (view.getUint16(o, true) / 65535) * 360;
    const dec = (view.getInt16(o + 2, true) / 32767) * 90;
    cat.ra[i] = ra;
    cat.dec[i] = dec;
    cat.vmag[i] = view.getUint8(o + 4) / 20 - 2;
    const bvRaw = view.getInt8(o + 5);
    const bv = bvRaw === 127 ? NaN : bvRaw / 50;
    cat.bv[i] = bv;
    const c = bvToRGB(Number.isFinite(bv) ? bv : 0.6);
    cat.rgb.set(c, i * 3);
    const a = ra * D, d = dec * D;
    const ca = Math.cos(a), sa = Math.sin(a), cd = Math.cos(d), sd = Math.sin(d);
    cat.vec[i * 3] = cd * ca;
    cat.vec[i * 3 + 1] = cd * sa;
    cat.vec[i * 3 + 2] = sd;
    if (pv) {
      const po = 8 + i * 6;
      const mra = pv.getInt16(po, true);
      const mde = pv.getInt16(po + 2, true);
      cat.pmRa[i] = mra;
      cat.pmDec[i] = mde;
      cat.hr[i] = pv.getUint16(po + 4, true);
      // eα = (−sinα, cosα, 0), eδ = (−sinδ cosα, −sinδ sinα, cosδ)
      const ma = mra * MAS, md = mde * MAS;
      cat.pmVec[i * 3] = -sa * ma - sd * ca * md;
      cat.pmVec[i * 3 + 1] = ca * ma - sd * sa * md;
      cat.pmVec[i * 3 + 2] = cd * md;
    }
  }
  return cat;
}

export async function loadSkyCatalog(signal?: AbortSignal): Promise<SkyCatalog> {
  const [b, p] = await Promise.all([
    fetch('/cosmos/bsc5.bin', { signal }).then((r) => {
      if (!r.ok) throw new Error(`bsc5.bin HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
    // Proper motions are an enhancement: without them the sky still renders (fixed stars).
    fetch('/sky/bsc5pm.bin', { signal }).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null),
  ]);
  return decodeSkyCatalog(b, p);
}

/** Display name of catalogue star i: IAU proper name, else "HR nnnn". */
export function starName(cat: SkyCatalog, i: number): string {
  const hr = cat.hr[i];
  if (hr && STAR_NAMES[hr]) return STAR_NAMES[hr].name;
  return hr ? `HR ${hr}` : `BSC #${i + 1}`;
}

/** Propagate star i to `years` after J2000.0 (linear tangent-plane motion); writes a unit vector. */
export function starVectorAt(cat: SkyCatalog, i: number, years: number, out: Float64Array | number[], off = 0): void {
  const x = cat.vec[i * 3] + cat.pmVec[i * 3] * years;
  const y = cat.vec[i * 3 + 1] + cat.pmVec[i * 3 + 1] * years;
  const z = cat.vec[i * 3 + 2] + cat.pmVec[i * 3 + 2] * years;
  const r = Math.hypot(x, y, z) || 1;
  out[off] = x / r;
  out[off + 1] = y / r;
  out[off + 2] = z / r;
}
