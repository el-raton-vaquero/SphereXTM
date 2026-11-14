import { bvToRGB } from './astro';

/** Decoded Yale Bright Star Catalogue (see public/cosmos/README.md). */
export interface StarCatalog {
  n: number;
  ra: Float32Array; // deg, J2000
  dec: Float32Array; // deg, J2000
  vmag: Float32Array;
  rgb: Float32Array; // 3 per star, from B−V
}

export const STAR_CATALOG_URL = '/cosmos/bsc5.bin';

export function decodeStarCatalog(buf: ArrayBuffer): StarCatalog {
  const view = new DataView(buf);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'BSC5') throw new Error('bsc5.bin: bad magic');
  const n = view.getUint32(4, true);
  if (buf.byteLength < 8 + n * 6) throw new Error('bsc5.bin: truncated');
  const ra = new Float32Array(n);
  const dec = new Float32Array(n);
  const vmag = new Float32Array(n);
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = 8 + i * 6;
    ra[i] = (view.getUint16(o, true) / 65535) * 360;
    dec[i] = (view.getInt16(o + 2, true) / 32767) * 90;
    vmag[i] = view.getUint8(o + 4) / 20 - 2;
    const bvRaw = view.getInt8(o + 5);
    const c = bvToRGB(bvRaw === 127 ? 0.6 : bvRaw / 50);
    rgb[i * 3] = c[0];
    rgb[i * 3 + 1] = c[1];
    rgb[i * 3 + 2] = c[2];
  }
  return { n, ra, dec, vmag, rgb };
}

export async function loadStarCatalog(signal?: AbortSignal): Promise<StarCatalog> {
  const res = await fetch(STAR_CATALOG_URL, { signal });
  if (!res.ok) throw new Error(`bsc5.bin HTTP ${res.status}`);
  return decodeStarCatalog(await res.arrayBuffer());
}
