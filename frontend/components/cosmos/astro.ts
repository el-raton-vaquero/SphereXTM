/**
 * Small, dependency-free astrometry helpers for the /cosmos scene.
 *
 * Scene convention (three.js, right-handed, Y up):
 *   equatorial unit vector (x, y, z) = (cosδ cosα, cosδ sinα, sinδ)
 *   scene vector (X, Y, Z)           = (x, z, -y)
 * This is a proper rotation (det = +1), so the sky seen from the centre is NOT
 * mirrored: with north up, RA increases to the left (east), as on a real sky.
 */

export const DEG = Math.PI / 180;
export const OBLIQUITY_J2000 = 23.4392911 * DEG;

export type Vec3 = [number, number, number];

export function radecToScene(raDeg: number, decDeg: number, r = 1): Vec3 {
  const a = raDeg * DEG;
  const d = decDeg * DEG;
  const x = Math.cos(d) * Math.cos(a);
  const y = Math.cos(d) * Math.sin(a);
  const z = Math.sin(d);
  return [x * r, z * r, -y * r];
}

export function sceneToRadec(X: number, Y: number, Z: number): { ra: number; dec: number } {
  const n = Math.hypot(X, Y, Z) || 1;
  const x = X / n;
  const y = -Z / n;
  const z = Y / n;
  let ra = Math.atan2(y, x) / DEG;
  if (ra < 0) ra += 360;
  return { ra, dec: Math.asin(Math.max(-1, Math.min(1, z))) / DEG };
}

/** Ecliptic (λ, β) of date ≈ J2000 → equatorial (α, δ), degrees. */
export function eclipticToRadec(lonDeg: number, latDeg: number): { ra: number; dec: number } {
  const l = lonDeg * DEG;
  const b = latDeg * DEG;
  const e = OBLIQUITY_J2000;
  const x = Math.cos(b) * Math.cos(l);
  const y = Math.cos(b) * Math.sin(l) * Math.cos(e) - Math.sin(b) * Math.sin(e);
  const z = Math.cos(b) * Math.sin(l) * Math.sin(e) + Math.sin(b) * Math.cos(e);
  let ra = Math.atan2(y, x) / DEG;
  if (ra < 0) ra += 360;
  return { ra, dec: Math.asin(z) / DEG };
}

/** IAU galactic → ICRS rotation (transpose of the standard ICRS→galactic matrix). */
const GAL_TO_EQ = [
  [-0.0548755604162154, 0.4941094278755837, -0.867666148981161],
  [-0.8734370902348850, -0.4448296299600112, -0.1980763734312015],
  [-0.4838350155487132, 0.7469822444972189, 0.4559837761750669],
];

export function galacticToRadec(lDeg: number, bDeg: number): { ra: number; dec: number } {
  const l = lDeg * DEG;
  const b = bDeg * DEG;
  const g = [Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)];
  const e = GAL_TO_EQ.map((row) => row[0] * g[0] + row[1] * g[1] + row[2] * g[2]);
  let ra = Math.atan2(e[1], e[0]) / DEG;
  if (ra < 0) ra += 360;
  return { ra, dec: Math.asin(e[2]) / DEG };
}

/** Low-precision apparent solar ecliptic longitude (Astronomical Almanac, ~0.01°). */
export function sunEclipticLongitude(date: Date): number {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = 280.46 + 0.9856474 * n;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lam = L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g);
  return ((lam % 360) + 360) % 360;
}

const pad = (v: number, w: number, d = 0) => {
  const s = v.toFixed(d);
  const [i, f] = s.split('.');
  return i.padStart(w, '0') + (f !== undefined ? '.' + f : '');
};

/** 17h57m48.5s */
export function formatRA(raDeg: number, secDigits = 1): string {
  let h = (((raDeg % 360) + 360) % 360) / 15;
  let hh = Math.floor(h);
  h = (h - hh) * 60;
  let mm = Math.floor(h);
  let ss = Number(((h - mm) * 60).toFixed(secDigits));
  if (ss >= 60) { ss -= 60; mm += 1; }
  if (mm >= 60) { mm -= 60; hh = (hh + 1) % 24; }
  return `${pad(hh, 2)}h${pad(mm, 2)}m${pad(ss, 2, secDigits)}s`;
}

/** +04°41′36″ */
export function formatDec(decDeg: number, secDigits = 0): string {
  const sign = decDeg < 0 ? '−' : '+';
  let v = Math.abs(decDeg);
  let dd = Math.floor(v);
  v = (v - dd) * 60;
  let mm = Math.floor(v);
  let ss = Number(((v - mm) * 60).toFixed(secDigits));
  if (ss >= 60) { ss -= 60; mm += 1; }
  if (mm >= 60) { mm -= 60; dd += 1; }
  return `${sign}${pad(dd, 2)}°${pad(mm, 2)}′${pad(ss, 2, secDigits)}″`;
}

/**
 * Parses "269.452 4.693", "269.452, +4.693", "17h57m48.5s +04d41m36s",
 * "17:57:48.5 +04:41:36" or "17 57 48.5 +04 41 36". Returns null if not coordinates.
 */
export function parseRaDec(input: string): { ra: number; dec: number } | null {
  const s = input.trim().replace(/[−–]/g, '-').replace(/[°′″'"]/g, ' ');
  const dec = s.match(/^([+-]?\d+(?:\.\d+)?)\s*[,\s]\s*([+-]?\d+(?:\.\d+)?)$/);
  if (dec) {
    const ra = parseFloat(dec[1]);
    const de = parseFloat(dec[2]);
    if (ra >= 0 && ra < 360 && de >= -90 && de <= 90) return { ra, dec: de };
    return null;
  }
  const sx = s.match(
    /^(\d{1,2})[h:\s]\s*(\d{1,2})[m:\s]\s*(\d{1,2}(?:\.\d+)?)s?\s*[,\s]\s*([+-]?)(\d{1,2})[d:\s]\s*(\d{1,2})[m:\s]\s*(\d{1,2}(?:\.\d+)?)s?$/i,
  );
  if (sx) {
    const ra = (+sx[1] + +sx[2] / 60 + +sx[3] / 3600) * 15;
    const de = (sx[4] === '-' ? -1 : 1) * (+sx[5] + +sx[6] / 60 + +sx[7] / 3600);
    if (ra >= 0 && ra < 360 && de >= -90 && de <= 90 && +sx[2] < 60 && +sx[6] < 60) return { ra, dec: de };
  }
  return null;
}

/** Angular separation in degrees. */
export function separationDeg(ra1: number, de1: number, ra2: number, de2: number): number {
  const a = radecToScene(ra1, de1);
  const b = radecToScene(ra2, de2);
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.max(-1, Math.min(1, dot))) / DEG;
}

/** B−V colour index → approximate blackbody RGB (0..1). Ballesteros (2012) T, Helland fit. */
export function bvToRGB(bv: number): Vec3 {
  const b = Math.max(-0.4, Math.min(2.0, bv));
  const t = 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
  const k = t / 100;
  let r: number, g: number, bl: number;
  if (k <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(k) - 161.1195681661;
    bl = k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(k - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(k - 60, -0.0755148492);
    bl = 255;
  }
  const c = (v: number) => Math.max(0, Math.min(255, v)) / 255;
  return [c(r), c(g), c(bl)];
}
