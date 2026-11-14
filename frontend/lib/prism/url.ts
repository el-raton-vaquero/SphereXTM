import type { ViewMode } from './types';

export interface UrlState {
  ra?: number;
  dec?: number;
  fov: number;
  t?: number;      // frame MJD (selected frame = nearest at λ)
  lam?: number;    // µm
  mode: ViewMode;
  target?: string;
  embed: boolean;
  lang: 'es' | 'en';
}

const MODES: ViewMode[] = ['frame', 'coadd', 'diff', 'goggles', 'raw', 'cube'];

export function readUrl(search: string): UrlState {
  const p = new URLSearchParams(search);
  const num = (k: string) => {
    const v = p.get(k);
    if (v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const fov = num('fov');
  const mode = p.get('mode') as ViewMode | null;
  const ra = num('ra'), dec = num('dec');
  const target = p.get('target') ?? undefined;
  return {
    ra: ra !== undefined && ra >= 0 && ra < 360 ? ra : undefined,
    dec: dec !== undefined && dec >= -90 && dec <= 90 ? dec : undefined,
    fov: fov && fov >= 1 && fov <= 20 ? fov : 4,
    t: num('t'),
    lam: num('lam'),
    mode: mode && MODES.includes(mode) ? mode : 'frame',
    target: target && /^[a-z0-9-]{1,40}$/.test(target) ? target : undefined,
    embed: p.get('embed') === '1',
    lang: p.get('lang') === 'en' ? 'en' : 'es',
  };
}

export function writeUrl(s: UrlState): string {
  const p = new URLSearchParams();
  if (s.target) p.set('target', s.target);
  if (s.ra !== undefined) p.set('ra', s.ra.toFixed(5));
  if (s.dec !== undefined) p.set('dec', s.dec.toFixed(5));
  if (s.fov !== 4) p.set('fov', String(s.fov));
  if (s.t !== undefined) p.set('t', s.t.toFixed(4));
  if (s.lam !== undefined) p.set('lam', s.lam.toFixed(4));
  if (s.mode !== 'frame') p.set('mode', s.mode);
  if (s.embed) p.set('embed', '1');
  if (s.lang === 'en') p.set('lang', 'en');
  return p.toString();
}
