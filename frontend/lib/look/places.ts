/**
 * A few cities for users who do not want to share their location. Coordinates rounded to
 * 0.01 deg (city centres); good enough for a sky chart. Display names live in the i18n
 * dictionaries (look.cities, keyed by id).
 */
import type { Place } from './sky';

export interface City extends Place { id: string }

export const CITIES: City[] = [
  { id: 'cdmx', lat: 19.43, lon: -99.13 },
  { id: 'gdl', lat: 20.67, lon: -103.35 },
  { id: 'mty', lat: 25.69, lon: -100.32 },
  { id: 'bog', lat: 4.71, lon: -74.07 },
  { id: 'lim', lat: -12.05, lon: -77.04 },
  { id: 'scl', lat: -33.45, lon: -70.67 },
  { id: 'bue', lat: -34.6, lon: -58.38 },
  { id: 'sao', lat: -23.55, lon: -46.63 },
  { id: 'mad', lat: 40.42, lon: -3.7 },
  { id: 'lon', lat: 51.51, lon: -0.13 },
  { id: 'nyc', lat: 40.71, lon: -74.01 },
  { id: 'lax', lat: 34.05, lon: -118.24 },
  { id: 'pas', lat: 34.2, lon: -118.17 },
  { id: 'hou', lat: 29.76, lon: -95.37 },
  { id: 'nbo', lat: -1.29, lon: 36.82 },
  { id: 'tyo', lat: 35.68, lon: 139.69 },
  { id: 'syd', lat: -33.87, lon: 151.21 },
];

export const DEFAULT_CITY = CITIES[0];

/** Stored location: either a city id or a raw lat/lon (from the GPS or typed in). */
export interface SavedPlace extends Place { source: 'gps' | 'city' | 'manual'; cityId?: string; accuracyM?: number }

const KEY = 'starchord.look.place';

export function loadPlace(): SavedPlace | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (Number.isFinite(p?.lat) && Number.isFinite(p?.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180) {
      return { lat: p.lat, lon: p.lon, source: p.source === 'gps' || p.source === 'city' ? p.source : 'manual', cityId: typeof p.cityId === 'string' ? p.cityId : undefined };
    }
  } catch { /* storage blocked */ }
  return null;
}

export function savePlace(p: SavedPlace) {
  try { window.localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage blocked */ }
}
