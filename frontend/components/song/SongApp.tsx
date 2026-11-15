'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocale, withLang, type Messages } from '../../lib/i18n';
import SkyImageNote from '../site/SkyImageNote';
import { useMounted } from '../../lib/look/hooks';
import { loadPlace } from '../../lib/look/places';
import type { StarCatalog } from '../../components/cosmos/stars';
import { downloadBlob, playScore, renderScoreToWav, scoreToMidi, songSlug, type SongNote, type SongScore } from '../../lib/symphony/export';
import { composeSkySong, songFrames, type SkySong } from '../../lib/song/compose';
import { encodeQr } from '../../lib/song/qr';
import {
  DEDICATION_MAX, SONG_CITIES, WHERE_MAX, defaultZone, formatDecDms, formatLatLon, formatRaHms, formatUtcOffset,
  inputsToMs, localDateInput, localParts, localTimeInput, specFromQuery, specOffsetHours, specSeed, specToQuery,
  starCatalog, visibleSky, zenithOf, type SongSpec, type VisibleSky, type Zenith,
} from '../../lib/song/sky';
import { CUBE_DEPTH, isAbort, zenithImage, zenithSpectrum } from '../../lib/song/spherex';
import { canvasToBlob, drawPoster, drawSkyChart, ensureFonts, resolveFonts, type PosterData, type PosterFormat, type PosterTheme } from '../../lib/song/poster';
import SiteHeader from '../site/SiteHeader';
import SongKeyboard, { KeyStore } from './SongKeyboard';

type SongText = Messages['song'];
type Phase = 'idle' | 'tuning' | 'ready' | 'error';
type GeoState = 'idle' | 'locating' | 'denied' | 'unavailable';

interface Form {
  date: string;
  time: string;
  /** city id, 'gps' (browser location) or 'custom' (coordinates from a shared link) */
  placeId: string;
  lat: number;
  lon: number;
  zone?: string;
  where: string;
  dedication: string;
}

interface Result {
  spec: SongSpec;
  zenith: Zenith;
  sky: VisibleSky;
  lambda: number[];
  value: (number | null)[];
  score: SongScore;
  /** The composed piece (key, mode, progression...) behind `score`. */
  piece: SkySong;
  image: HTMLCanvasElement | null;
  /** Cube frames behind a melody note (lights the spectral keyboard). */
  frames: (n: SongNote) => number[];
}

function useReducedMotion() {
  return useSyncExternalStore(
    (fn) => {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      mq.addEventListener('change', fn);
      return () => mq.removeEventListener('change', fn);
    },
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => false,
  );
}

function formFromSpec(s: SongSpec): Form {
  const off = specOffsetHours(s);
  const city = s.city ? SONG_CITIES.find((c) => c.id === s.city) : undefined;
  return {
    date: localDateInput(s.ms, off), time: localTimeInput(s.ms, off),
    placeId: city ? city.id : 'custom', lat: s.lat, lon: s.lon, zone: s.zone,
    where: s.where ?? '', dedication: s.dedication,
  };
}

function initialForm(): { form: Form; shared: SongSpec | null; now: number } {
  const now = Date.now();
  const shared = specFromQuery(new URLSearchParams(window.location.search));
  if (shared) return { form: formFromSpec(shared), shared, now };
  const saved = loadPlace();
  const savedCity = saved?.cityId ? SONG_CITIES.find((c) => c.id === saved.cityId) : undefined;
  const city = savedCity ?? SONG_CITIES[0];
  const useGps = saved?.source === 'gps' && !savedCity;
  const zone = useGps ? defaultZone() : city.zone;
  const lat = useGps ? +saved!.lat.toFixed(2) : city.lat, lon = useGps ? +saved!.lon.toFixed(2) : city.lon;
  const off = specOffsetHours({ zone, lon, ms: now });
  return {
    form: { date: localDateInput(now, off), time: localTimeInput(now, off), placeId: useGps ? 'gps' : city.id, lat, lon, zone, where: '', dedication: '' },
    shared: null,
    now,
  };
}

function formToSpec(f: Form): SongSpec | null {
  const ms = inputsToMs(f.date, f.time, f.zone, f.lon);
  if (ms === null) return null;
  return {
    ms, lat: f.lat, lon: f.lon,
    city: SONG_CITIES.some((c) => c.id === f.placeId) ? f.placeId : undefined,
    zone: f.zone, where: f.where.trim() || undefined, dedication: f.dedication.trim(),
  };
}

function placeName(spec: SongSpec, t: Messages): string {
  if (spec.where) return spec.where;
  if (spec.city) return t.look.cities[spec.city] ?? spec.city;
  return '';
}

function dateLine(spec: SongSpec, t: SongText): string {
  const off = specOffsetHours(spec);
  const p = localParts(spec.ms, off);
  const y = p.y < 0 ? `−${-p.y}` : String(p.y);
  return `${t.dateLong(p.d, t.months[p.mo - 1], y)} · ${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')} (${formatUtcOffset(off)})`;
}

function shareUrl(spec: SongSpec, locale: 'en' | 'es'): string {
  return withLang(`${window.location.origin}/song?${specToQuery(spec)}`, locale);
}

/** Share URL that fits a version <= 10 QR code: drop the free-text fields when it is too long. */
function qrUrl(spec: SongSpec, locale: 'en' | 'es'): string {
  const full = shareUrl(spec, locale);
  try { encodeQr(full); return full; } catch { /* too long */ }
  const lean = shareUrl({ ...spec, where: undefined }, locale);
  try { encodeQr(lean); return lean; } catch { /* still too long */ }
  return shareUrl({ ...spec, where: undefined, dedication: '' }, locale);
}

/** Keyboard state, mutated from callbacks (tile arrivals, notes) and read by the canvas loop. One per page. */
const store = new KeyStore();

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function SongApp() {
  const mounted = useMounted();
  const { t } = useLocale();
  return (
    <div className="sg-page">
      <a className="sg-skip" href="#sg-main">{t.common.skipToContent}</a>
      <SiteHeader current="song" />
      {mounted ? <SongStudio /> : <main id="sg-main" className="sg-main" aria-busy="true" />}
    </div>
  );
}

function SongStudio() {
  const { locale, t: all } = useLocale();
  const t = all.song;
  const reduced = useReducedMotion();
  const [init] = useState(initialForm);
  const [form, setForm] = useState<Form>(init.form);
  const [geo, setGeo] = useState<GeoState>('idle');
  const [phase, setPhase] = useState<Phase>('idle');
  const [arrived, setArrived] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [bornHint, setBornHint] = useState(false);
  const [cat, setCat] = useState<StarCatalog | null>(null);
  const [theme, setTheme] = useState<PosterTheme>('night');
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [lastSpec, setLastSpec] = useState<SongSpec | null>(init.shared);

  const ctrlRef = useRef<AbortController | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const playRef = useRef<{ stop(): void; duration: number; t0: number } | null>(null);
  const rafRef = useRef(0);
  const progRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const domeRef = useRef<HTMLCanvasElement>(null);
  const posterRef = useRef<HTMLCanvasElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLElement>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    starCatalog().then((c) => { if (alive) setCat(c); }).catch(() => { /* chart without stars */ });
    return () => { alive = false; };
  }, []);

  // Live chart of the sky for the current form (before and after composing).
  const preview = useMemo(() => {
    const spec = formToSpec(form);
    if (!spec) return null;
    const date = new Date(spec.ms);
    return { spec, sky: visibleSky(cat, { lat: spec.lat, lon: spec.lon }, date), zenith: zenithOf({ lat: spec.lat, lon: spec.lon }, date) };
  }, [form, cat]);

  useEffect(() => {
    const cv = domeRef.current;
    if (!cv || !preview) return;
    const paint = () => {
      const px = cv.clientWidth;
      if (px > 0) drawSkyChart(cv, preview.sky, { cardinals: t.cardinals, bodies: t.bodies }, px, Math.min(2, window.devicePixelRatio || 1));
    };
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [preview, t]);

  const stopPlayback = useCallback(() => {
    playRef.current?.stop();
    playRef.current = null;
    cancelAnimationFrame(rafRef.current);
    store.progress = -1; store.playhead = -1;
    if (progRef.current) progRef.current.style.transform = 'scaleX(0)';
    setPlaying(false);
  }, []);

  useEffect(() => () => { ctrlRef.current?.abort(); playRef.current?.stop(); cancelAnimationFrame(rafRef.current); void audioRef.current?.close(); }, []);

  const run = useCallback(async (spec: SongSpec) => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    stopPlayback();
    store.reset();
    setResult(null);
    setArrived(0);
    setPhase('tuning');
    setLastSpec(spec);
    const place = { lat: spec.lat, lon: spec.lon }, date = new Date(spec.ms);
    const zenith = zenithOf(place, date);
    const imgP = zenithImage(zenith.ra, zenith.dec, 600, ctrl.signal).catch((e) => { if (isAbort(e)) throw e; return null; });
    imgP.catch(() => {});
    let n = 0;
    try {
      const s = await zenithSpectrum(zenith.ra, zenith.dec, {
        signal: ctrl.signal,
        onFrame: (f, ok, value) => {
          if (ctrl.signal.aborted) return;
          store.arrived[f] = ok ? 1 : 2;
          store.arrivedAt[f] = performance.now();
          if (value !== undefined) store.value[f] = value;
          n++;
          setArrived(n);
        },
      });
      store.value = s.value.slice();
      const c = cat ?? (await starCatalog().catch(() => null));
      const sky = visibleSky(c, place, date);
      const piece = composeSkySong({ lambda_um: s.lambda_um, intensity: s.value, seed: specSeed(spec), label: t.songLabel(placeName(spec, all) || formatLatLon(spec.lat, spec.lon), localDateInput(spec.ms, specOffsetHours(spec))) });
      const score = piece.score;
      const img = await imgP;
      if (ctrl.signal.aborted) return;
      setResult({ spec, zenith, sky, lambda: s.lambda_um, value: s.value, score, piece, image: img?.canvas ?? null, frames: songFrames(piece, s.lambda_um, s.value) });
      setPhase('ready');
    } catch (e) {
      if (isAbort(e) || ctrl.signal.aborted) return;
      setPhase('error');
    }
  }, [all, cat, stopPlayback, t]);

  // A shared link opens straight into its song (audio still waits for a tap on Play).
  useEffect(() => {
    if (startedRef.current || !init.shared) return;
    startedRef.current = true;
    const s = init.shared;
    queueMicrotask(() => { void run(s); });
  }, [init.shared, run]);

  const compose = () => {
    const spec = formToSpec(form);
    if (!spec) { setFormError(t.invalidDate); return; }
    setFormError(null);
    const url = new URL(window.location.href);
    url.search = specToQuery(spec);
    if (locale !== 'en') url.searchParams.set('lang', locale);
    window.history.replaceState(window.history.state, '', url);
    void run(spec);
    requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' }));
  };

  const setNow = () => {
    const now = Date.now();
    const off = specOffsetHours({ zone: form.zone, lon: form.lon, ms: now });
    setForm((f) => ({ ...f, date: localDateInput(now, off), time: localTimeInput(now, off) }));
    setBornHint(false);
  };
  const setBorn = () => {
    setBornHint(true);
    requestAnimationFrame(() => { dateRef.current?.focus(); try { dateRef.current?.showPicker?.(); } catch { /* not allowed */ } });
  };

  const locate = () => {
    if (!navigator.geolocation) { setGeo('unavailable'); return; }
    setGeo('locating');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // Rounded to 0.01 deg (~1 km): plenty for a sky chart, and kinder to privacy in shared links.
        setForm((f) => ({ ...f, placeId: 'gps', lat: +pos.coords.latitude.toFixed(2), lon: +pos.coords.longitude.toFixed(2), zone: defaultZone() }));
        setGeo('idle');
      },
      (err) => setGeo(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 },
    );
  };

  const setCity = (id: string) => {
    const c = SONG_CITIES.find((x) => x.id === id);
    if (c) setForm((f) => ({ ...f, placeId: c.id, lat: c.lat, lon: c.lon, zone: c.zone }));
  };

  // --- poster -------------------------------------------------------------------------------
  const posterData = useCallback((r: Result): PosterData => {
    const spec = r.spec;
    const name = placeName(spec, all) || (spec.city ? '' : form.placeId === 'gps' ? t.myLocation : '');
    return {
      sky: r.sky, lambda: r.lambda, value: r.value, image: r.image, url: qrUrl(spec, locale),
      text: {
        brand: t.posterBrand,
        dedication: spec.dedication,
        dateLine: dateLine(spec, t),
        placeLine: name ? `${name} · ${formatLatLon(spec.lat, spec.lon)}` : formatLatLon(spec.lat, spec.lon),
        zenithLine: t.zenithLine(formatRaHms(r.zenith.ra).replace(/ \d\ds$/, ''), formatDecDms(r.zenith.dec)),
        cardinals: t.cardinals, bodies: t.bodies, insetLabel: t.posterInset, insetMissing: t.imageMissing,
        barcodeLabel: t.posterBarcode, qrLabel: t.posterQr, integrity: t.posterIntegrity, credit: t.credit,
      },
    };
  }, [all, form.placeId, locale, t]);

  useEffect(() => {
    const cv = posterRef.current;
    if (!cv || !result) return;
    let alive = true;
    const fonts = resolveFonts();
    ensureFonts(fonts).then(() => { if (alive) drawPoster(cv, posterData(result), 'poster', theme, fonts); });
    return () => { alive = false; };
  }, [result, theme, posterData]);

  const slug = result ? songSlug(`${placeName(result.spec, all) || 'sky'} ${localDateInput(result.spec.ms, specOffsetHours(result.spec))}`) : 'listar-sky-song';

  const downloadImage = async (format: PosterFormat) => {
    if (!result) return;
    setBusy(format);
    try {
      const fonts = resolveFonts();
      await ensureFonts(fonts);
      const cv = document.createElement('canvas');
      drawPoster(cv, posterData(result), format, theme, fonts);
      downloadBlob(await canvasToBlob(cv), `${slug}-${format}-${theme}.png`);
    } finally { setBusy(null); }
  };
  const downloadWav = async () => {
    if (!result) return;
    setBusy('wav');
    try { downloadBlob(await renderScoreToWav(result.score), `${slug}.wav`); } finally { setBusy(null); }
  };
  const downloadMidi = () => {
    if (!result) return;
    downloadBlob(new Blob([scoreToMidi(result.score) as BlobPart], { type: 'audio/midi' }), `${slug}.mid`);
  };
  const flash = (msg: string) => { setToast(msg); window.setTimeout(() => setToast(null), 2600); };
  const share = async () => {
    if (!result) return;
    const url = shareUrl(result.spec, locale);
    const text = t.shareText(dateLine(result.spec, t));
    try {
      if (navigator.share) { await navigator.share({ title: t.eyebrow, text, url }); return; }
    } catch (e) { if (e instanceof DOMException && e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(url); flash(t.linkCopied); return; } catch { /* try the legacy path */ }
    const ta = document.createElement('textarea');
    ta.value = url; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    flash(ok ? t.linkCopied : t.shareFailed);
  };

  // --- playback ------------------------------------------------------------------------------
  const play = async () => {
    if (!result) return;
    if (playing) { stopPlayback(); return; }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = audioRef.current ?? new AC();
    audioRef.current = ctx;
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch { /* ignore */ } }
    const t0 = ctx.currentTime + 0.12;
    const h = playScore(result.score, ctx, undefined, {
      startAt: t0,
      onNote: (n) => {
        if (n.voice !== 'lead' && n.voice !== 'ice') return;
        const fs = result.frames(n);
        const now = performance.now();
        for (const f of fs) store.lit[f] = now;
        if (fs.length) store.playhead = fs[Math.floor(fs.length / 2)];
      },
    });
    playRef.current = { ...h, t0 };
    setPlaying(true);
    const tick = () => {
      const p = playRef.current;
      if (!p) return;
      const el = Math.max(0, ctx.currentTime - p.t0);
      store.progress = Math.min(1, el / p.duration);
      if (progRef.current) progRef.current.style.transform = `scaleX(${store.progress})`;
      if (clockRef.current) clockRef.current.textContent = `${fmtClock(el)} / ${fmtClock(p.duration)}`;
      if (el >= p.duration + 1.5) { stopPlayback(); return; }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  // --- render --------------------------------------------------------------------------------
  const off = specOffsetHours({ zone: form.zone, lon: form.lon, ms: preview?.spec.ms ?? init.now });
  const sunAlt = (result?.sky ?? preview?.sky)?.sunAlt ?? -90;
  const zen = result?.zenith ?? preview?.zenith ?? null;
  const featureNames = result?.score.features.map((f) => f.toUpperCase().replace('H2O', 'H₂O').replace('CO2', 'CO₂').replace('CH4', 'CH₄')).join(', ');
  const showKeyboard = phase === 'tuning' || phase === 'ready';

  return (
    <main id="sg-main" className="sg-main">
      <section className="sg-hero" aria-labelledby="sg-title">
        <p className="p-label sg-eyebrow">{t.eyebrow}</p>
        <h1 id="sg-title" className="p-display sg-h1">{t.title}</h1>
        <p className="sg-lede">{t.lede}</p>
      </section>

      <div className="sg-grid">
        <form className="sg-form" aria-label={t.formLabel} onSubmit={(e) => { e.preventDefault(); compose(); }}>
          <p className="p-label">{t.formLabel}</p>
          <div className="sg-presets" role="group" aria-label={t.formLabel}>
            <button type="button" className="sg-chip" onClick={setNow}>{t.presetNow}</button>
            <button type="button" className="sg-chip" onClick={setBorn}>{t.presetBorn}</button>
          </div>
          {bornHint && <p className="sg-hint" role="status">{t.presetBornHint}</p>}
          <div className="sg-row2">
            <label className="sg-field">
              <span className="sg-flabel">{t.date}</span>
              <input ref={dateRef} type="date" required value={form.date} min="1900-01-01" max="2100-12-31" onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            </label>
            <label className="sg-field">
              <span className="sg-flabel">{t.time}</span>
              <input type="time" required value={form.time} onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))} />
            </label>
          </div>
          <p className="sg-micro p-data">{t.tzNote(formatUtcOffset(off))}</p>

          <fieldset className="sg-fieldset">
            <legend className="sg-flabel">{t.place}</legend>
            <div className="sg-place">
              <button type="button" className="sg-btn sg-btn-ghost" onClick={locate} aria-pressed={form.placeId === 'gps'} disabled={geo === 'locating'}>
                <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 1v3M8 12v3M1 8h3M12 8h3" stroke="currentColor" strokeWidth="1.4" /></svg>
                {geo === 'locating' ? t.locating : t.useLocation}
              </button>
              <label className="sg-field sg-field-grow">
                <span className="sg-sr">{t.city}</span>
                <select value={SONG_CITIES.some((c) => c.id === form.placeId) ? form.placeId : ''} onChange={(e) => setCity(e.target.value)}>
                  {!SONG_CITIES.some((c) => c.id === form.placeId) && <option value="">{form.placeId === 'gps' ? t.myLocation : t.sharedPlace}</option>}
                  {SONG_CITIES.map((c) => <option key={c.id} value={c.id}>{all.look.cities[c.id] ?? c.id}</option>)}
                </select>
              </label>
            </div>
            {(geo === 'denied' || geo === 'unavailable') && <p className="sg-hint sg-hint-warn" role="alert">{geo === 'denied' ? t.locationDenied : t.locationUnavailable}</p>}
            <p className="sg-micro p-data">{formatLatLon(form.lat, form.lon)}</p>
          </fieldset>

          <label className="sg-field">
            <span className="sg-flabel">{t.where} <span className="sg-opt">· {t.optional}</span></span>
            <input type="text" value={form.where} maxLength={WHERE_MAX} placeholder={t.wherePlaceholder} onChange={(e) => setForm((f) => ({ ...f, where: e.target.value }))} />
          </label>
          <label className="sg-field">
            <span className="sg-flabel">{t.dedication} <span className="sg-opt">· {t.optional}</span></span>
            <input type="text" value={form.dedication} maxLength={DEDICATION_MAX} placeholder={t.dedicationPlaceholder} onChange={(e) => setForm((f) => ({ ...f, dedication: e.target.value }))} />
          </label>
          {formError && <p className="sg-hint sg-hint-warn" role="alert">{formError}</p>}
          <button type="submit" className="sg-btn sg-btn-primary" disabled={phase === 'tuning'}>{result ? t.recompose : t.compose}</button>
        </form>

        <section className="sg-stage" ref={resultRef} aria-labelledby="sg-stage-title" tabIndex={-1}>
          <div className="sg-dome-wrap">
            <canvas ref={domeRef} className="sg-dome" role="img" aria-label={all.look.domeLabel} />
          </div>
          <div className="sg-zenith">
            <h2 id="sg-stage-title" className="p-label">{t.zenithTitle}</h2>
            {zen && <p className="p-data sg-zen">{t.zenithAt(formatRaHms(zen.ra), formatDecDms(zen.dec))}</p>}
            {sunAlt > 0 ? <p className="sg-note">{t.daylight}</p> : sunAlt > -12 ? <p className="sg-note">{t.twilight}</p> : null}
          </div>

          {showKeyboard && (
            <div className="sg-kb-wrap">
              <div className="sg-kb-head">
                <p className="p-label">{keepMicro(phase === 'tuning' ? t.tuningTitle : t.posterBarcode)}</p>
                <p className="p-data sg-micro" aria-live="polite">{phase === 'tuning' ? t.tuningStatus(arrived, CUBE_DEPTH) : result ? t.pieceLine(`${t.noteNames[result.piece.tonic]} ${t.modeNames[result.piece.mode]}`, result.piece.bpm, result.piece.progression.join('–'), Math.round(result.score.seconds)) : ''}</p>
              </div>
              <SongKeyboard store={store} label={t.keyboardLabel} reducedMotion={reduced} />
              {phase === 'tuning' && <p className="sg-micro">{t.tuningHint}</p>}
              {phase === 'ready' && result && (
                <>
                  <div className="sg-transport">
                    <button type="button" className="sg-btn sg-btn-primary sg-play" onClick={play} aria-pressed={playing}>
                      <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14">{playing ? <rect x="3" y="3" width="10" height="10" fill="currentColor" /> : <path d="M4 2.5v11l9-5.5z" fill="currentColor" />}</svg>
                      {playing ? t.stop : t.play}
                    </button>
                    <div className="sg-prog" aria-hidden="true"><div ref={progRef} className="sg-prog-bar" /></div>
                    <span ref={clockRef} className="p-data sg-micro sg-clock">{`0:00 / ${fmtClock(result.score.seconds)}`}</span>
                  </div>
                  <p className="sg-micro">{featureNames ? t.featuresHeard(featureNames) : t.noFeatures}</p>
                </>
              )}
            </div>
          )}
          {phase === 'error' && (
            <div className="sg-error" role="alert">
              <p className="sg-error-t">{t.errorTitle}</p>
              <p>{t.errorBody}</p>
              <button type="button" className="sg-btn sg-btn-ghost" onClick={() => lastSpec && void run(lastSpec)}>{t.retry}</button>
            </div>
          )}
          <p className="sg-integrity-short">{t.integrity}</p>
        </section>
      </div>

      {result && (
        <section className="sg-result" aria-labelledby="sg-poster-title">
          <div className="sg-poster-col">
            <div className="sg-poster-head">
              <h2 id="sg-poster-title" className="p-display sg-h2">{t.posterTitle}</h2>
              <div className="sg-seg" role="group" aria-label={t.themeLabel}>
                <button type="button" aria-pressed={theme === 'night'} onClick={() => setTheme('night')}>{t.themeNight}</button>
                <button type="button" aria-pressed={theme === 'paper'} onClick={() => setTheme('paper')}>{t.themePaper}</button>
              </div>
            </div>
            <canvas ref={posterRef} className="sg-poster" role="img" aria-label={t.posterAlt(`${result.spec.dedication ? `${result.spec.dedication}. ` : ''}${dateLine(result.spec, t)}`)} />
          </div>
          <div className="sg-side">
            <div className="sg-actions">
              <p className="p-label">{t.downloads}</p>
              <button type="button" className="sg-btn sg-btn-primary" onClick={play} aria-pressed={playing}>{playing ? t.stop : t.play}</button>
              <button type="button" className="sg-btn" onClick={() => void downloadImage('poster')} disabled={!!busy}>{busy === 'poster' ? t.rendering : t.dlPoster}</button>
              <button type="button" className="sg-btn" onClick={() => void downloadImage('story')} disabled={!!busy}>{busy === 'story' ? t.rendering : t.dlStory}</button>
              <button type="button" className="sg-btn" onClick={() => void downloadWav()} disabled={!!busy}>{busy === 'wav' ? t.rendering : t.dlWav}</button>
              <button type="button" className="sg-btn" onClick={downloadMidi}>{t.dlMidi}</button>
              <button type="button" className="sg-btn sg-btn-ghost" onClick={() => void share()}>{t.share}</button>
              <p className="sg-toast" role="status" aria-live="polite">{toast ?? ''}</p>
            </div>
            <figure className="sg-spx">
              <figcaption className="p-label">{t.spherexTitle}</figcaption>
              {result.image ? <SpxImage key={specToQuery(result.spec)} canvas={result.image} /> : <div className="sg-spx-missing">{t.imageMissing}</div>}
              <p className="sg-micro">{t.spherexCaption}</p>
              <SkyImageNote />
            </figure>
          </div>
        </section>
      )}

      <section className="sg-print" aria-labelledby="sg-print-title">
        <div className="sg-print-head">
          <h2 id="sg-print-title" className="p-display sg-h2">{t.printTitle}</h2>
          <span className="sg-concept p-data">{t.printConcept}</span>
        </div>
        <p className="sg-lede sg-lede-sm">{t.printLede}</p>
        <ul className="sg-tiers">
          {t.printTiers.map((tier) => (
            <li key={tier.name} className="sg-tier">
              <p className="sg-tier-name">{tier.name}</p>
              <p className="p-data sg-tier-price">{tier.price}</p>
              <p className="sg-micro">{tier.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="sg-integrity" aria-labelledby="sg-int-title">
        <h2 id="sg-int-title" className="p-label">{t.integrityTitle}</h2>
        <p>{t.integrity}</p>
        <p className="sg-micro">{t.integrityDetail}</p>
        <p className="p-data sg-micro">{t.credit}</p>
      </section>
    </main>
  );
}

/** Uppercase labels (CSS) would turn the micro sign into a Greek capital Mu: keep 'µm' as written. */
function keepMicro(text: string) {
  const parts = text.split('µm');
  return parts.map((p, i) => (i === 0 ? p : <span key={i}><span style={{ textTransform: 'none' }}>µm</span>{p}</span>));
}

function SpxImage({ canvas }: { canvas: HTMLCanvasElement }) {
  const [src] = useState(() => canvas.toDataURL('image/png'));
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="sg-spx-img" src={src} alt="" width={canvas.width} height={canvas.height} />;
}
