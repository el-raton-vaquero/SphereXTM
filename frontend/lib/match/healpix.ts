/**
 * Inverse of hipsRender.locateInTile: the sky direction of a (col, row) position inside a HiPS
 * tile (HEALPix NESTED, HiPS 1.0 convention: PNG row = face x, PNG column = face y).
 * Continuous version of healpix_base pix2loc (Gorski et al. 2005).
 */
const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
const JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];

function compact(v: number): number {
  // de-interleave the even bits of v (v < 2^26)
  let r = 0;
  for (let b = 0; b < 13; b++) r += Math.floor(v / 4 ** b) % 2 * 2 ** b;
  return r;
}

/** Face and tile coordinates (tx, ty) of a nested index at `order`. */
export function nestToFaceXY(order: number, npix: number): { face: number; tx: number; ty: number } {
  const per = 4 ** order;
  const face = Math.floor(npix / per), local = npix - face * per;
  return { face, tx: compact(local), ty: compact(Math.floor(local / 2)) };
}

/** RA/Dec (deg) of continuous face coordinates (x, y) in [0, nside) on `face`. */
export function faceXYToRadec(face: number, x: number, y: number, nside: number): { ra: number; dec: number } {
  const jr = JRLL[face] * nside - x - y;
  let nr: number, z: number;
  if (jr < nside) { nr = jr; z = 1 - (nr * nr) / (3 * nside * nside); }
  else if (jr > 3 * nside) { nr = 4 * nside - jr; z = (nr * nr) / (3 * nside * nside) - 1; }
  else { nr = nside; z = ((2 * nside - jr) * 2) / (3 * nside); }
  let phi = nr > 1e-12 ? (Math.PI / 4) * ((JPLL[face] * nr + x - y) / nr) : 0;
  phi = ((phi % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return { ra: (phi * 180) / Math.PI, dec: (Math.asin(Math.max(-1, Math.min(1, z))) * 180) / Math.PI };
}

/** RA/Dec of continuous PNG position (col, row) inside tile `npix` at `order` (width px). */
export function tilePixelRadec(order: number, npix: number, col: number, row: number, width = 512): { ra: number; dec: number } {
  const { face, tx, ty } = nestToFaceXY(order, npix);
  const nside = 2 ** order * width;
  return faceXYToRadec(face, tx * width + row, ty * width + col, nside);
}

/** Angular distance (deg). */
export function sepDeg(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const k = Math.PI / 180;
  const s = Math.sin(((dec2 - dec1) * k) / 2) ** 2 + Math.cos(dec1 * k) * Math.cos(dec2 * k) * Math.sin(((ra2 - ra1) * k) / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(s))) * 180) / Math.PI;
}
