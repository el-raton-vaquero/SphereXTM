/**
 * Time, place and preset helpers for the /sky time machine.
 *
 * Instants are plain numbers (Unix ms, UTC). JavaScript dates use the proleptic Gregorian
 * calendar and astronomical year numbering (year 0 = 1 BCE, −2500 = 2501 BCE), which is what
 * astronomy-engine expects. "Local" time is UTC + round(longitude / 15) hours: a stable,
 * approximate local time for any epoch (time zones did not exist in 1326).
 */

export const MS_DAY = 86_400_000;
export const MS_YEAR = 365.25 * MS_DAY;
export const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

const at = (y: number, mo = 1, d = 1, h = 0, mi = 0) => {
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(h, mi, 0, 0);
  return dt.getTime();
};

export const MIN_MS = at(-3000, 1, 1);
export const MAX_MS = at(3000, 12, 31, 23, 59);

export const clampTime = (ms: number) => Math.min(MAX_MS, Math.max(MIN_MS, ms));

/** Julian years since J2000.0 (for proper motion). */
export const yearsSinceJ2000 = (ms: number) => (ms - J2000_MS) / MS_YEAR;
/** Decimal Julian year, e.g. 2026.87. */
export const julianYear = (ms: number) => 2000 + yearsSinceJ2000(ms);

/** Approximate local offset (hours) from longitude. */
export const tzOffsetHours = (lon: number) => Math.max(-12, Math.min(14, Math.round(lon / 15)));

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

export function toLocalParts(ms: number, tz: number): LocalParts {
  const d = new Date(ms + tz * 3_600_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

export function fromLocalParts(p: LocalParts, tz: number): number {
  return at(p.year, p.month, p.day, p.hour, p.minute) - tz * 3_600_000;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** "1326-11-14" / "−2500-03-21" (astronomical year, minus sign U+2212). */
export function formatYear(y: number): string {
  return y < 0 ? `−${String(-y).padStart(4, '0')}` : String(y).padStart(4, '0');
}

export function formatLocalDate(ms: number, tz: number): string {
  const p = toLocalParts(ms, tz);
  return `${formatYear(p.year)}-${p2(p.month)}-${p2(p.day)}`;
}

export function formatLocalTime(ms: number, tz: number): string {
  const p = toLocalParts(ms, tz);
  return `${p2(p.hour)}:${p2(p.minute)}`;
}

export function formatTz(tz: number): string {
  if (tz === 0) return 'UTC';
  return `UTC${tz > 0 ? '+' : '−'}${Math.abs(tz)}`;
}

/** Short tick label for a trail, by span. */
export function formatTick(ms: number, tz: number, spanMs: number): string {
  const p = toLocalParts(ms, tz);
  if (spanMs > 6 * MS_YEAR) return formatYear(p.year);
  if (spanMs > 3 * MS_DAY) return `${formatYear(p.year)}-${p2(p.month)}-${p2(p.day)}`;
  return `${p2(p.month)}-${p2(p.day)} ${p2(p.hour)}:${p2(p.minute)}`;
}

/** Speed presets: simulated seconds per real second. */
export const SPEEDS = [
  { id: 'real', rate: 1 },
  { id: 'hour', rate: 3600 },
  { id: 'day', rate: 86_400 },
  { id: 'month', rate: MS_YEAR / 12 / 1000 },
  { id: 'year', rate: MS_YEAR / 1000 },
  { id: 'century', rate: (100 * MS_YEAR) / 1000 },
] as const;
export type SpeedId = (typeof SPEEDS)[number]['id'];

export interface SkyPlace {
  id: string;
  lat: number;
  lon: number;
  /** Proper name, same in every language. */
  name: string;
}

export const PLACES: SkyPlace[] = [
  { id: 'cdmx', name: 'Mexico City', lat: 19.4326, lon: -99.1332 },
  { id: 'guadalajara', name: 'Guadalajara', lat: 20.6597, lon: -103.3496 },
  { id: 'bogota', name: 'Bogotá', lat: 4.711, lon: -74.0721 },
  { id: 'buenos-aires', name: 'Buenos Aires', lat: -34.6037, lon: -58.3816 },
  { id: 'madrid', name: 'Madrid', lat: 40.4168, lon: -3.7038 },
  { id: 'new-york', name: 'New York', lat: 40.7128, lon: -74.006 },
  { id: 'pasadena', name: 'Pasadena (IPAC)', lat: 34.1478, lon: -118.1445 },
  { id: 'london', name: 'London (Greenwich)', lat: 51.4769, lon: -0.0005 },
  { id: 'giza', name: 'Giza', lat: 29.9792, lon: 31.1342 },
  { id: 'kaifeng', name: 'Kaifeng', lat: 34.7972, lon: 114.3076 },
  { id: 'padua', name: 'Padua', lat: 45.4064, lon: 11.8768 },
  { id: 'tenochtitlan', name: 'Tenochtitlan / Mexico City', lat: 19.4352, lon: -99.1312 },
  { id: 'chichen-itza', name: 'Chichén Itzá', lat: 20.6843, lon: -88.5678 },
  { id: 'sydney', name: 'Sydney', lat: -33.8688, lon: 151.2093 },
  { id: 'tokyo', name: 'Tokyo', lat: 35.6762, lon: 139.6503 },
];

export const DEFAULT_PLACE = PLACES[0];

/** Epoch presets. `local` is local (UTC+round(lon/15)) wall time at the preset's place. */
export interface SkyEpoch {
  id: 'now' | 'ago700' | 'pyramids' | 'sn1054' | 'galileo' | 'year1' | 'future3000';
  /** Place to move to (undefined = keep the current place). */
  place?: string;
  /** Local date/time, or a function of "now". */
  local?: LocalParts;
  /** Look direction to set (deg), optional. */
  look?: { az: number; alt: number };
  /** Object to select, optional. */
  select?: string;
}

export const EPOCHS: SkyEpoch[] = [
  { id: 'now' },
  { id: 'ago700' },
  { id: 'pyramids', place: 'giza', local: { year: -2500, month: 3, day: 21, hour: 21, minute: 0 }, look: { az: 0, alt: 28 }, select: 'star:Thuban' },
  // 4 July 1054 (Julian) = 10 July 1054 proleptic Gregorian; the "guest star" was seen before dawn.
  { id: 'sn1054', place: 'kaifeng', local: { year: 1054, month: 7, day: 10, hour: 4, minute: 30 }, look: { az: 75, alt: 15 }, select: 'mark:sn1054' },
  // 7 January 1610 (Gregorian, in use in Padua): Galileo first sees Jupiter's moons.
  { id: 'galileo', place: 'padua', local: { year: 1610, month: 1, day: 7, hour: 19, minute: 0 }, look: { az: 95, alt: 35 }, select: 'body:Jupiter' },
  { id: 'year1', local: { year: 1, month: 3, day: 21, hour: 21, minute: 0 } },
  { id: 'future3000', local: { year: 3000, month: 6, day: 21, hour: 22, minute: 0 } },
];

/** Historical markers shown only around their epoch (position = remnant today). */
export const HISTORIC_MARKS = [
  // Crab Nebula (M1), remnant of SN 1054: SIMBAD J2000 05h34m31.9s +22d00m52s.
  { id: 'sn1054', ra: 83.6331, dec: 22.0145, fromYear: 1054.4, toYear: 1056.4 },
] as const;
