import type { Frame, SearchResult, WireSearch } from './types';

/** Decode base64 into raw bytes (browser and Node). */
export function b64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Little-endian float32 buffer -> Float32Array (NaN preserved = invalid pixel). */
export function decodeFloat32(b64: string, expected: number): Float32Array {
  const bytes = b64ToBytes(b64);
  if (bytes.byteLength !== expected * 4) {
    throw new Error(`pixels_b64 has ${bytes.byteLength} bytes, expected ${expected * 4}`);
  }
  if (LITTLE_ENDIAN) return new Float32Array(bytes.buffer, bytes.byteOffset, expected).slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(expected);
  for (let i = 0; i < expected; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** Little-endian uint32 buffer -> Uint32Array. */
export function decodeUint32(b64: string, expected: number): Uint32Array {
  const bytes = b64ToBytes(b64);
  if (bytes.byteLength !== expected * 4) {
    throw new Error(`flags_b64 has ${bytes.byteLength} bytes, expected ${expected * 4}`);
  }
  if (LITTLE_ENDIAN) return new Uint32Array(bytes.buffer, bytes.byteOffset, expected).slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint32Array(expected);
  for (let i = 0; i < expected; i++) out[i] = view.getUint32(i * 4, true);
  return out;
}

/** Validate and decode a /v2/search payload. Throws on contract violations. */
export function decodeSearch(wire: WireSearch): SearchResult {
  if (!wire || !wire.grid || !Array.isArray(wire.frames)) throw new Error('Malformed search payload');
  const n = wire.grid.n;
  if (!Number.isInteger(n) || n < 2 || n > 1024) throw new Error(`Invalid grid size ${n}`);
  const frames: Frame[] = wire.frames
    .map((f) => {
      const { pixels_b64, flags_b64, ...rest } = f;
      return {
        ...rest,
        index: 0,
        pixels: decodeFloat32(pixels_b64, n * n),
        flags: flags_b64 ? decodeUint32(flags_b64, n * n) : new Uint32Array(n * n),
      };
    })
    .sort((a, b) => a.mjd - b.mjd || a.lambda_um - b.lambda_um);
  frames.forEach((f, i) => (f.index = i));
  return { ...wire, frames };
}
