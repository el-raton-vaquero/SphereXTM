/**
 * Minimal QR Code encoder (ISO/IEC 18004): byte mode, error-correction level M, versions 1-10,
 * automatic mask selection by the standard penalty rules. No dependencies.
 *
 * Follows the structure of Project Nayuki's reference QR generator (MIT): build the data bit
 * stream, split into Reed-Solomon blocks over GF(256) (poly 0x11D), interleave, draw function
 * patterns, zig-zag the codewords, try the 8 masks and keep the one with the lowest penalty.
 * Verified by decoding generated symbols with OpenCV's QRCodeDetector (see scripts/test-qr.mjs
 * notes in the commit) for every version 1..10.
 *
 * encodeQr(text) -> { size, modules } where modules[y][x] === true is a dark module.
 * Throws when the UTF-8 text does not fit version 10-M (213 bytes).
 */

export interface QrCode { version: number; size: number; modules: boolean[][] }

// Level M, versions 1..10 (index 0 unused).
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;
const FORMAT_ECC_M = 0; // format bits for level M

function rawDataModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const na = Math.floor(ver / 7) + 2;
    r -= (25 * na - 10) * na - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}

function dataCodewords(ver: number): number {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
}

/** Max UTF-8 payload bytes that fit at a version (byte mode, level M). */
export function capacityBytes(ver: number): number {
  const ccBits = ver <= 9 ? 8 : 16;
  return Math.floor((dataCodewords(ver) * 8 - 4 - ccBits) / 8);
}

// --- GF(256) Reed-Solomon ------------------------------------------------------------------

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

// --- encoder --------------------------------------------------------------------------------

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) return [];
  const na = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (na * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < na; pos -= step) result.splice(1, 0, pos);
  return result;
}

export function encodeQr(text: string): QrCode {
  const bytes = utf8(text);
  let ver = 1;
  while (ver <= MAX_VERSION && bytes.length > capacityBytes(ver)) ver++;
  if (ver > MAX_VERSION) throw new Error(`QR: ${bytes.length} bytes exceed version ${MAX_VERSION}-M`);

  // Bit stream: mode 0100, count, data, terminator, pad to bytes, pad codewords.
  const bits: number[] = [];
  const put = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0x4, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capBits = dataCodewords(ver) * 8;
  put(0, Math.min(4, capBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | bits[i + k];
    data.push(v);
  }

  // Blocks + ECC, interleaved.
  const nb = NUM_BLOCKS[ver], ecLen = ECC_PER_BLOCK[ver];
  const rawCw = Math.floor(rawDataModules(ver) / 8);
  const nShort = nb - (rawCw % nb), shortLen = Math.floor(rawCw / nb);
  const div = rsDivisor(ecLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = data.slice(k, k + shortLen - ecLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0); // placeholder so all blocks have equal length
    blocks.push(dat.concat(ecc));
  }
  const codewords: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((blk, j) => { if (i !== shortLen - ecLen || j >= nShort) codewords.push(blk[i]); });
  }

  const size = ver * 4 + 17;
  const mod: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => { mod[y][x] = dark; fn[y][x] = true; };

  // Timing.
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // Finders (with separators).
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  // Alignment.
  const al = alignmentPositions(ver, size);
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // Format (placeholder now, real bits after masking) and version info.
  const drawFormat = (mask: number) => {
    const d = (FORMAT_ECC_M << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((d << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((b >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true); // dark module
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const b = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((b >>> i) & 1) !== 0, a = size - 11 + (i % 3), c = Math.floor(i / 3);
      set(a, c, dark); set(c, a, dark);
    }
  }

  // Data, zig-zag from the bottom-right.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < codewords.length * 8) {
          mod[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }

  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (fn[y][x]) continue;
      let inv: boolean;
      switch (mask) {
        case 0: inv = (x + y) % 2 === 0; break;
        case 1: inv = y % 2 === 0; break;
        case 2: inv = x % 3 === 0; break;
        case 3: inv = (x + y) % 3 === 0; break;
        case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (inv) mod[y][x] = !mod[y][x];
    }
  };

  let best = 0, bestPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m);
    drawFormat(m);
    const p = penalty(mod, size);
    if (p < bestPenalty) { bestPenalty = p; best = m; }
    applyMask(m); // undo (XOR)
  }
  applyMask(best);
  drawFormat(best);
  return { version: ver, size, modules: mod };
}

function penalty(m: boolean[][], size: number): number {
  let result = 0;
  const N1 = 3, N2 = 3, N3 = 40, N4 = 10;
  // Runs and finder-like patterns, rows then columns.
  const line = (get: (k: number) => boolean) => {
    let runColor = false, runLen = 0;
    const hist = [0, 0, 0, 0, 0, 0, 0];
    const addHist = (len: number) => { if (hist[0] === 0) len += size; hist.pop(); hist.unshift(len); };
    const countPatterns = () => {
      const n = hist[1];
      const core = n > 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n;
      return (core && hist[0] >= n * 4 && hist[6] >= n ? 1 : 0) + (core && hist[6] >= n * 4 && hist[0] >= n ? 1 : 0);
    };
    for (let k = 0; k < size; k++) {
      const c = get(k);
      if (c === runColor) {
        runLen++;
        if (runLen === 5) result += N1; else if (runLen > 5) result++;
      } else {
        addHist(runLen);
        if (!runColor) result += countPatterns() * N3;
        runColor = c; runLen = 1;
      }
    }
    // terminate
    if (runColor) { addHist(runLen); runLen = 0; }
    runLen += size;
    addHist(runLen);
    result += countPatterns() * N3;
  };
  for (let y = 0; y < size; y++) line((x) => m[y][x]);
  for (let x = 0; x < size; x++) line((y) => m[y][x]);
  // 2x2 blocks.
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += N2;
  }
  // Dark balance.
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * N4;
  return result;
}
