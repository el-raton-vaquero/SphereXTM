/**
 * High-proper-motion challenge targets shown as highlighted markers on /sky.
 * Astrometry copied from server/spherex/data/prism-targets.json (the backend's target registry):
 * Gaia DR3 for Barnard's Star and ε Indi B (epoch J2016.0), SIMBAD / Kirkpatrick et al. 2021
 * (ApJS 253, 7) for WISE 0855−0714 (epoch J2000.0). Positions on /sky are catalogue-predicted
 * with linear proper motion (no radial velocity), never SPHEREx detections.
 */
export interface SkyTarget {
  /** Same ids as the explorer presets (/explore?target=). */
  id: 'barnard' | 'eps-indi-b' | 'wise-0855';
  name: string;
  ra: number; // deg at epoch
  dec: number; // deg at epoch
  epoch: number; // Julian year of ra/dec
  pmRa: number; // mas/yr, μα·cosδ
  pmDec: number; // mas/yr
  /** Visual magnitude if known (null = not visible to the eye at any aperture we model). */
  vmag: number | null;
  source: string;
}

export const SKY_TARGETS: SkyTarget[] = [
  {
    id: 'barnard',
    name: "Barnard's Star",
    ra: 269.44850252543836,
    dec: 4.739420051112412,
    epoch: 2016.0,
    pmRa: -801.5509783684709,
    pmDec: 10362.394206546573,
    vmag: 9.5,
    source: 'Gaia DR3 4472832130942575872',
  },
  {
    id: 'eps-indi-b',
    name: 'Epsilon Indi B',
    ra: 331.07645259656397,
    dec: -56.79381206688221,
    epoch: 2016.0,
    pmRa: 3981.97666296105,
    pmDec: -2466.8318147663504,
    vmag: null,
    source: 'Gaia DR3 6412596012146801152',
  },
  {
    id: 'wise-0855',
    name: 'WISE 0855−0714',
    ra: 133.81890825,
    dec: -7.247048000000001,
    epoch: 2000.0,
    pmRa: -8123.7,
    pmDec: 673.2,
    vmag: null,
    source: 'SIMBAD WISEA J085510.74−071442.5 (Kirkpatrick et al. 2021)',
  },
];

const D = Math.PI / 180;
const MAS = D / 3600 / 1000;

/** EQJ unit vector of a target at Julian year `year` (linear tangent-plane proper motion). */
export function targetVectorAt(t: SkyTarget, year: number, out: number[] = [0, 0, 0]): number[] {
  const a = t.ra * D, d = t.dec * D;
  const ca = Math.cos(a), sa = Math.sin(a), cd = Math.cos(d), sd = Math.sin(d);
  const dt = year - t.epoch;
  const ma = t.pmRa * MAS * dt, md = t.pmDec * MAS * dt;
  const x = cd * ca - sa * ma - sd * ca * md;
  const y = cd * sa + ca * ma - sd * sa * md;
  const z = sd + cd * md;
  const r = Math.hypot(x, y, z) || 1;
  out[0] = x / r;
  out[1] = y / r;
  out[2] = z / r;
  return out;
}

/** Other fast-moving bright stars whose trails are drawn with the challenge targets (BSC HR). */
export const FAST_STAR_HR = [5340, 8085, 2491, 4550] as const; // Arcturus, 61 Cyg A, Sirius, Groombridge 1830
