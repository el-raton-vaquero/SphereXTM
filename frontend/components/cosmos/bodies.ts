import * as Astronomy from 'astronomy-engine';

/**
 * Solar-system bodies for the landing scene, COMPUTED with astronomy-engine
 * (VSOP87 / ELP-based, arc-second level). Positions are geocentric, J2000 (EQJ),
 * with light-time and aberration, so they sit on the same frame as the BSC5 stars.
 * Nothing here is observed data; the UI labels it as computed.
 */

export type BodyId = 'sun' | 'moon' | 'mercury' | 'venus' | 'mars' | 'jupiter' | 'saturn';
export const PLANET_IDS = ['mercury', 'venus', 'mars', 'jupiter', 'saturn'] as const;
export type PlanetId = (typeof PLANET_IDS)[number];

const BODY: Record<BodyId, Astronomy.Body> = {
  sun: Astronomy.Body.Sun,
  moon: Astronomy.Body.Moon,
  mercury: Astronomy.Body.Mercury,
  venus: Astronomy.Body.Venus,
  mars: Astronomy.Body.Mars,
  jupiter: Astronomy.Body.Jupiter,
  saturn: Astronomy.Body.Saturn,
};

const AU_KM = 149597870.7;
const R_SUN_KM = 695700;
const R_MOON_KM = 1737.4;

export interface BodyState {
  id: BodyId;
  ra: number; // deg, J2000
  dec: number; // deg
  distAU: number;
  mag: number; // apparent V magnitude
  diamDeg: number; // apparent angular diameter
  phase: number; // illuminated fraction 0..1 (1 for the Sun)
}

export function bodyState(id: BodyId, date: Date): BodyState {
  const vec = Astronomy.GeoVector(BODY[id], date, true);
  const eq = Astronomy.EquatorFromVector(vec);
  const distAU = eq.dist;
  let mag = -26.74;
  let phase = 1;
  if (id !== 'sun') {
    const il = Astronomy.Illumination(BODY[id], date);
    mag = il.mag;
    phase = il.phase_fraction;
  }
  const rKm = id === 'sun' ? R_SUN_KM : id === 'moon' ? R_MOON_KM : 0;
  const diamDeg = rKm ? ((2 * Math.atan(rKm / (distAU * AU_KM))) * 180) / Math.PI : 0;
  return { id, ra: eq.ra * 15, dec: eq.dec, distAU, mag, diamDeg, phase };
}

export function allBodies(date: Date): BodyState[] {
  return (Object.keys(BODY) as BodyId[]).map((id) => bodyState(id, date));
}

/** Greenwich apparent sidereal time, degrees. */
export function siderealDeg(date: Date): number {
  return Astronomy.SiderealTime(date) * 15;
}

/**
 * Point on Earth with the Sun at the zenith. Uses the J2000 Sun with apparent
 * sidereal time; the ~0.3° precession difference is below what the globe can show.
 */
export function subSolarPoint(sun: { ra: number; dec: number }, date: Date): { lat: number; lon: number } {
  let lon = sun.ra - siderealDeg(date);
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat: sun.dec, lon };
}
