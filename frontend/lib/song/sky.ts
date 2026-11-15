/**
 * Geometry for "Your Sky Song": the zenith (the point straight overhead) and the visible sky of
 * one place and instant. Everything here is COMPUTED (astronomy-engine ephemeris via
 * lib/look/sky.ts) from the date and coordinates; nothing is observed.
 *
 * Stars: Yale Bright Star Catalogue (public/cosmos/bsc5.bin, J2000). Precession and Earth
 * rotation are applied by the EQJ->horizon matrix; proper motion is ignored (< 0.1 deg for
 * naked-eye stars over a human lifetime). Refraction is ignored.
 */
import { loadStarCatalog, type StarCatalog } from '../../components/cosmos/stars';
import { CITIES, type City } from '../look/places';
import { NAMED_STARS } from '../look/stars';
import { bodyRadec, eqjToEnuMatrix, enuToAltAz, enuToRadec, applyM, radecToVec, lstHours, type BodyId, type Place } from '../look/sky';
import { ianaOffsetHours, browserZone, tzOffsetHours } from '../sky/time';

/** IANA zones of the /look city list (display names live in i18n look.cities). */
const CITY_ZONES: Record<string, string> = {
  cdmx: 'America/Mexico_City', gdl: 'America/Mexico_City', mty: 'America/Monterrey', bog: 'America/Bogota',
  lim: 'America/Lima', scl: 'America/Santiago', bue: 'America/Argentina/Buenos_Aires', sao: 'America/Sao_Paulo',
  mad: 'Europe/Madrid', lon: 'Europe/London', nyc: 'America/New_York', lax: 'America/Los_Angeles',
  pas: 'America/Los_Angeles', hou: 'America/Chicago', nbo: 'Africa/Nairobi', tyo: 'Asia/Tokyo', syd: 'Australia/Sydney',
};

export interface SongCity extends City { zone: string }
export const SONG_CITIES: SongCity[] = CITIES.map((c) => ({ ...c, zone: CITY_ZONES[c.id] ?? 'UTC' }));

/** Everything that defines one sky song; serialised into the share URL. */
export interface SongSpec {
  /** The instant, Unix ms (UTC). */
  ms: number;
  lat: number;
  lon: number;
  /** City id from SONG_CITIES, when the place is a preset city. */
  city?: string;
  /** IANA zone used to show local time (city zone, or the browser's zone for GPS). */
  zone?: string;
  /** Free-text place label typed by the user (optional). */
  where?: string;
  dedication: string;
}

export const DEDICATION_MAX = 80;
export const WHERE_MAX = 40;

/** UTC offset (hours) to display local wall time for a spec. */
export function specOffsetHours(s: Pick<SongSpec, 'zone' | 'lon' | 'ms'>): number {
  if (s.zone) {
    const off = ianaOffsetHours(s.zone, s.ms);
    if (off !== null) return off;
  }
  return tzOffsetHours(s.lon);
}

export function defaultZone(): string | undefined {
  return browserZone() ?? undefined;
}

// --- share URL -------------------------------------------------------------------------------

const iso = (ms: number) => new Date(Math.round(ms / 60000) * 60000).toISOString().replace(':00.000Z', 'Z');

/** Query string (without '?') that reopens the same song. Short enough for a version <= 10 QR. */
export function specToQuery(s: SongSpec): string {
  const p = new URLSearchParams();
  p.set('d', iso(s.ms));
  p.set('lat', s.lat.toFixed(2));
  p.set('lon', s.lon.toFixed(2));
  if (s.city) p.set('c', s.city);
  else if (s.zone) p.set('z', s.zone);
  if (s.where) p.set('w', s.where.slice(0, WHERE_MAX));
  if (s.dedication) p.set('t', s.dedication.slice(0, DEDICATION_MAX));
  return p.toString();
}

export function specFromQuery(q: URLSearchParams): SongSpec | null {
  const d = q.get('d'), lat = Number(q.get('lat')), lon = Number(q.get('lon'));
  if (!d || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const ms = Date.parse(d);
  if (!Number.isFinite(ms)) return null;
  const city = q.get('c') ?? undefined;
  const c = city ? SONG_CITIES.find((x) => x.id === city) : undefined;
  return {
    ms, lat, lon,
    city: c?.id,
    zone: c?.zone ?? q.get('z') ?? undefined,
    where: (q.get('w') ?? '').slice(0, WHERE_MAX) || undefined,
    dedication: (q.get('t') ?? '').slice(0, DEDICATION_MAX),
  };
}

/** Repeatable seed: same date (to the minute) + place -> same song. */
export function specSeed(s: SongSpec): string {
  return `${iso(s.ms)}|${s.lat.toFixed(2)}|${s.lon.toFixed(2)}`;
}

// --- zenith and visible sky -----------------------------------------------------------------

export interface Zenith { ra: number; dec: number; lstH: number }

/** J2000 RA/Dec of the point straight overhead. */
export function zenithOf(place: Place, date: Date): Zenith {
  const m = eqjToEnuMatrix(place, date);
  const { ra, dec } = enuToRadec(m, [0, 0, 1]);
  return { ra, dec, lstH: lstHours(date, place.lon) };
}

export interface SkyStar { alt: number; az: number; v: number; rgb: [number, number, number] }
export interface SkyBody { id: BodyId; alt: number; az: number }
export interface SkyLabel { name: string; alt: number; az: number; v: number }
export interface VisibleSky {
  stars: SkyStar[];
  bodies: SkyBody[];
  labels: SkyLabel[];
  zenith: Zenith;
  /** Sun altitude (deg): > 0 day, < -18 astronomical night. */
  sunAlt: number;
}

let catalogPromise: Promise<StarCatalog> | null = null;
export function starCatalog(): Promise<StarCatalog> {
  if (!catalogPromise) catalogPromise = loadStarCatalog().catch((e) => { catalogPromise = null; throw e; });
  return catalogPromise;
}

const SKY_BODIES: BodyId[] = ['Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'];

export function visibleSky(cat: StarCatalog | null, place: Place, date: Date, maxMag = 6): VisibleSky {
  const m = eqjToEnuMatrix(place, date);
  const stars: SkyStar[] = [];
  if (cat) {
    for (let i = 0; i < cat.n; i++) {
      const v = cat.vmag[i];
      if (v > maxMag) continue;
      const e = applyM(m, radecToVec(cat.ra[i], cat.dec[i]));
      if (e[2] < -0.01) continue;
      const { alt, az } = enuToAltAz(e);
      stars.push({ alt, az, v, rgb: [cat.rgb[i * 3], cat.rgb[i * 3 + 1], cat.rgb[i * 3 + 2]] });
    }
    stars.sort((a, b) => b.v - a.v); // faint first, bright drawn on top
  }
  const bodies: SkyBody[] = [];
  for (const id of SKY_BODIES) {
    const { ra, dec } = bodyRadec(id, date, place);
    const { alt, az } = enuToAltAz(applyM(m, radecToVec(ra, dec)));
    if (alt > 0) bodies.push({ id, alt, az });
  }
  const sun = bodyRadec('Sun', date, place);
  const sunAlt = enuToAltAz(applyM(m, radecToVec(sun.ra, sun.dec))).alt;
  const labels: SkyLabel[] = [];
  for (const s of NAMED_STARS) {
    if (s.v > 1.6) continue;
    const { alt, az } = enuToAltAz(applyM(m, radecToVec(s.ra, s.dec)));
    if (alt > 8) labels.push({ name: s.name, alt, az, v: s.v });
  }
  return { stars, bodies, labels, zenith: zenithOf(place, date), sunAlt };
}

/** Stereographic dome: zenith at the centre, horizon at radius 1, North up, East LEFT (looking up). */
export function domeXY(alt: number, az: number): [number, number] {
  const zd = ((90 - alt) * Math.PI) / 180;
  const r = Math.tan(zd / 2); // = 1 at the horizon
  const a = (az * Math.PI) / 180;
  return [-r * Math.sin(a), -r * Math.cos(a)];
}

// --- formatting -----------------------------------------------------------------------------

const p2 = (n: number) => String(n).padStart(2, '0');

export function formatRaHms(ra: number): string {
  const h = ((ra / 15) % 24 + 24) % 24;
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ss = Math.round(((h - hh) * 60 - mm) * 60);
  return `${p2(hh)}h ${p2(mm)}m ${p2(Math.min(59, ss))}s`;
}

export function formatDecDms(dec: number): string {
  const s = dec < 0 ? '−' : '+', a = Math.abs(dec);
  const d = Math.floor(a), m = Math.floor((a - d) * 60);
  return `${s}${p2(d)}° ${p2(m)}′`;
}

export function formatLatLon(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'} · ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;
}

/** Local wall-clock parts of an instant at a UTC offset. */
export function localParts(ms: number, offH: number) {
  const d = new Date(ms + offH * 3600e3);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

export function localDateInput(ms: number, offH: number): string {
  const p = localParts(ms, offH);
  return `${String(p.y).padStart(4, '0')}-${p2(p.mo)}-${p2(p.d)}`;
}
export function localTimeInput(ms: number, offH: number): string {
  const p = localParts(ms, offH);
  return `${p2(p.h)}:${p2(p.mi)}`;
}

/** Local date ("YYYY-MM-DD") + time ("HH:MM") at a zone/longitude -> instant (two-pass for DST). */
export function inputsToMs(date: string, time: string, zone: string | undefined, lon: number): number | null {
  const dm = /^(-?\d{1,6})-(\d{2})-(\d{2})$/.exec(date), tm = /^(\d{2}):(\d{2})/.exec(time || '00:00');
  if (!dm || !tm) return null;
  const wall = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2]);
  if (!Number.isFinite(wall)) return null;
  let ms = wall - specOffsetHours({ zone, lon, ms: wall }) * 3600e3;
  ms = wall - specOffsetHours({ zone, lon, ms }) * 3600e3;
  return ms;
}

export function formatUtcOffset(h: number): string {
  if (h === 0) return 'UTC';
  const a = Math.abs(h), hh = Math.floor(a), mm = Math.round((a - hh) * 60);
  return `UTC${h > 0 ? '+' : '−'}${hh}${mm ? `:${p2(mm)}` : ''}`;
}
