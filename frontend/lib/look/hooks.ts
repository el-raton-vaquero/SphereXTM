'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { loadStarCatalog } from '../../components/cosmos/stars';
import { CITIES, DEFAULT_CITY, loadPlace, savePlace, type SavedPlace } from './places';
import { radecToVec } from './sky';

const noopSubscribe = () => () => {};

/** false during SSR and the hydration render, true afterwards. */
export function useMounted(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/** BSC5 stars as J2000 unit vectors (V <= maxMag), for fast per-frame rotation. */
export interface StarField { n: number; xyz: Float32Array; vmag: Float32Array }

let fieldPromise: Promise<StarField> | null = null;

function loadField(maxMag: number): Promise<StarField> {
  if (!fieldPromise) {
    fieldPromise = loadStarCatalog().then((cat) => {
      const keep: number[] = [];
      for (let i = 0; i < cat.n; i++) if (cat.vmag[i] <= maxMag) keep.push(i);
      keep.sort((a, b) => cat.vmag[a] - cat.vmag[b]);
      const xyz = new Float32Array(keep.length * 3);
      const vmag = new Float32Array(keep.length);
      keep.forEach((i, k) => {
        const v = radecToVec(cat.ra[i], cat.dec[i]);
        xyz[k * 3] = v[0]; xyz[k * 3 + 1] = v[1]; xyz[k * 3 + 2] = v[2];
        vmag[k] = cat.vmag[i];
      });
      return { n: keep.length, xyz, vmag };
    }).catch((e) => { fieldPromise = null; throw e; });
  }
  return fieldPromise;
}

export function useStarField(maxMag = 5.5): StarField | null {
  const [field, setField] = useState<StarField | null>(null);
  useEffect(() => {
    let alive = true;
    loadField(maxMag).then((f) => { if (alive) setField(f); }).catch(() => { /* labels-only fallback */ });
    return () => { alive = false; };
  }, [maxMag]);
  return field;
}

export type GeoStatus = 'idle' | 'locating' | 'ok' | 'denied' | 'unavailable';

/** Observer location: saved choice, GPS on request, city or typed coordinates. */
export function usePlace() {
  const mounted = useMounted();
  const [chosen, setChosen] = useState<SavedPlace | null>(null);
  const [geo, setGeo] = useState<GeoStatus>('idle');
  const place: SavedPlace = useMemo(
    () => chosen ?? (mounted ? loadPlace() : null) ?? { lat: DEFAULT_CITY.lat, lon: DEFAULT_CITY.lon, source: 'city', cityId: DEFAULT_CITY.id },
    [chosen, mounted],
  );

  const set = useCallback((p: SavedPlace) => { setChosen(p); savePlace(p); }, []);

  const locate = useCallback((): Promise<SavedPlace | null> => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setGeo('unavailable'); return Promise.resolve(null); }
    setGeo('locating');
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const p: SavedPlace = { lat: +pos.coords.latitude.toFixed(4), lon: +pos.coords.longitude.toFixed(4), source: 'gps', accuracyM: pos.coords.accuracy };
          set(p); setGeo('ok'); resolve(p);
        },
        (err) => { setGeo(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'); resolve(null); },
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 },
      );
    });
  }, [set]);

  const setCity = useCallback((id: string) => {
    const c = CITIES.find((x) => x.id === id);
    if (c) set({ lat: c.lat, lon: c.lon, source: 'city', cityId: c.id });
  }, [set]);

  return { place, geo, set, locate, setCity };
}

/** A Date that ticks every `ms` while `live`; otherwise the fixed value. */
export function useClock(live: boolean, fixed: Date | null, ms = 30000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(new Date()), ms);
    const t = setTimeout(() => setNow(new Date()), 0);
    return () => { clearInterval(id); clearTimeout(t); };
  }, [live, ms]);
  return live || !fixed ? now : fixed;
}
