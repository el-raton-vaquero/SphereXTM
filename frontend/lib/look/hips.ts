/**
 * Real SPHEREx all-sky imagery as HiPS (Hierarchical Progressive Survey), served by CDS.
 *
 * Verified 2026-11-14 in the CDS HiPS registry (MocServer, `ID=CDS/P/SPHEREx*`):
 *   CDS/P/SPHEREx/QR2/D1 ... D6  one HiPS per SPHEREx detector (D1 0.75-1.1 um ... D6 4.4-5.0 um)
 *   CDS/P/SPHEREx/QR2/color      colour HiPS built by CDS from the six detector HiPS
 *   progenitor: https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2 (IRSA QR2 spectral images,
 *   MJD 60789-61165), creators Buga M. / Boch T. (CDS), order 7 (~3.2"/px tiles, 512 px),
 *   copyright "Courtesy NASA/JPL-Caltech", https://spherex.caltech.edu/page/image-use-policy.
 * Responses carry `Access-Control-Allow-Origin: *`.
 *
 * We request ready-made JPEG cut-outs from the CDS hips2fits service, giving it the exact TAN
 * WCS of the phone camera (or of a dome-chart pick), so the image lines up with the photo.
 * The mirror (alaskybis) is tried when the main host fails. If both fail the UI falls back to
 * the StarChord snapshots / live IRSA search. No other survey is ever shown as SPHEREx.
 */
import { R2D, transpose, applyM, radecToVec, type M3 } from './sky';
import { focalPx, type CamBasis, type View } from './camera';

export const HIPS_HOSTS = ['https://alasky.cds.unistra.fr', 'https://alaskybis.cds.unistra.fr'];
export type HipsLayer = 'color' | 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';
export const HIPS_LAYERS: HipsLayer[] = ['color', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
export const HIPS_RANGE_UM: Record<Exclude<HipsLayer, 'color'>, string> = {
  D1: '0.75–1.10', D2: '1.10–1.62', D3: '1.63–2.41', D4: '2.42–3.82', D5: '3.83–4.41', D6: '4.42–5.00',
};
export const hipsId = (layer: HipsLayer) => `CDS/P/SPHEREx/QR2/${layer}`;
export const HIPS_RELEASE = 'SPHEREx QR2 (IRSA) · HiPS by CDS';
export const HIPS_CREDIT = 'Courtesy NASA/JPL-Caltech · HiPS: CDS, Strasbourg';
export const HIPS_POLICY_URL = 'https://spherex.caltech.edu/page/image-use-policy';

export interface TanWcs {
  naxis1: number; naxis2: number;
  crval1: number; crval2: number;
  crpix1: number; crpix2: number;
  cd: [[number, number], [number, number]]; // deg/px; row 0 = RA (xi, East +), row 1 = Dec (eta)
}

/**
 * Exact TAN WCS of a pinhole camera view. `m` is the EQJ->ENU matrix of the moment.
 * FITS pixel axes: x to the right, y up (row 1 at the bottom).
 */
export function cameraWcs(b: CamBasis, v: View, m: M3, outW: number, outH: number): TanWcs {
  const mt = transpose(m);
  const f = applyM(mt, b.f), r = applyM(mt, b.r), u = applyM(mt, b.u);
  const ra = Math.atan2(f[1], f[0]), dec = Math.asin(Math.max(-1, Math.min(1, f[2])));
  const east = [-Math.sin(ra), Math.cos(ra), 0];
  const north = [-Math.sin(dec) * Math.cos(ra), -Math.sin(dec) * Math.sin(ra), Math.cos(dec)];
  const d = (a: number[], c: number[]) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
  const scale = v.w / outW; // output px -> screen px
  const s = (scale / focalPx(v)) * R2D; // deg per output px at the centre
  return {
    naxis1: outW, naxis2: outH,
    crval1: ((ra * R2D) % 360 + 360) % 360, crval2: dec * R2D,
    crpix1: outW / 2 + 0.5, crpix2: outH / 2 + 0.5,
    cd: [[s * d(r, east), s * d(u, east)], [s * d(r, north), s * d(u, north)]],
  };
}

/** North-up, East-left TAN WCS centred on (ra, dec) with `fovDeg` across the width. */
export function northUpWcs(ra: number, dec: number, fovDeg: number, outW: number, outH: number): TanWcs {
  const s = fovDeg / outW;
  return { naxis1: outW, naxis2: outH, crval1: ra, crval2: dec, crpix1: outW / 2 + 0.5, crpix2: outH / 2 + 0.5, cd: [[-s, 0], [0, s]] };
}

export function hips2fitsUrl(layer: HipsLayer, w: TanWcs, host = HIPS_HOSTS[0]): string {
  const wcs = {
    NAXIS1: w.naxis1, NAXIS2: w.naxis2, WCSAXES: 2,
    CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CUNIT1: 'deg', CUNIT2: 'deg',
    CRVAL1: +w.crval1.toFixed(6), CRVAL2: +w.crval2.toFixed(6),
    CRPIX1: w.crpix1, CRPIX2: w.crpix2,
    CD1_1: +w.cd[0][0].toExponential(8), CD1_2: +w.cd[0][1].toExponential(8),
    CD2_1: +w.cd[1][0].toExponential(8), CD2_2: +w.cd[1][1].toExponential(8),
  };
  const p = new URLSearchParams({ hips: hipsId(layer), wcs: JSON.stringify(wcs), format: 'jpg' });
  if (layer !== 'color') p.set('stretch', 'asinh');
  return `${host}/hips-image-services/hips2fits?${p.toString()}`;
}

/** Field of view (deg) along the diagonal of a WCS, for labels. */
export function wcsFovDeg(w: TanWcs): number {
  const sx = Math.hypot(w.cd[0][0], w.cd[1][0]), sy = Math.hypot(w.cd[0][1], w.cd[1][1]);
  return Math.max(w.naxis1 * sx, w.naxis2 * sy);
}

/** Screen-space direction of celestial North at the view centre (unit, canvas y down). */
export function northOnScreen(b: CamBasis, m: M3): { x: number; y: number } {
  const mt = transpose(m);
  const f = applyM(mt, b.f), r = applyM(mt, b.r), u = applyM(mt, b.u);
  const ra = Math.atan2(f[1], f[0]), dec = Math.asin(Math.max(-1, Math.min(1, f[2])));
  const north = [-Math.sin(dec) * Math.cos(ra), -Math.sin(dec) * Math.sin(ra), Math.cos(dec)];
  const nx = north[0] * r[0] + north[1] * r[1] + north[2] * r[2];
  const ny = north[0] * u[0] + north[1] * u[1] + north[2] * u[2];
  const n = Math.hypot(nx, ny) || 1;
  return { x: nx / n, y: -ny / n };
}

export { radecToVec };
