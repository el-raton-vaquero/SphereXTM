/**
 * Sky geometry for /look: horizon <-> J2000 equatorial conversions, Sun/Moon/planet positions,
 * rise/set and transit times. Everything here is COMPUTED (astronomy-engine, MIT) from the
 * observer's location and the clock; nothing is observed. Refraction is ignored (it lifts
 * objects by ~0.5 deg at the horizon), which is well inside the error of phone sensors.
 *
 * Local frame used throughout /look: ENU unit vectors, x = East, y = North, z = Up.
 * Azimuth is measured from North through East (0..360), altitude from the horizon (-90..90).
 */
import * as Astronomy from 'astronomy-engine';

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

export type V3 = [number, number, number];
export interface Place { lat: number; lon: number; label?: string }
export interface AltAz { alt: number; az: number }
export interface RaDec { ra: number; dec: number }

export const norm360 = (a: number) => ((a % 360) + 360) % 360;

/** 3x3 matrix stored row-major as V3[3]. */
export type M3 = [V3, V3, V3];

const mul = (m: M3, v: V3): V3 => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

export function radecToVec(ra: number, dec: number): V3 {
  const a = ra * D2R, d = dec * D2R;
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}

export function vecToRadec(v: V3): RaDec {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return { ra: norm360(Math.atan2(v[1], v[0]) * R2D), dec: Math.asin(Math.max(-1, Math.min(1, v[2] / n))) * R2D };
}

export function enuToAltAz(v: V3): AltAz {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return { alt: Math.asin(Math.max(-1, Math.min(1, v[2] / n))) * R2D, az: norm360(Math.atan2(v[0], v[1]) * R2D) };
}

export function altAzToEnu(alt: number, az: number): V3 {
  const a = alt * D2R, z = az * D2R;
  return [Math.cos(a) * Math.sin(z), Math.cos(a) * Math.cos(z), Math.sin(a)];
}

/**
 * EQJ (J2000 equatorial) -> ENU rotation for a place and time. astronomy-engine's HOR frame is
 * (x=North, y=West, z=Zenith); ENU = (-y, x, z). Includes precession, nutation and Earth rotation.
 */
export function eqjToEnuMatrix(place: Place, date: Date): M3 {
  const r = Astronomy.Rotation_EQJ_HOR(date, new Astronomy.Observer(place.lat, place.lon, 0)).rot;
  // astronomy-engine stores rot[i][j] such that out[j] = sum_i rot[i][j] * in[i]
  const hor = (j: number): V3 => [r[0][j], r[1][j], r[2][j]];
  const N = hor(0), W = hor(1), Z = hor(2);
  return [[-W[0], -W[1], -W[2]], N, Z];
}

/** Transpose (inverse of a rotation). */
export function transpose(m: M3): M3 {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

export function eqjToEnu(m: M3, ra: number, dec: number): V3 {
  return mul(m, radecToVec(ra, dec));
}

export function enuToRadec(m: M3, v: V3): RaDec {
  return vecToRadec(mul(transpose(m), v));
}

export function applyM(m: M3, v: V3): V3 {
  return mul(m, v);
}

/** Local apparent sidereal time, hours. */
export function lstHours(date: Date, lon: number): number {
  return (((Astronomy.SiderealTime(date) + lon / 15) % 24) + 24) % 24;
}

export type BodyId = 'Sun' | 'Moon' | 'Mercury' | 'Venus' | 'Mars' | 'Jupiter' | 'Saturn' | 'Uranus' | 'Neptune';
export const BODIES: BodyId[] = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];

export interface BodyState {
  id: BodyId;
  ra: number; // deg, J2000, topocentric
  dec: number;
  alt: number;
  az: number;
  mag: number | null;
  phase: number | null; // illuminated fraction (Moon/planets)
  rise: Date | null;
  set: Date | null;
}

/** Topocentric J2000 position of a solar-system body. */
export function bodyRadec(id: BodyId, date: Date, place: Place): RaDec {
  const eq = Astronomy.Equator(Astronomy.Body[id], date, new Astronomy.Observer(place.lat, place.lon, 0), false, true);
  return { ra: norm360(eq.ra * 15), dec: eq.dec };
}

export function bodyStates(date: Date, place: Place, withRiseSet = true): BodyState[] {
  const obs = new Astronomy.Observer(place.lat, place.lon, 0);
  const m = eqjToEnuMatrix(place, date);
  const start = new Date(date.getTime() - 12 * 3600e3);
  return BODIES.map((id) => {
    const { ra, dec } = bodyRadec(id, date, place);
    const { alt, az } = enuToAltAz(eqjToEnu(m, ra, dec));
    let mag: number | null = null, phase: number | null = null;
    try {
      const il = Astronomy.Illumination(Astronomy.Body[id], date);
      mag = il.mag;
      phase = id === 'Sun' ? null : il.phase_fraction;
    } catch { /* not defined for every body */ }
    let rise: Date | null = null, set: Date | null = null;
    if (withRiseSet) {
      // Next rise / set within a day of "12 h ago", so a body that rose this morning still shows it.
      try { rise = Astronomy.SearchRiseSet(Astronomy.Body[id], obs, +1, start, 1.5)?.date ?? null; } catch { rise = null; }
      try { set = Astronomy.SearchRiseSet(Astronomy.Body[id], obs, -1, start, 1.5)?.date ?? null; } catch { set = null; }
    }
    return { id, ra, dec, alt, az, mag, phase, rise, set };
  });
}

/**
 * Next upper transit of a fixed (RA, Dec) after `date`, and its altitude there. Approximate:
 * mean sidereal rate, J2000 coordinates, no refraction.
 */
export function nextTransit(ra: number, dec: number, date: Date, place: Place): { time: Date; maxAlt: number; circumpolar: boolean; neverRises: boolean } {
  const lst = lstHours(date, place.lon);
  let dh = (ra / 15 - lst) % 24;
  if (dh < 0) dh += 24;
  const time = new Date(date.getTime() + dh * 0.99726957 * 3600e3);
  const maxAlt = 90 - Math.abs(place.lat - dec);
  const circumpolar = place.lat >= 0 ? dec > 90 - place.lat : dec < -90 - place.lat;
  const neverRises = maxAlt < 0;
  return { time, maxAlt, circumpolar, neverRises };
}

/** Angular separation in degrees. */
export function sepDeg(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const a = radecToVec(ra1, dec1), b = radecToVec(ra2, dec2);
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.max(-1, Math.min(1, d))) * R2D;
}

/** 8-point compass label index for an azimuth (0 = N, 1 = NE, ...). */
export function compassIndex(az: number): number {
  return Math.round(norm360(az) / 45) % 8;
}
