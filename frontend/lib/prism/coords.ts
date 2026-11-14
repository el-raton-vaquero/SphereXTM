import type { Grid } from './types';

const D2R = Math.PI / 180;

/** Parse "RA Dec" in degrees or sexagesimal (h m s / d m s, colons or letters). */
export function parseRaDec(input: string): { ra: number; dec: number } | null {
  const s = input.trim().replace(/[\u2212\u2013]/g, '-').replace(/[,;]/g, ' ').replace(/\s+/g, ' ');
  if (!s) return null;
  const deg = s.match(/^([+]?\d+(?:\.\d+)?)\s*(?:d|deg|°)?\s+([+-]?\d+(?:\.\d+)?)\s*(?:d|deg|°)?$/i);
  if (deg) {
    const ra = parseFloat(deg[1]);
    const dec = parseFloat(deg[2]);
    return valid(ra, dec);
  }
  // Sexagesimal: 08h55m10.831s -07d14m42.53s | 08:55:10.8 -07:14:42 | 08 55 10.8 -07 14 42
  const sexa = s.match(
    /^(\d{1,2})[h:\s]\s*(\d{1,2})[m:\s]\s*(\d{1,2}(?:\.\d+)?)s?\s+([+-]?)(\d{1,2})[d°:\s]\s*(\d{1,2})['m:\s]\s*(\d{1,2}(?:\.\d+)?)(?:"|s|'')?$/i,
  );
  if (sexa) {
    const ra = (parseFloat(sexa[1]) + parseFloat(sexa[2]) / 60 + parseFloat(sexa[3]) / 3600) * 15;
    const sign = sexa[4] === '-' ? -1 : 1;
    const dec = sign * (parseFloat(sexa[5]) + parseFloat(sexa[6]) / 60 + parseFloat(sexa[7]) / 3600);
    return valid(ra, dec);
  }
  return null;
}

function valid(ra: number, dec: number) {
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || ra < 0 || ra >= 360 || dec < -90 || dec > 90) return null;
  return { ra, dec };
}

const pad = (v: number, w: number, d = 0) => {
  const str = v.toFixed(d);
  const [int, frac] = str.split('.');
  return int.padStart(w, '0') + (frac !== undefined ? '.' + frac : '');
};

export function formatRa(ra: number, digits = 2): string {
  let h = (((ra % 360) + 360) % 360) / 15;
  let hh = Math.floor(h);
  h = (h - hh) * 60;
  let mm = Math.floor(h);
  let ss = +((h - mm) * 60).toFixed(digits);
  if (ss >= 60) { ss = 0; mm += 1; }
  if (mm >= 60) { mm = 0; hh = (hh + 1) % 24; }
  return `${pad(hh, 2)}h${pad(mm, 2)}m${pad(ss, 2, digits)}s`;
}

export function formatDec(dec: number, digits = 1): string {
  const sign = dec < 0 ? '−' : '+';
  let d = Math.abs(dec);
  let dd = Math.floor(d);
  d = (d - dd) * 60;
  let mm = Math.floor(d);
  let ss = +((d - mm) * 60).toFixed(digits);
  if (ss >= 60) { ss = 0; mm += 1; }
  if (mm >= 60) { mm = 0; dd += 1; }
  return `${sign}${pad(dd, 2)}°${pad(mm, 2)}′${pad(ss, 2, digits)}″`;
}

/** Gnomonic (TAN) projection around grid crval. Pixel coords are 0-based with row 0 = North. */
export function makeProjector(grid: Grid) {
  const [ra0, dec0] = grid.wcs.crval;
  const [crpix1, crpix2] = grid.wcs.crpix; // FITS 1-based, FITS row axis points North
  const cd = grid.wcs.cd;
  const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
  const n = grid.n;
  const a0 = ra0 * D2R;
  const d0 = dec0 * D2R;
  const sinD0 = Math.sin(d0);
  const cosD0 = Math.cos(d0);

  /** sky (deg) -> pixel {x, y} with y measured downward from the North (top) row. */
  function skyToPix(ra: number, dec: number) {
    const a = ra * D2R;
    const d = dec * D2R;
    const cosc = sinD0 * Math.sin(d) + cosD0 * Math.cos(d) * Math.cos(a - a0);
    const xi = (Math.cos(d) * Math.sin(a - a0)) / cosc / D2R; // deg, East positive
    const eta = (cosD0 * Math.sin(d) - sinD0 * Math.cos(d) * Math.cos(a - a0)) / cosc / D2R;
    // intermediate = CD * (p - crpix); invert. xi is +East but FITS x has -RA direction via CD.
    const px = (cd[1][1] * xi - cd[0][1] * eta) / det;
    const py = (-cd[1][0] * xi + cd[0][0] * eta) / det;
    const fx = px + crpix1 - 1; // 0-based FITS x
    const fy = py + crpix2 - 1; // 0-based FITS y (South = 0)
    return { x: fx, y: n - 1 - fy };
  }

  /** pixel (0-based, North-up rows) -> sky (deg). */
  function pixToSky(x: number, y: number) {
    const fx = x + 1 - crpix1;
    const fy = n - 1 - y + 1 - crpix2;
    const xi = (cd[0][0] * fx + cd[0][1] * fy) * D2R;
    const eta = (cd[1][0] * fx + cd[1][1] * fy) * D2R;
    const rho = Math.hypot(xi, eta);
    if (rho === 0) return { ra: ra0, dec: dec0 };
    const c = Math.atan(rho);
    const sinc = Math.sin(c);
    const cosc = Math.cos(c);
    const dec = Math.asin(cosc * sinD0 + (eta * sinc * cosD0) / rho);
    const ra = a0 + Math.atan2(xi * sinc, rho * cosD0 * cosc - eta * sinD0 * sinc);
    return { ra: ((ra / D2R) % 360 + 360) % 360, dec: dec / D2R };
  }

  return { skyToPix, pixToSky };
}

export function angularSepArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const d1 = dec1 * D2R, d2 = dec2 * D2R;
  const dra = (ra2 - ra1) * D2R;
  const a = Math.sin((d2 - d1) / 2) ** 2 + Math.cos(d1) * Math.cos(d2) * Math.sin(dra / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(a)))) / D2R * 3600;
}

export function mjdToDate(mjd: number): Date {
  return new Date((mjd - 40587) * 86400000);
}

export function formatMjdDate(mjd: number): string {
  return mjdToDate(mjd).toISOString().slice(0, 10);
}

export function mjdToYear(mjd: number): number {
  return 2000 + (mjd - 51544.5) / 365.25;
}
