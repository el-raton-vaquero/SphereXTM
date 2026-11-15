'use client';

/**
 * /sky — sky time machine. Full-screen computed planetarium (lib/sky/engine.ts) with time
 * controls, epochs ("700 years ago"), trajectories, place picker, VR / Cardboard / motion look.
 *
 * Everything on this page is COMPUTED (ephemeris + proper-motion model), never SPHEREx data;
 * the provenance strip under the header says so permanently.
 *
 * Star-symphony mount point: <div data-symphony-slot /> in the side panel. The symphony feature
 * (lib/symphony) can portal its controls into it and read the visible sky with
 * subscribeVisibleSky() from lib/sky (colour-based approximation, label t.sky.bandsLabel).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as Astro from 'astronomy-engine';
import { useLocale, withLang } from '../../lib/i18n';
import SiteHeader from '../site/SiteHeader';
import { formatDec, formatRA } from '../cosmos/astro';
import { writeUrl } from '../../lib/prism/url';
import { loadSkyCatalog } from '../../lib/sky/catalog';
import type { SkyEngine, SkyLayers, SkyNames, SelectionInfo } from '../../lib/sky/engine';
import { requestOrientationPermission } from '../../lib/sky/orientation';
import {
  DEFAULT_PLACE,
  EPOCHS,
  MS_YEAR,
  PLACES,
  SPEEDS,
  clampTime,
  formatLocalDate,
  formatLocalTime,
  formatTz,
  formatYear,
  fromLocalParts,
  toLocalParts,
  tzOffsetHours,
  type SkyEpoch,
  type SpeedId,
} from '../../lib/sky/time';
import './sky.css';

type Status = 'loading' | 'ready' | 'error' | 'nowebgl';
type Mode = 'normal' | 'motion' | 'cardboard' | 'xr';

interface Place {
  id: string; // PLACES id, 'geo' or 'custom'
  name: string;
  lat: number;
  lon: number;
}

const DEFAULT_LAYERS: SkyLayers = {
  ground: true,
  atmosphere: true,
  grid: false,
  cardinals: true,
  constellations: true,
  labels: true,
  trails: false,
  targets: true,
};

const noop = () => () => {};
const useCoarsePointer = () =>
  useSyncExternalStore(noop, () => window.matchMedia('(pointer: coarse)').matches, () => false);

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

function sunAltitude(ms: number, lat: number, lon: number): number {
  const obs = new Astro.Observer(lat, lon, 0);
  const d = new Date(ms);
  const eq = Astro.Equator(Astro.Body.Sun, d, obs, true, true);
  return Astro.Horizon(d, obs, eq.ra, eq.dec).altitude;
}

/** Initial state from the URL (?t=unix-ms&lat=&lon=&epoch=). */
function readSkyUrl(): { t?: number; lat?: number; lon?: number; epoch?: string; speed?: SpeedId; trails?: boolean; select?: string } {
  if (typeof window === 'undefined') return {};
  const p = new URLSearchParams(window.location.search);
  const num = (k: string) => {
    const v = p.get(k);
    if (v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const lat = num('lat');
  const lon = num('lon');
  return {
    t: num('t'),
    lat: lat !== undefined && Math.abs(lat) <= 90 ? lat : undefined,
    lon: lon !== undefined && Math.abs(lon) <= 180 ? lon : undefined,
    epoch: p.get('epoch') ?? undefined,
    speed: SPEEDS.some((s) => s.id === p.get('speed')) ? (p.get('speed') as SpeedId) : undefined,
    trails: p.get('trails') === '1' ? true : undefined,
    select: /^(body|target|star|mark):[A-Za-z0-9 '-]{1,40}$/.test(p.get('select') ?? '') ? (p.get('select') as string) : undefined,
  };
}

function writeSkyUrl(t: number, place: Place, epoch: string | null) {
  const url = new URL(window.location.href);
  url.searchParams.set('t', String(Math.round(t)));
  url.searchParams.set('lat', place.lat.toFixed(3));
  url.searchParams.set('lon', place.lon.toFixed(3));
  if (epoch && epoch !== 'now') url.searchParams.set('epoch', epoch);
  else url.searchParams.delete('epoch');
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
}

// ---------------------------------------------------------------- icons (inline, stroke)
const Icon = ({ d, label }: { d: string; label?: string }) => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const I_PLAY = 'M6 4.5v11l9-5.5z';
const I_PAUSE = 'M7 4.5v11M13 4.5v11';
const I_REV = 'M9 5l-5 5 5 5M16 5l-5 5 5 5';
const I_FWD = 'M11 5l5 5-5 5M4 5l5 5-5 5';
const I_PLUS = 'M10 4v12M4 10h12';
const I_MINUS = 'M4 10h12';
const I_GEAR = 'M3 6h14M3 14h14M7 3.5v5M13 11.5v5';
const I_CLOSE = 'M5 5l10 10M15 5L5 15';

export default function SkyApp() {
  const { locale, t: all } = useLocale();
  const t = all.sky;
  const coarse = useCoarsePointer();
  // Time, place and URL-derived state differ between the static prerender and the client:
  // the overlay renders only after hydration (the canvas stage is always there).
  const mounted = useSyncExternalStore(noop, () => true, () => false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<SkyEngine | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  const initial = useMemo(() => readSkyUrl(), []);
  const [place, setPlaceState] = useState<Place>(() => {
    if (initial.lat !== undefined && initial.lon !== undefined) {
      const { lat, lon } = initial;
      const known = PLACES.find((p) => Math.abs(p.lat - lat) < 0.02 && Math.abs(p.lon - lon) < 0.02);
      return known ? { id: known.id, name: known.name, lat: known.lat, lon: known.lon } : { id: 'custom', name: '', lat, lon };
    }
    return { id: DEFAULT_PLACE.id, name: DEFAULT_PLACE.name, lat: DEFAULT_PLACE.lat, lon: DEFAULT_PLACE.lon };
  });
  const tz = tzOffsetHours(place.lon);
  const [timeMs, setTimeMs] = useState<number>(() => clampTime(initial.t ?? Date.now()));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<SpeedId>(() => initial.speed ?? 'hour');
  const [dir, setDir] = useState<1 | -1>(1);
  const [layers, setLayers] = useState<SkyLayers>(() => (initial.trails ? { ...DEFAULT_LAYERS, trails: true } : DEFAULT_LAYERS));
  const [info, setInfo] = useState<SelectionInfo | null>(null);
  const [epoch, setEpoch] = useState<string | null>(initial.epoch ?? null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('normal');
  const [look, setLook] = useState({ az: 180, alt: 25, fov: 70 });
  const [geo, setGeo] = useState<'idle' | 'busy' | 'ok' | 'denied'>('idle');
  const [sensorMsg, setSensorMsg] = useState<string | null>(null);
  const [xrSupported, setXrSupported] = useState(false);
  const [headingAbs, setHeadingAbs] = useState(true);
  const [wallNow, setWallNow] = useState(() => Date.now());
  const applyEpochRef = useRef<((e: SkyEpoch) => void) | null>(null);
  const [draft, setDraft] = useState<{ year: string; month: string; day: string; time: string } | null>(null);
  const [latDraft, setLatDraft] = useState<string | null>(null);
  const [lonDraft, setLonDraft] = useState<string | null>(null);

  const placeRef = useRef(place);
  useEffect(() => {
    placeRef.current = place;
  }, [place]);

  const names: SkyNames = useMemo(
    () => ({ bodies: t.bodies, cardinals: t.cardinals, ncp: t.ncp, scp: t.scp, marks: t.marks }),
    [t],
  );
  const namesRef = useRef(names);
  useEffect(() => {
    namesRef.current = names;
    engineRef.current?.setNames(names);
  }, [names]);

  // ---------------------------------------------------------------- engine boot
  useEffect(() => {
    if (!hasWebGL()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time capability probe on mount
      setStatus('nowebgl');
      return;
    }
    const ac = new AbortController();
    let engine: SkyEngine | null = null;
    (async () => {
      try {
        const [cat, mod, consts] = await Promise.all([
          loadSkyCatalog(ac.signal),
          import('../../lib/sky/engine'),
          fetch('/sky/constellations.json', { signal: ac.signal })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null) as Promise<{ lines: Record<string, number[]> } | null>,
        ]);
        if (ac.signal.aborted || !canvasRef.current || !labelsRef.current) return;
        engine = new mod.SkyEngine(canvasRef.current, labelsRef.current, cat, namesRef.current, {
          onTime: (ms, p) => {
            setTimeMs(ms);
            setPlaying(p);
            const wall = Date.now();
            setWallNow((prev) => (Math.abs(wall - prev) > 30_000 ? wall : prev));
          },
          onSelect: setInfo,
          onLook: (az, alt, fov) => {
            setLook({ az, alt, fov });
            if (engine) setHeadingAbs(engine.headingAbsolute);
          },
          onModeChange: setMode,
        });
        if (consts?.lines) {
          const flat = Object.values(consts.lines).flat();
          engine.setConstellations(Uint16Array.from(flat.filter((i) => i >= 0 && i < cat.n)));
        }
        const pl = placeRef.current;
        engine.setLocation(pl.lat, pl.lon);
        engine.setTime(clampTime(initial.t ?? Date.now()));
        engine.look(pl.lat >= 0 ? 180 : 0, 22, true);
        engineRef.current = engine;
        if (process.env.NODE_ENV !== 'production') (window as unknown as { __skyEngine?: SkyEngine }).__skyEngine = engine; // dev-only debugging handle
        setStatus('ready');
        // ?epoch= (without an explicit ?t=) opens straight on that preset.
        const ep = EPOCHS.find((x) => x.id === initial.epoch);
        if (ep && ep.id !== 'now' && initial.t === undefined) applyEpochRef.current?.(ep);
        if (initial.select) engine.select(initial.select, true);
      } catch (e) {
        if (ac.signal.aborted) return;
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setStatus('error');
      }
    })();
    return () => {
      ac.abort();
      engine?.dispose();
      engineRef.current = null;
    };
  }, [initial]);

  // push UI state into the engine
  useEffect(() => {
    engineRef.current?.setLayers(layers);
  }, [layers, status]);
  useEffect(() => {
    const rate = (SPEEDS.find((s) => s.id === speed)?.rate ?? 1) * dir;
    engineRef.current?.setRate(rate);
  }, [speed, dir, status]);
  useEffect(() => {
    engineRef.current?.setLocation(place.lat, place.lon);
  }, [place, status]);

  // Keep the optical centre in the unobstructed part of the canvas.
  const topRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (status !== 'ready' || !mounted) return;
    const update = () => {
      const e = engineRef.current;
      if (!e) return;
      const panel = panelRef.current;
      const panelDocked = panel && getComputedStyle(panel).position !== 'fixed';
      e.setViewInsets(topRef.current?.offsetHeight ?? 0, dockRef.current?.offsetHeight ?? 0, 0, panelDocked ? panel.offsetWidth : 0);
    };
    update();
    const ro = new ResizeObserver(update);
    [topRef.current, dockRef.current, panelRef.current].forEach((el) => el && ro.observe(el));
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [status, mounted]);

  // URL sync (when paused, to keep history quiet)
  useEffect(() => {
    if (status !== 'ready' || playing) return;
    const id = window.setTimeout(() => writeSkyUrl(timeMs, place, epoch), 400);
    return () => window.clearTimeout(id);
  }, [timeMs, place, epoch, playing, status]);

  // WebXR availability
  useEffect(() => {
    const xr = (navigator as Navigator & { xr?: { isSessionSupported: (m: string) => Promise<boolean> } }).xr;
    if (!xr) return;
    xr.isSessionSupported('immersive-vr').then(setXrSupported).catch(() => setXrSupported(false));
  }, []);

  // ---------------------------------------------------------------- actions
  const togglePlay = useCallback(() => {
    const e = engineRef.current;
    if (!e) return;
    e.setPlaying(!playing);
    setEpoch(null);
  }, [playing]);

  const jumpTo = useCallback((ms: number) => {
    engineRef.current?.setTime(ms);
    setDraft(null);
  }, []);

  const setPlace = useCallback((p: Place) => {
    setPlaceState(p);
    setLatDraft(null);
    setLonDraft(null);
  }, []);

  const applyEpoch = useCallback(
    (e: SkyEpoch) => {
      const eng = engineRef.current;
      if (!eng) return;
      let pl = placeRef.current;
      if (e.place) {
        const p = PLACES.find((x) => x.id === e.place);
        if (p) {
          pl = { id: p.id, name: p.name, lat: p.lat, lon: p.lon };
          setPlace(pl);
          eng.setLocation(pl.lat, pl.lon);
        }
      }
      const zone = tzOffsetHours(pl.lon);
      let ms: number;
      if (e.id === 'now') ms = Date.now();
      else if (e.id === 'ago700') {
        const parts = toLocalParts(Date.now(), zone);
        parts.year -= 700;
        ms = fromLocalParts(parts, zone);
        // Show the night sky: if the Sun is up at this hour, move to 22:00 local that day.
        if (sunAltitude(ms, pl.lat, pl.lon) > -6) ms = fromLocalParts({ ...parts, hour: 22, minute: 0 }, zone);
      } else if (e.local) ms = fromLocalParts(e.local, zone);
      else ms = Date.now();
      eng.setPlaying(false);
      eng.setTime(ms);
      setDraft(null);
      if (e.select) eng.select(e.select, true);
      else if (e.look) eng.look(e.look.az, e.look.alt);
      setEpoch(e.id);
    },
    [setPlace],
  );

  useEffect(() => {
    applyEpochRef.current = applyEpoch;
  }, [applyEpoch]);

  const locate = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setGeo('denied');
      return;
    }
    setGeo('busy');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Math.round(pos.coords.latitude * 100) / 100;
        const lon = Math.round(pos.coords.longitude * 100) / 100;
        setPlace({ id: 'geo', name: '', lat, lon });
        setGeo('ok');
      },
      () => setGeo('denied'),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  }, [setPlace]);

  const startMotion = useCallback(async () => {
    const ok = await requestOrientationPermission();
    if (!ok) {
      setSensorMsg(t.sensorDenied);
      return;
    }
    setSensorMsg(null);
    engineRef.current?.setMotion(true);
  }, [t.sensorDenied]);

  const startCardboard = useCallback(async () => {
    const ok = await requestOrientationPermission();
    if (!ok) {
      setSensorMsg(t.sensorDenied);
      return;
    }
    setSensorMsg(null);
    try {
      await document.documentElement.requestFullscreen?.();
      const so = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      await so.lock?.('landscape').catch(() => undefined);
    } catch {
      /* fullscreen or orientation lock refused: stereo still works */
    }
    engineRef.current?.setCardboard(true);
    setPanelOpen(false);
  }, [t.sensorDenied]);

  const stopImmersive = useCallback(() => {
    const e = engineRef.current;
    if (!e) return;
    if (e.currentMode === 'cardboard') {
      e.setCardboard(false);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    } else if (e.currentMode === 'motion') e.setMotion(false);
    else if (e.currentMode === 'xr') e.exitXR();
  }, []);

  // ---------------------------------------------------------------- pointer + keyboard
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragRef = useRef<{ x: number; y: number; moved: boolean; pinch: number | null }>({ x: 0, y: 0, moved: false, pinch: null });

  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    ev.currentTarget.setPointerCapture(ev.pointerId);
    pointers.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const d = dragRef.current;
    if (pointers.current.size === 1) {
      d.x = ev.clientX;
      d.y = ev.clientY;
      d.moved = false;
      d.pinch = null;
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      d.pinch = Math.hypot(a.x - b.x, a.y - b.y);
      d.moved = true;
    }
  };
  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointers.current.has(ev.pointerId)) return;
    pointers.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const d = dragRef.current;
    const e = engineRef.current;
    if (!e) return;
    if (pointers.current.size === 2 && d.pinch) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist > 0) e.zoom(d.pinch / dist);
      d.pinch = dist;
      return;
    }
    if (mode !== 'normal') return;
    const dx = ev.clientX - d.x;
    const dy = ev.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    e.dragBy(dx, dy);
    d.x = ev.clientX;
    d.y = ev.clientY;
  };
  const onPointerUp = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const wasSingle = pointers.current.size === 1;
    pointers.current.delete(ev.pointerId);
    const d = dragRef.current;
    if (wasSingle && !d.moved) {
      const r = ev.currentTarget.getBoundingClientRect();
      engineRef.current?.pick(ev.clientX - r.left, ev.clientY - r.top);
    }
    if (pointers.current.size < 2) d.pinch = null;
  };

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      engineRef.current?.zoom(Math.exp(ev.deltaY * 0.0012));
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      if (el && (el.closest('input, select, textarea, button, a, [contenteditable]') || el.isContentEditable)) return;
      const e = engineRef.current;
      if (!e) return;
      const step = Math.max(1, look.fov / 12);
      switch (ev.key) {
        case 'ArrowLeft': e.pan(-step, 0); break;
        case 'ArrowRight': e.pan(step, 0); break;
        case 'ArrowUp': e.pan(0, step); break;
        case 'ArrowDown': e.pan(0, -step); break;
        case '+': case '=': e.zoom(0.85); break;
        case '-': case '_': e.zoom(1 / 0.85); break;
        case ' ': togglePlay(); break;
        case 'Escape':
          if (mode !== 'normal') stopImmersive();
          else if (info) e.select(null);
          else setPanelOpen(false);
          break;
        default: return;
      }
      ev.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [look.fov, togglePlay, mode, info, stopImmersive]);

  // ---------------------------------------------------------------- derived display
  const parts = toLocalParts(timeMs, tz);
  const relYears = (timeMs - wallNow) / MS_YEAR;
  const dateShown = draft ?? {
    year: String(parts.year),
    month: String(parts.month),
    day: String(parts.day),
    time: formatLocalTime(timeMs, tz),
  };
  const editDraft = (k: 'year' | 'month' | 'day' | 'time', v: string) => setDraft({ ...dateShown, [k]: v });
  const applyDraft = (ev: React.FormEvent) => {
    ev.preventDefault();
    const y = Math.round(Number(dateShown.year));
    const mo = Math.min(12, Math.max(1, Math.round(Number(dateShown.month))));
    const d = Math.min(31, Math.max(1, Math.round(Number(dateShown.day))));
    const [hh, mm] = dateShown.time.split(':').map((x) => Number(x));
    if (!Number.isFinite(y)) return;
    jumpTo(clampTime(fromLocalParts({ year: Math.max(-3000, Math.min(3000, y)), month: mo, day: d, hour: Number.isFinite(hh) ? hh : 0, minute: Number.isFinite(mm) ? mm : 0 }, tz)));
    setEpoch(null);
  };

  const placeName = place.id === 'geo' ? t.useMyLocation : place.id === 'custom' ? t.customPlace : place.name;
  const compass = t.compass[Math.round(look.az / 45) % 8];
  const ago700Year = formatYear(toLocalParts(wallNow, tz).year - 700);
  const epochNote = epoch ? t.epochNotes[epoch] : null;

  const explorerHref = (s: SelectionInfo) => {
    const q = s.targetId
      ? writeUrl({ target: s.targetId, fov: 4, mode: 'frame', embed: false })
      : writeUrl({ ra: s.raLink, dec: s.decLink, fov: 4, mode: 'frame', embed: false });
    return withLang(`/explore?${q}`, locale);
  };

  const fmtDeg = (v: number, d = 1) => `${v.toFixed(d)}°`;

  // ---------------------------------------------------------------- render
  return (
    <div className={`sky-root${mode === 'cardboard' ? ' is-cardboard' : ''}`}>
      <div className="sky-stage">
        <canvas
          ref={canvasRef}
          className="sky-canvas"
          tabIndex={0}
          aria-label={t.canvasLabel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        <div ref={labelsRef} className="sky-labels" aria-hidden="true" />
        {status === 'loading' && <p className="sky-status p-data">{t.loading}</p>}
        {status === 'error' && <p className="sky-status sky-status-bad" role="alert">{t.error} {errorMsg}</p>}
        {status === 'nowebgl' && <p className="sky-status sky-status-bad" role="alert">{t.noWebgl}</p>}
      </div>

      {mode === 'cardboard' && (
        <div className="sky-cardboard-ui">
          <p className="sky-landscape-hint">{t.landscapeHint}</p>
          <button type="button" className="sky-btn sky-btn-solid" onClick={stopImmersive}>{t.cardboardExit}</button>
        </div>
      )}

      {mounted && <div className="sky-ui">
      <div ref={topRef} className="sky-top">
        <SiteHeader current="sky" />
        <div className="sky-prov" role="note">
          <span className="sky-prov-dot" aria-hidden="true" />
          <span className="sky-prov-text">{t.provenance}</span>
          <span className="sky-prov-look p-data">
            {t.look} {compass} {Math.round(look.az)}° · {t.altLabel} {Math.round(look.alt)}° · {t.fieldLabel} {Math.round(look.fov)}°
          </span>
        </div>
      </div>

      <div className="sky-main">
      <span className="sky-zoom">
        <button type="button" className="sky-icon-btn" onClick={() => engineRef.current?.zoom(0.8)} aria-label={t.zoomIn} title={t.zoomIn}><Icon d={I_PLUS} /></button>
        <button type="button" className="sky-icon-btn" onClick={() => engineRef.current?.zoom(1.25)} aria-label={t.zoomOut} title={t.zoomOut}><Icon d={I_MINUS} /></button>
      </span>
      {info && (
        <section className="sky-sel" aria-label={t.selected} aria-live="polite">
          <header className="sky-sel-h">
            <div>
              <p className="p-label">{t.kinds[info.kind]}</p>
              <h2 className="sky-sel-name p-display">{info.name}</h2>
            </div>
            <button type="button" className="sky-icon-btn" onClick={() => engineRef.current?.select(null)} aria-label={t.clear} title={t.clear}>
              <Icon d={I_CLOSE} />
            </button>
          </header>
          <dl className="sky-sel-dl">
            <dt>{t.ofDate}</dt>
            <dd className="p-data">{formatRA(info.raDate)} {formatDec(info.decDate)}</dd>
            <dt>{t.altaz}</dt>
            <dd className="p-data">
              {fmtDeg(info.alt)} / {fmtDeg(info.az)}
              {info.alt < 0 && <span className="sky-muted"> · {t.belowHorizon}</span>}
            </dd>
            {info.vmag !== null && (
              <>
                <dt>{t.magnitude}</dt>
                <dd className="p-data">{info.vmag.toFixed(1)}</dd>
              </>
            )}
            {info.pm !== null && (
              <>
                <dt>{t.pm}</dt>
                <dd className="p-data">{info.pm.toFixed(2)}{t.arcsecYr}</dd>
              </>
            )}
            {info.distAu !== null && (
              <>
                <dt>{t.distance}</dt>
                <dd className="p-data">
                  {info.id === 'Moon' ? `${Math.round(info.distAu * 149597870.7).toLocaleString(locale)} km` : `${info.distAu.toFixed(3)} ${t.au}`}
                </dd>
              </>
            )}
            {info.phase !== null && (
              <>
                <dt>{t.phase}</dt>
                <dd className="p-data">
                  {Math.round(info.phase * 100)}%
                  {info.moonPhaseIndex !== null && <span className="sky-muted"> · {t.moonPhases[info.moonPhaseIndex]}</span>}
                </dd>
              </>
            )}
            {(info.kind === 'star' || info.kind === 'target' || info.kind === 'mark') && (
              <>
                <dt>{t.j2000}</dt>
                <dd className="p-data">{formatRA(info.raLink)} {formatDec(info.decLink)}</dd>
              </>
            )}
          </dl>
          {info.kind === 'target' && info.vmag === null && <p className="sky-note">{t.notNaked}</p>}
          {info.kind === 'target' && all.targets[info.id] && <p className="sky-note">{all.targets[info.id].blurb}</p>}
          {info.kind !== 'body' && (
            <p className="sky-sel-link">
              <a className="sky-btn sky-btn-solid" href={explorerHref(info)}>{t.openExplorer}</a>
              <span className="sky-note">{t.explorerNote}</span>
            </p>
          )}
        </section>
      )}

      </div>

      {/* ---------------- side panel ---------------- */}
      <aside ref={panelRef} id="sky-panel" className={`sky-panel${panelOpen ? ' is-open' : ''}`} aria-label={t.panelLabel}>
        <div className="sky-panel-head">
          <h2 className="p-label">{t.panelLabel}</h2>
          <button type="button" className="sky-icon-btn sky-only-mobile" onClick={() => setPanelOpen(false)} aria-label={t.closePanel}>
            <Icon d={I_CLOSE} />
          </button>
        </div>

        <section className="sky-sec">
          <h3 className="sky-sec-h">{t.dateLabel}</h3>
          <form className="sky-dateform" onSubmit={applyDraft}>
            <label className="sky-field sky-f-year">
              <span className="p-label">{t.year}</span>
              <input type="number" min={-3000} max={3000} value={dateShown.year} onChange={(ev) => editDraft('year', ev.target.value)} />
            </label>
            <label className="sky-field sky-f-sm">
              <span className="p-label">{t.month}</span>
              <input type="number" min={1} max={12} value={dateShown.month} onChange={(ev) => editDraft('month', ev.target.value)} />
            </label>
            <label className="sky-field sky-f-sm">
              <span className="p-label">{t.day}</span>
              <input type="number" min={1} max={31} value={dateShown.day} onChange={(ev) => editDraft('day', ev.target.value)} />
            </label>
            <label className="sky-field sky-f-time">
              <span className="p-label">{t.time}</span>
              <input type="time" value={dateShown.time} onChange={(ev) => editDraft('time', ev.target.value)} />
            </label>
            <button type="submit" className="sky-btn">{t.apply}</button>
          </form>
          <p className="sky-note">{t.rangeNote} {formatTz(tz)} · {t.localTime}.</p>
        </section>

        <section className="sky-sec">
          <h3 className="sky-sec-h">{t.place}</h3>
          <p className="sky-place-now">
            <span>{placeName}</span>{' '}
            <span className="p-data sky-muted">
              {place.lat.toFixed(2)}°, {place.lon.toFixed(2)}° · {formatTz(tz)}
            </span>
          </p>
          <div className="sky-row">
            <button type="button" className="sky-btn" onClick={locate} disabled={geo === 'busy'}>
              {geo === 'busy' ? t.locating : t.useMyLocation}
            </button>
          </div>
          {geo === 'denied' && <p className="sky-note sky-note-warn">{t.locationDenied}</p>}
          {geo === 'ok' && place.id === 'geo' && <p className="sky-note">{t.locationOk}</p>}
          <label className="sky-field">
            <span className="p-label">{t.choosePlace}</span>
            <select
              value={PLACES.some((p) => p.id === place.id) ? place.id : ''}
              onChange={(ev) => {
                const p = PLACES.find((x) => x.id === ev.target.value);
                if (p) setPlace({ id: p.id, name: p.name, lat: p.lat, lon: p.lon });
              }}
            >
              {!PLACES.some((p) => p.id === place.id) && <option value="">{placeName}</option>}
              {PLACES.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <form
            className="sky-latlon"
            onSubmit={(ev) => {
              ev.preventDefault();
              const lat = Number(latDraft ?? place.lat);
              const lon = Number(lonDraft ?? place.lon);
              if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
                setPlace({ id: 'custom', name: '', lat, lon });
              }
            }}
          >
            <label className="sky-field">
              <span className="p-label">{t.lat}</span>
              <input inputMode="decimal" value={latDraft ?? place.lat.toFixed(2)} onChange={(ev) => setLatDraft(ev.target.value)} />
            </label>
            <label className="sky-field">
              <span className="p-label">{t.lon}</span>
              <input inputMode="decimal" value={lonDraft ?? place.lon.toFixed(2)} onChange={(ev) => setLonDraft(ev.target.value)} />
            </label>
            <button type="submit" className="sky-btn">{t.setPlace}</button>
          </form>
        </section>

        <section className="sky-sec">
          <h3 className="sky-sec-h">{t.layers}</h3>
          <div className="sky-checks">
            {(Object.keys(DEFAULT_LAYERS) as (keyof SkyLayers)[]).map((k) => (
              <label key={k} className="sky-check">
                <input type="checkbox" checked={layers[k]} onChange={(ev) => setLayers((l) => ({ ...l, [k]: ev.target.checked }))} />
                <span>{t.layerNames[k]}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="sky-sec">
          <h3 className="sky-sec-h">{t.trailsTitle}</h3>
          <p className="sky-note">{t.trailsHelp}</p>
          <p className="sky-note">{t.trailsTry}</p>
          {layers.trails && (SPEEDS.find((s) => s.id === speed)?.rate ?? 0) * 24 > 80 * 365.25 * 86400 && (
            <p className="sky-note sky-note-warn">{t.trailsHidden}</p>
          )}
          <div className="sky-row">
            <button
              type="button"
              className={`sky-btn${layers.trails ? ' is-on' : ''}`}
              aria-pressed={layers.trails}
              onClick={() => setLayers((l) => ({ ...l, trails: !l.trails }))}
            >
              {t.layerNames.trails}
            </button>
            <button
              type="button"
              className="sky-btn"
              onClick={() => {
                setLayers((l) => ({ ...l, trails: true }));
                setSpeed('month');
                engineRef.current?.select('body:Mars', true);
              }}
            >
              {all.sky.bodies.Mars} · {t.speeds.month}
            </button>
          </div>
        </section>

        <section className="sky-sec">
          <h3 className="sky-sec-h">{t.immersive}</h3>
          {xrSupported ? (
            <div className="sky-row">
              <button type="button" className="sky-btn sky-btn-solid" onClick={() => engineRef.current?.enterXR()}>{t.vr}</button>
              <span className="sky-note">{t.vrHelp}</span>
            </div>
          ) : null}
          {coarse && (
            <>
              <div className="sky-row">
                {mode === 'motion' ? (
                  <button type="button" className="sky-btn is-on" onClick={stopImmersive}>{t.motionOff}</button>
                ) : (
                  <button type="button" className="sky-btn" onClick={startMotion}>{t.motion}</button>
                )}
                <button type="button" className="sky-btn" onClick={startCardboard}>{t.cardboard}</button>
              </div>
              <p className="sky-note">{t.cardboardHelp}</p>
            </>
          )}
          {!xrSupported && !coarse && <p className="sky-note">{t.vrUnsupported}</p>}
          {mode === 'motion' && (
            <p className="sky-note sky-note-warn">
              {t.sensorLabel} {headingAbs ? '' : t.headingApprox}
            </p>
          )}
          {sensorMsg && <p className="sky-note sky-note-warn">{sensorMsg}</p>}
        </section>

        {/*
          STAR SYMPHONY MOUNT POINT. The symphony feature (lib/symphony) renders its controls into
          this element (e.g. createPortal(<SymphonyControls source="sky" />, slot)) and reads the
          visible sky with subscribeVisibleSky() from lib/sky. Those bands are a colour-based
          approximation (t.sky.bandsLabel), not SPHEREx data.
        */}
        <section className="sky-sec sky-symphony" aria-label={t.symphonySlot}>
          <h3 className="sky-sec-h">{t.symphonySlot}</h3>
          <p className="sky-note">{t.bandsLabel}</p>
          <div data-symphony-slot="sky" className="sky-symphony-slot" />
        </section>

        <section className="sky-sec sky-fine">
          <p className="sky-note">{t.accuracyNote}</p>
          <p className="sky-note">{t.calendarNote}</p>
          <p className="sky-note">{t.keyboardHelp}</p>
          <p className="sky-note">{t.credits}</p>
        </section>
      </aside>

      {/* ---------------- time dock ---------------- */}
      <section ref={dockRef} className="sky-dock" aria-label={t.dateLabel}>
        <div className="sky-readout">
          <p className="sky-date p-data" aria-live="off">
            <span className="sky-date-d">{formatLocalDate(timeMs, tz)}</span>
            <span className="sky-date-t">{formatLocalTime(timeMs, tz)}</span>
            <span className="sky-date-z">{formatTz(tz)} · {t.localTime}</span>
          </p>
          <p className="sky-rel">{t.relYears(relYears)}</p>
        </div>

        <div className="sky-transport" role="group" aria-label={t.speed}>
          <button type="button" className="sky-icon-btn" onClick={() => setDir((d) => (d === 1 ? -1 : 1))} aria-pressed={dir === -1} aria-label={dir === 1 ? t.reverse : t.forward} title={dir === 1 ? t.reverse : t.forward}>
            <Icon d={dir === 1 ? I_REV : I_FWD} />
          </button>
          <button type="button" className="sky-play" onClick={togglePlay} aria-label={playing ? t.pause : t.play} title={playing ? t.pause : t.play} disabled={status !== 'ready'}>
            <Icon d={playing ? I_PAUSE : I_PLAY} />
          </button>
          <button type="button" className="sky-btn" onClick={() => applyEpoch(EPOCHS[0])} disabled={status !== 'ready'}>{t.now}</button>
          <label className="sky-speed">
            <span className="p-label">{t.speed}</span>
            <select value={speed} onChange={(ev) => setSpeed(ev.target.value as SpeedId)}>
              {SPEEDS.map((s) => (
                <option key={s.id} value={s.id}>{(dir === -1 ? '−' : '') + t.speeds[s.id]}</option>
              ))}
            </select>
          </label>
          {(SPEEDS.find((s) => s.id === speed)?.rate ?? 0) >= 86400 && <span className="sky-note sky-sid">{t.siderealNote}</span>}
          <button type="button" className="sky-icon-btn sky-only-mobile" onClick={() => setPanelOpen((o) => !o)} aria-expanded={panelOpen} aria-controls="sky-panel" aria-label={t.openPanel} title={t.openPanel}>
            <Icon d={I_GEAR} />
          </button>
        </div>

        <button
          type="button"
          className={`sky-700${epoch === 'ago700' ? ' is-on' : ''}`}
          onClick={() => applyEpoch(EPOCHS.find((e) => e.id === 'ago700')!)}
          disabled={status !== 'ready'}
          title={t.ago700Hint(ago700Year)}
        >
          <span className="sky-700-big">{t.ago700}</span>
          <span className="sky-700-sub p-data">{t.ago700Hint(ago700Year)}</span>
        </button>

        <div className="sky-epochs">
          <span className="p-label sky-epochs-l">{t.epochs}</span>
          <div className="sky-chips" role="group" aria-label={t.epochs}>
            {EPOCHS.filter((e) => e.id !== 'now' && e.id !== 'ago700').map((e) => (
              <button key={e.id} type="button" className={`sky-chip${epoch === e.id ? ' is-on' : ''}`} onClick={() => applyEpoch(e)} disabled={status !== 'ready'}>
                {t.epochNames[e.id]}
              </button>
            ))}
          </div>
          {epochNote && <p className="sky-epoch-note">{epochNote}</p>}
        </div>
      </section>
      </div>}
    </div>
  );
}
