'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, LIVE_ENABLED, fetchGaia, fetchSkybot, fetchSpectrum, fetchTargets, fetchVerdict, searchLive } from '../../lib/prism/api';
import { angularSepArcsec, formatDec, formatMjdDate, formatRa, makeProjector } from '../../lib/prism/coords';
import {
  DEFAULT_FLAG_BITS, GOGGLES, computeLevels, goggleMap, gridAperture, matchedFrames, measureCentroid, medianStack,
  percentile, type GoggleId, type Stretch,
} from '../../lib/prism/imaging';
import { PRISM_TEXT } from '../../lib/prism/i18n';
import { PRESETS } from '../../lib/prism/presets';
import { lambdaColor } from '../../lib/prism/ramp';
import { findSnapshot, loadSnapshot, loadSnapshotIndex } from '../../lib/prism/snapshot';
import type {
  CatalogTarget, DataOrigin, Frame, GaiaResponse, Progress, SearchResult, SkybotObject, SpectrumPoint,
  SpectrumResponse, V2Target, VerdictResponse, ViewMode,
} from '../../lib/prism/types';
import { readUrl, writeUrl, type UrlState } from '../../lib/prism/url';
import ScrubPad from './ScrubPad';
import SkyCanvas, { type Ring } from './SkyCanvas';
import SpectrumPanel, { type SpectrumSource } from './SpectrumPanel';
import TargetBar from './TargetBar';
import VerdictPanel from './VerdictPanel';

type Loaded = {
  key: string;
  search: SearchResult;
  origin: DataOrigin;
  liveError: string | null;
  gaia: GaiaResponse | null;
  catalogTarget: CatalogTarget | null;
  spectrum: SpectrumResponse | null;
  verdict: VerdictResponse | null;
};
type Failure = { key: string; message: string; liveError: string | null; noCoverage?: boolean };
/** Sentinel for a static deployment without the science server (rendered in the current language). */
const LIVE_OFF = '__live_off__';
type Aux<T> = { key: string; status: 'loading' | 'ready' | 'error'; data: T | null; error?: string };

const MODES: ViewMode[] = ['frame', 'coadd', 'diff', 'goggles', 'raw', 'cube'];
// three.js is large: the cube loads only when its mode is opened.
const SpectralCube3D = dynamic(() => import('../cosmos/SpectralCube3D'), { ssr: false });
const SPEEDS = [1, 2, 4, 8];
const APERTURE_ARCSEC = 9;

function keyOf(ra?: number, dec?: number, fov?: number) {
  return ra === undefined || dec === undefined ? '' : `${ra.toFixed(5)},${dec.toFixed(5)},${fov}`;
}

function pickInitial(frames: Frame[], t?: number, lam?: number, best?: number[]): number {
  if (!frames.length) return 0;
  if (t !== undefined || lam !== undefined) {
    let bi = 0, bd = Infinity;
    for (const f of frames) {
      const d = (t !== undefined ? Math.abs(f.mjd - t) / 30 : 0) + (lam !== undefined ? Math.abs(f.lambda_um - lam) / 0.05 : 0);
      if (d < bd) { bd = d; bi = f.index; }
    }
    return bi;
  }
  // Prefer the frame whose matched-λ partners span the most seasons (best blink), then preferred detectors.
  let bi = 0, bs = -1;
  for (const f of frames) {
    const seasons = new Set(matchedFrames(frames, f).map((m) => m.season)).size;
    const score = seasons * 100 + (best?.includes(f.detector) ? 10 : 0) + (f.saturated_at_center ? 0 : 5) + f.valid_fraction;
    if (score > bs) { bs = score; bi = f.index; }
  }
  return bi;
}

function nearestPos<T extends { mjd: number }>(arr: T[], mjd: number): T | undefined {
  let best: T | undefined, bd = Infinity;
  for (const p of arr) { const d = Math.abs(p.mjd - mjd); if (d < bd) { bd = d; best = p; } }
  return best;
}

export default function PrismApp({ initialQuery }: { initialQuery: string }) {
  const [url, setUrl] = useState<UrlState>(() => {
    const u = readUrl(initialQuery);
    if (u.ra === undefined || u.dec === undefined) {
      const p = PRESETS.find((x) => x.id === (u.target ?? 'wise-0855')) ?? PRESETS[0];
      return { ...u, ra: p.ra, dec: p.dec, target: p.id };
    }
    return u;
  });
  const text = PRISM_TEXT[url.lang];
  const [targets, setTargets] = useState<V2Target[]>(PRESETS);

  // ---- URL sync (replaceState; the URL is the shareable state) ----
  useEffect(() => {
    const qs = writeUrl(url);
    const next = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
    if (next !== window.location.pathname + window.location.search) window.history.replaceState(null, '', next);
    document.documentElement.lang = url.lang;
  }, [url]);

  useEffect(() => {
    if (!LIVE_ENABLED) return; // static deployment: built-in presets (same coordinates as /v2/targets)
    const ctrl = new AbortController();
    fetchTargets(ctrl.signal)
      .then((r) => { if (Array.isArray(r.targets) && r.targets.length) setTargets(r.targets.map((t) => ({ ...PRESETS.find((p) => p.id === t.id), ...t }))); })
      .catch(() => { /* offline presets stay */ });
    return () => ctrl.abort();
  }, []);

  // ---- Search: live first, then a labelled REAL snapshot, never synthetic ----
  const reqKey = keyOf(url.ra, url.dec, url.fov);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [progress, setProgress] = useState<{ key: string; p: Progress } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const initialUrl = useRef(url);

  useEffect(() => {
    if (!reqKey || url.ra === undefined || url.dec === undefined) return;
    const ra = url.ra, dec = url.dec, fov = url.fov, target = url.target;
    const ctrl = new AbortController();
    const onP = (p: Progress) => setProgress({ key: reqKey, p });
    (async () => {
      let liveError: string | null = null;
      try {
        const search = await searchLive({ ra, dec, fov }, onP, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setLoaded({ key: reqKey, search, origin: { kind: 'live' }, liveError: null, gaia: null, catalogTarget: null, spectrum: null, verdict: null });
        return;
      } catch (e) {
        if (ctrl.signal.aborted) return;
        if (e instanceof ApiError && !e.unavailable) {
          setFailure({ key: reqKey, message: e.message, liveError: null, noCoverage: e.errorType === 'no_coverage' });
          return;
        }
        liveError = e instanceof ApiError && e.kind === 'disabled' ? LIVE_OFF : e instanceof Error ? e.message : String(e);
      }
      try {
        const idx = await loadSnapshotIndex();
        const byId = target ? idx.find((s) => s.id === target && angularSepArcsec(ra, dec, s.ra, s.dec) < 60) : undefined;
        const entry = byId ?? (await findSnapshot(ra, dec, 30));
        if (!entry || entry.fov !== fov) {
          setFailure({ key: reqKey, message: entry ? `snapshot ${entry.id} is ${entry.fov}′; requested ${fov}′` : 'no snapshot', liveError });
          return;
        }
        const { snapshot, search } = await loadSnapshot(entry.id, onP, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setLoaded({
          key: reqKey, search, liveError,
          origin: { kind: 'snapshot', id: snapshot.id, generated: snapshot.generated_utc },
          gaia: snapshot.gaia ?? null, catalogTarget: snapshot.catalog_target ?? null,
          spectrum: snapshot.spectrum ?? null, verdict: snapshot.verdict ?? null,
        });
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setFailure({ key: reqKey, message: e instanceof Error ? e.message : String(e), liveError });
      }
    })();
    return () => ctrl.abort();
  }, [reqKey, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const data = loaded && loaded.key === reqKey ? loaded : null;
  const fail = !data && failure && failure.key === reqKey ? failure : null;
  const loading = !data && !fail;
  const search = data?.search ?? null;
  const frames = useMemo(() => search?.frames ?? [], [search]);
  const cubeFrames = useMemo(() => frames.map((f) => ({ pixels: f.pixels, n: search?.grid.n ?? 0, lambda_um: f.lambda_um, mjd: f.mjd, season: f.season, detector: f.detector, id: f.id })), [frames, search]);
  const flagBits = search?.flag_bits ?? DEFAULT_FLAG_BITS;
  const preset = targets.find((t) => t.id === url.target) as (typeof PRESETS)[number] | undefined;

  // ---- Current frame ----
  const [sel, setSel] = useState<{ key: string; index: number } | null>(null);
  const currentIndex = useMemo(() => {
    if (!frames.length) return 0;
    if (sel && sel.key === reqKey && sel.index < frames.length) return sel.index;
    const first = initialUrl.current;
    const useUrl = keyOf(first.ra, first.dec, first.fov) === reqKey;
    return pickInitial(frames, useUrl ? first.t : undefined, useUrl ? first.lam : undefined, preset?.expected?.best_detectors);
  }, [frames, sel, reqKey, preset]);
  const current: Frame | null = frames[currentIndex] ?? null;
  const select = useCallback((index: number) => setSel({ key: reqKey, index }), [reqKey]);

  useEffect(() => {
    if (!current) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl((u) => (u.t === current.mjd && u.lam === current.lambda_um ? u : { ...u, t: current.mjd, lam: current.lambda_um }));
  }, [current]);

  const matched = useMemo(() => (current ? matchedFrames(frames, current) : []), [frames, current]);
  const matchedSet = useMemo(() => new Set(matched.map((f) => f.index)), [matched]);
  const seasons = useMemo(() => search?.seasons ?? [], [search]);

  // ---- Mode-specific image ----
  const mode = url.mode;
  const [stretch, setStretch] = useState<Stretch>('asinh');
  const [goggle, setGoggle] = useState<GoggleId>('CH4');
  const [refPick, setRefPick] = useState<number | null>(null);
  const refSeason = useMemo(() => {
    if (!current) return null;
    const avail = [...new Set(matched.filter((f) => f.season !== current.season).map((f) => f.season))].sort((a, b) => a - b);
    if (refPick !== null && avail.includes(refPick)) return refPick;
    return avail[0] ?? null;
  }, [matched, current, refPick]);

  const view = useMemo(() => {
    if (!current || !search) return null;
    if (mode === 'coadd') {
      const set = frames.filter((f) => f.detector === current.detector && f.season === current.season);
      const img = medianStack(set);
      const lams = set.map((f) => f.lambda_um);
      return { image: img, kind: 'gray' as const, unit: 'MJy/sr', note: `D${current.detector} · S${current.season} · ${set.length} ${text.frames} · λ ${Math.min(...lams).toFixed(3)}–${Math.max(...lams).toFixed(3)} µm`, frames: set };
    }
    if (mode === 'diff') {
      if (refSeason === null) return { image: null, kind: 'diverging' as const, unit: 'MJy/sr', note: url.lang === 'es' ? 'No hay cuadros a λ emparejada en otra temporada.' : 'No matched-λ frames in another season.', frames: [] };
      const a = matched.filter((f) => f.season === current.season);
      const b = matched.filter((f) => f.season === refSeason);
      const A = medianStack(a), B = medianStack(b);
      const D = new Float32Array(A.length);
      for (let i = 0; i < D.length; i++) D[i] = A[i] - B[i];
      return { image: D, kind: 'diverging' as const, unit: 'MJy/sr', note: `S${current.season} (${a.length}) − S${refSeason} (${b.length}) · λ ${current.lambda_um.toFixed(3)} ± ${(current.bandwidth_um / 2).toFixed(3)} µm`, frames: [...a, ...b] };
    }
    if (mode === 'goggles') {
      const g = goggleMap(frames, goggle);
      const w = GOGGLES[goggle];
      const recipe = `${goggle}: 1 − F[${w.band[0]}–${w.band[1]}] / F_cont([${w.blue[0]}–${w.blue[1]}], [${w.red[0]}–${w.red[1]}]) µm`;
      return { image: g.map, kind: 'depth' as const, unit: '', note: g.map ? `${recipe} · ${g.counts.band}/${g.counts.blue}/${g.counts.red} ${text.frames}` : text.gogglesNeed(g.counts), frames: [] };
    }
    return { image: current.pixels, kind: 'gray' as const, unit: 'MJy/sr', note: '', frames: [current] };
  }, [mode, current, frames, search, matched, refSeason, goggle, text, url.lang]);

  const levels = useMemo(() => (view?.image && view.kind === 'gray' ? computeLevels(view.image, stretch) : { lo: 0, hi: 1 }), [view, stretch]);
  const divScale = useMemo(() => {
    if (!view?.image) return 1;
    if (view.kind === 'depth') return 0.6;
    if (view.kind === 'diverging') {
      const abs = Array.from(view.image, (v) => Math.abs(v));
      return Math.max(percentile(abs, 99.5), 1e-6);
    }
    return 1;
  }, [view]);

  // ---- Overlays ----
  const [ov, setOv] = useState({ gaia: true, skybot: true, flags: false, centroid: true, target: true });
  const proj = useMemo(() => (search ? makeProjector(search.grid) : null), [search]);
  const pixscale = search?.grid.pixscale_arcsec ?? 6.15;

  // Live auxiliary data (only when the search itself is live).
  const isLive = data?.origin.kind === 'live';
  const [gaiaLive, setGaiaLive] = useState<Aux<GaiaResponse> | null>(null);
  const [verdictLive, setVerdictLive] = useState<Aux<VerdictResponse> | null>(null);
  const [skybot, setSkybot] = useState<Aux<SkybotObject[]> | null>(null);
  useEffect(() => {
    if (!isLive || !search || url.ra === undefined || url.dec === undefined) return;
    const ctrl = new AbortController();
    const mjds = [...new Set(frames.map((f) => +f.mjd.toFixed(4)))];
    const k = reqKey;
    fetchGaia(url.ra, url.dec, url.fov * 0.75, mjds, ctrl.signal)
      .then((d) => setGaiaLive({ key: k, status: 'ready', data: d }))
      .catch((e) => !ctrl.signal.aborted && setGaiaLive({ key: k, status: 'error', data: null, error: (e as Error).message }));
    fetchVerdict(url.ra, url.dec, url.fov, ctrl.signal)
      .then((d) => setVerdictLive({ key: k, status: 'ready', data: d }))
      .catch((e) => !ctrl.signal.aborted && setVerdictLive({ key: k, status: 'error', data: null, error: (e as Error).message }));
    return () => ctrl.abort();
  }, [isLive, search]); // eslint-disable-line react-hooks/exhaustive-deps

  const curMjd = current?.mjd;
  useEffect(() => {
    if (!isLive || curMjd === undefined || !ov.skybot || url.ra === undefined || url.dec === undefined) return;
    const ctrl = new AbortController();
    const k = `${reqKey}@${curMjd.toFixed(3)}`;
    const id = setTimeout(() => {
      fetchSkybot(url.ra!, url.dec!, url.fov * 0.75, curMjd, ctrl.signal)
        .then((d) => setSkybot({ key: k, status: 'ready', data: d.objects ?? d.sources ?? [] }))
        .catch((e) => !ctrl.signal.aborted && setSkybot({ key: k, status: 'error', data: null, error: (e as Error).message }));
    }, 350);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [isLive, curMjd, ov.skybot, reqKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const gaia = isLive ? (gaiaLive?.key === reqKey ? gaiaLive.data : null) : data?.gaia ?? null;
  const gaiaRings: Ring[] = useMemo(() => {
    if (!ov.gaia || !gaia || !proj || !current) return [];
    return gaia.sources.flatMap((s) => {
      const p = nearestPos(s.positions, current.mjd) ?? { ra: s.ra, dec: s.dec };
      const px = proj.skyToPix(p.ra, p.dec);
      if (px.x < -2 || px.y < -2 || px.x > search!.grid.n + 1 || px.y > search!.grid.n + 1) return [];
      const dx = s.pmra != null ? -(s.pmra / 1000) * 10 / pixscale : undefined;
      const dy = s.pmdec != null ? -(s.pmdec / 1000) * 10 / pixscale : undefined;
      return [{ x: px.x, y: px.y, dx, dy, mag: s.phot_g_mean_mag, label: s.source_id }];
    });
  }, [ov.gaia, gaia, proj, current, pixscale, search]);

  // Catalogue-predicted target track: snapshot registry track, else linear PM from the preset (labelled).
  const track = useMemo(() => {
    if (data?.catalogTarget) return { positions: data.catalogTarget.positions, label: `${data.catalogTarget.name} · ${text.predicted}` };
    const pm = (preset as (typeof PRESETS)[number] | undefined)?.pm;
    if (!pm || !preset || !frames.length) return null;
    const cosd = Math.cos((preset.dec * Math.PI) / 180);
    const positions = frames.map((f) => {
      const yr = (f.mjd - pm.ref_mjd) / 365.25;
      return { mjd: f.mjd, ra: preset.ra + (pm.ra_cosdec_masyr / 3.6e6) * yr / cosd, dec: preset.dec + (pm.dec_masyr / 3.6e6) * yr };
    });
    return { positions, label: `${preset.name} · ${text.predicted} (PM ${pm.source}, lin.)` };
  }, [data, preset, frames, text]);

  const targetMark = useMemo(() => {
    if (!ov.target || !track || !proj || !current) return null;
    const p = nearestPos(track.positions, current.mjd);
    if (!p) return null;
    const px = proj.skyToPix(p.ra, p.dec);
    const sorted = [...track.positions].sort((a, b) => a.mjd - b.mjd);
    const trail = [sorted[0], sorted[sorted.length - 1]].map((q) => proj.skyToPix(q.ra, q.dec));
    return { x: px.x, y: px.y, trail, label: track.label };
  }, [ov.target, track, proj, current]);

  const skybotRings: Ring[] = useMemo(() => {
    if (!ov.skybot || !skybot?.data || !proj || !current || skybot.key !== `${reqKey}@${current.mjd.toFixed(3)}`) return [];
    return skybot.data.map((o) => { const p = proj.skyToPix(o.ra, o.dec); return { x: p.x, y: p.y, label: String(o.name) }; });
  }, [ov.skybot, skybot, proj, current, reqKey]);

  // Probe (click-to-spectrum); defaults to the field centre.
  const [probeSky, setProbeSky] = useState<{ key: string; ra: number; dec: number } | null>(null);
  const probe = useMemo(
    () => (probeSky && probeSky.key === reqKey ? probeSky : url.ra !== undefined && url.dec !== undefined ? { key: reqKey, ra: url.ra, dec: url.dec } : null),
    [probeSky, reqKey, url.ra, url.dec],
  );
  const probePix = useMemo(() => (probe && proj ? proj.skyToPix(probe.ra, probe.dec) : null), [probe, proj]);
  const onProbe = useCallback((x: number, y: number) => {
    if (!proj) return;
    const s = proj.pixToSky(x, y);
    setProbeSky({ key: reqKey, ra: s.ra, dec: s.dec });
  }, [proj, reqKey]);

  // Centroid measured on the displayed image near the predicted target (or probe).
  const centroid = useMemo(() => {
    if (!ov.centroid || !view?.image || view.kind !== 'gray' || !search) return null;
    const at = targetMark ?? probePix;
    if (!at) return null;
    return measureCentroid(view.image, search.grid.n, at.x, at.y, 2.5);
  }, [ov.centroid, view, search, targetMark, probePix]);

  // Measured vs predicted shift between first and last season (same detector co-adds).
  const motion = useMemo(() => {
    if (!current || !search || !track || !proj) return null;
    const det = frames.filter((f) => f.detector === current.detector);
    const ss = [...new Set(det.map((f) => f.season))].sort((a, b) => a - b);
    if (ss.length < 2) return null;
    const sA = ss[0], sB = ss[ss.length - 1];
    const fa = det.filter((f) => f.season === sA), fb = det.filter((f) => f.season === sB);
    const mjdA = fa.reduce((a, f) => a + f.mjd, 0) / fa.length, mjdB = fb.reduce((a, f) => a + f.mjd, 0) / fb.length;
    const pA = nearestPos(track.positions, mjdA)!, pB = nearestPos(track.positions, mjdB)!;
    const predArcsec = angularSepArcsec(pA.ra, pA.dec, pB.ra, pB.dec);
    const xa = proj.skyToPix(pA.ra, pA.dec), xb = proj.skyToPix(pB.ra, pB.dec);
    const ca = measureCentroid(medianStack(fa), search.grid.n, xa.x, xa.y, 2.5);
    const cb = measureCentroid(medianStack(fb), search.grid.n, xb.x, xb.y, 2.5);
    const sat = [...fa, ...fb].filter((f) => f.saturated_at_center).length;
    let measured: { arcsec: number; err: number } | null = null;
    if (ca && cb) {
      const d = Math.hypot(cb.x - ca.x, cb.y - ca.y) * pixscale;
      const err = Math.hypot(ca.sx, ca.sy, cb.sx, cb.sy) * pixscale;
      measured = { arcsec: d, err };
    }
    return { det: current.detector, sA, sB, dtYr: (mjdB - mjdA) / 365.25, predArcsec, measured, nA: fa.length, nB: fb.length, sat };
  }, [current, search, track, proj, frames, pixscale]);

  // ---- Spectrum ----
  const nearCentre = probe && url.ra !== undefined && url.dec !== undefined ? angularSepArcsec(probe.ra, probe.dec, url.ra, url.dec) < 3 : false;
  const [specLive, setSpecLive] = useState<Aux<SpectrumResponse> | null>(null);
  const probeKey = probe ? `${probe.ra.toFixed(6)},${probe.dec.toFixed(6)}` : '';
  useEffect(() => {
    if (!isLive || !probe) return;
    const ctrl = new AbortController();
    const k = probeKey;
    fetchSpectrum(probe.ra, probe.dec, APERTURE_ARCSEC, ctrl.signal)
      .then((d) => setSpecLive({ key: k, status: 'ready', data: d }))
      .catch((e) => !ctrl.signal.aborted && setSpecLive({ key: k, status: 'error', data: null, error: (e as Error).message }));
    return () => ctrl.abort();
  }, [isLive, probeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const clientSpectrum = useMemo<SpectrumResponse | null>(() => {
    if (!search || !probePix) return null;
    const n = search.grid.n;
    const ix = Math.round(probePix.x), iy = Math.round(probePix.y);
    const overflowBit = flagBits.OVERFLOW ?? 1;
    const points: SpectrumPoint[] = [];
    for (const f of frames) {
      const r = gridAperture(f.pixels, n, probePix.x, probePix.y, APERTURE_ARCSEC / pixscale, pixscale);
      if (!r) continue;
      const fl = ix >= 0 && iy >= 0 && ix < n && iy < n ? f.flags[iy * n + ix] : 0;
      const names = Object.entries(flagBits).filter(([, b]) => fl & (1 << b)).map(([k]) => k);
      points.push({ lambda_um: f.lambda_um, flux: r.flux, err: r.err, unit: 'mJy', mjd: f.mjd, season: f.season, detector: f.detector, frame_id: f.id, flags: names, saturated: !!(fl & (1 << overflowBit)) });
    }
    return {
      points, classification: null,
      method: `r = ${APERTURE_ARCSEC}″, annulus +1.5…+4.5 px, bilinear-reprojected pixels`,
      caveats: url.lang === 'es'
        ? ['Cada cuadro mide UNA longitud de onda en esta posición.', 'Sin corrección de apertura; la reproyección suaviza el flujo.']
        : ['Each frame samples ONE wavelength at this position.', 'No aperture correction; reprojection smooths flux.'],
    };
  }, [search, probePix, frames, pixscale, flagBits, url.lang]);

  let specData: SpectrumResponse | null = null;
  let specSource: SpectrumSource = 'client';
  let specStatus: 'idle' | 'loading' | 'ready' | 'error' = 'ready';
  let specError: string | undefined;
  if (isLive) {
    if (specLive?.key === probeKey && specLive.status === 'ready') { specData = specLive.data; specSource = 'live'; }
    else if (specLive?.key === probeKey && specLive.status === 'error') { specData = clientSpectrum; specSource = 'client'; specError = specLive.error; }
    else { specStatus = 'loading'; specData = clientSpectrum; }
  } else if (data) {
    if (nearCentre && data.spectrum) { specData = data.spectrum; specSource = 'snapshot'; }
    else specData = clientSpectrum;
  } else specStatus = 'idle';

  const verdict = isLive ? (verdictLive?.key === reqKey ? verdictLive.data : null) : data?.verdict ?? null;
  const verdictStatus: 'idle' | 'loading' | 'ready' | 'error' = !data ? 'idle' : isLive ? (verdictLive?.key === reqKey ? verdictLive.status : 'loading') : 'ready';

  // ---- Playback ----
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [axis, setAxis] = useState<'time' | 'lambda'>('time');
  const stepTime = useCallback((dir: 1 | -1) => {
    if (!current) return;
    const pool = mode === 'raw' ? frames : [...matched].sort((a, b) => a.mjd - b.mjd);
    const i = pool.findIndex((f) => f.index === current.index);
    if (pool.length) select(pool[(i + dir + pool.length) % pool.length].index);
  }, [current, frames, matched, mode, select]);
  const stepLambda = useCallback((dir: 1 | -1) => {
    if (!current) return;
    const pool = frames.filter((f) => f.season === current.season).sort((a, b) => a.lambda_um - b.lambda_um);
    const i = pool.findIndex((f) => f.index === current.index);
    if (pool.length) select(pool[(i + dir + pool.length) % pool.length].index);
  }, [current, frames, select]);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => (axis === 'lambda' && mode !== 'raw' ? stepLambda(1) : stepTime(1)), 1000 / speed);
    return () => clearInterval(id);
  }, [playing, speed, axis, mode, stepTime, stepLambda]);

  const [zoom, setZoom] = useState(1);
  const setMode = useCallback((m: ViewMode) => setUrl((u) => ({ ...u, mode: m })), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (el && el.closest && el.closest('[data-cube]') && e.key.startsWith('Arrow')) return; // the cube handles its own arrows
      if (e.key === 'ArrowRight') { stepTime(1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { stepTime(-1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { stepLambda(1); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { stepLambda(-1); e.preventDefault(); }
      else if (e.key === ' ' && el.tagName !== 'BUTTON') { setPlaying((p) => !p); e.preventDefault(); }
      else if (e.key >= '1' && e.key <= '6') setMode(MODES[Number(e.key) - 1]);
      else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(4, z * 2));
      else if (e.key === '-') setZoom((z) => Math.max(1, z / 2));
      else if (e.key === 'f') setOv((o) => ({ ...o, flags: !o.flags }));
      else if (e.key === 'g') setOv((o) => ({ ...o, gaia: !o.gaia }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stepTime, stepLambda, setMode]);

  const point = useCallback((p: { ra: number; dec: number; target?: string }) => {
    setPlaying(false);
    setZoom(1);
    setUrl((u) => ({ ...u, ra: p.ra, dec: p.dec, target: p.target, t: undefined, lam: undefined }));
  }, []);

  // ---- Derived labels ----
  const satCount = frames.filter((f) => f.saturated_at_center).length;
  const originLabel = data ? (data.origin.kind === 'live' ? text.originLive : text.originSnapshot(data.origin.generated.slice(0, 10))) : '';
  const embedUrl = typeof window === 'undefined' ? '' : `${window.location.origin}/prism?${writeUrl({ ...url, embed: true })}`;
  const progressP = progress && progress.key === reqKey ? progress.p : null;
  const pct = progressP?.total ? Math.min(100, ((progressP.done ?? 0) / progressP.total) * 100) : null;
  const yrSpan = seasons.length ? (seasons[seasons.length - 1].end_mjd - seasons[0].start_mjd) / 365.25 : 0;

  const caption = current
    ? mode === 'frame' || mode === 'raw'
      ? `D${current.detector} · ${current.lambda_um.toFixed(3)} µm · ${current.date.slice(0, 16).replace('T', ' ')} UTC · S${current.season}`
      : view?.note ?? ''
    : '';

  return (
    <div className={`prism ${url.embed ? 'prism-embed' : ''}`}>
      {!url.embed && (
        <header className="masthead">
          <div className="masthead-id">
            <a className="wordmark p-display" href={url.lang === 'en' ? '/?lang=en' : '/'} title={url.lang === 'en' ? 'Sky view' : 'Vista del cielo'}>PRISM</a>
            <span className="masthead-sub p-label">SPHEREx · NASA Space Apps 2026</span>
          </div>
          <p className="masthead-tag">{text.tagline}</p>
          <nav className="masthead-nav">
            <button type="button" className="lang" aria-pressed={url.lang === 'es'} onClick={() => setUrl((u) => ({ ...u, lang: 'es' }))}>ES</button>
            <button type="button" className="lang" aria-pressed={url.lang === 'en'} onClick={() => setUrl((u) => ({ ...u, lang: 'en' }))}>EN</button>
            <a className="masthead-link" href="/classic">{text.classic}</a>
          </nav>
        </header>
      )}

      {!url.embed && (
        <TargetBar
          targets={targets}
          activeId={url.target}
          ra={url.ra}
          dec={url.dec}
          fov={url.fov}
          locale={url.lang}
          text={text}
          embedUrl={embedUrl}
          onPoint={point}
          onFov={(fov) => setUrl((u) => ({ ...u, fov }))}
        />
      )}

      <div className="origin-row">
        {data && (
          <span className={`origin origin-${data.origin.kind}`} role="status">
            <i aria-hidden /> {originLabel}
          </span>
        )}
        {data?.liveError && <span className="origin-note p-data">{data.liveError === LIVE_OFF ? text.liveOffSnapshot : text.liveDown(data.liveError.replace(/^\/search(\/stream)?: /, ''))}</span>}
        {preset && (
          <span className="origin-note">
            <span className="p-display preset-title">{preset.name}</span>{' '}
            {url.lang === 'en' ? (preset as (typeof PRESETS)[number]).blurb_en ?? preset.blurb : preset.blurb}
          </span>
        )}
      </div>

      {data && satCount > 0 && satCount / Math.max(1, frames.length) >= 0.3 && (
        <div className="banner banner-bad" role="alert">
          <span className="p-label">OVERFLOW</span> {text.saturated(satCount, frames.length)}
        </div>
      )}

      {loading && (
        <div className="state state-loading" role="status" aria-live="polite">
          <span className="p-label">{text.loading}</span>
          <span className="p-data">{progressP ? `${text.stage[progressP.stage] ?? progressP.stage}${progressP.message ? ` · ${progressP.message}` : ''}` : 'SIA2 · spherex_dr1, spherex_qr3'}</span>
          <span className="meter" aria-hidden><i className={pct === null ? 'meter-indet' : ''} style={pct === null ? undefined : { width: `${pct}%` }} /></span>
        </div>
      )}

      {fail && (
        <div className="state state-error" role="alert">
          <h2 className="p-display">{fail.noCoverage ? text.emptyTitle : fail.liveError === LIVE_OFF ? text.liveOffTitle : text.errorTitle}</h2>
          <p>{fail.noCoverage ? text.emptyBody : fail.liveError === LIVE_OFF ? text.liveOffBody : text.errorBody}</p>
          <p className="p-data state-detail">{fail.liveError === LIVE_OFF ? `snapshot: ${fail.message}` : `live: ${fail.liveError ?? fail.message}${fail.liveError ? ` · snapshot: ${fail.message}` : ''}`}</p>
          {fail.liveError !== LIVE_OFF && <button type="button" className="btn" onClick={() => setAttempt((a) => a + 1)}>{text.retry}</button>}
        </div>
      )}

      {data && !frames.length && (
        <div className="state state-empty" role="status">
          <h2 className="p-display">{text.emptyTitle}</h2>
          <p>{text.emptyBody}</p>
          <ul className="p-data state-detail">{search?.provenance.query_urls.map((q) => <li key={q}><a href={q} rel="noreferrer" target="_blank">{q}</a></li>)}</ul>
        </div>
      )}

      {data && current && search && view && (
        <main className="deck">
          <section className="deck-main">
            <div className="toolbar" role="toolbar" aria-label="mode">
              <div className="seg" role="radiogroup" aria-label="mode">
                {MODES.map((m, i) => (
                  <button key={m} type="button" role="radio" aria-checked={mode === m} className="seg-b" onClick={() => setMode(m)}>
                    <span className="seg-k p-data">{i + 1}</span>{text.modes[m]}
                  </button>
                ))}
              </div>
              <div className="toolbar-r">
                {view.kind === 'gray' && (
                  <label className="mini">
                    <span className="p-label">{text.stretch}</span>
                    <select className="select p-data" value={stretch} onChange={(e) => setStretch(e.target.value as Stretch)}>
                      <option value="asinh">asinh</option>
                      <option value="zscale">zscale</option>
                      <option value="linear">linear</option>
                    </select>
                  </label>
                )}
                {mode === 'diff' && (
                  <label className="mini">
                    <span className="p-label">{text.refSeason}</span>
                    <select className="select p-data" value={refSeason ?? ''} onChange={(e) => setRefPick(Number(e.target.value))}>
                      {[...new Set(matched.filter((f) => f.season !== current.season).map((f) => f.season))].sort().map((s) => <option key={s} value={s}>S{s}</option>)}
                    </select>
                  </label>
                )}
                {mode === 'goggles' && (
                  <div className="seg seg-small" role="radiogroup" aria-label="goggles">
                    {(Object.keys(GOGGLES) as GoggleId[]).map((g) => (
                      <button key={g} type="button" role="radio" aria-checked={goggle === g} className="seg-b" onClick={() => setGoggle(g)}>{g.replace('4', '₄').replace('2', '₂')}</button>
                    ))}
                  </div>
                )}
                <div className="seg seg-small" role="group" aria-label={text.zoom}>
                  {[1, 2, 4].map((z) => (
                    <button key={z} type="button" aria-pressed={zoom === z} className="seg-b" onClick={() => setZoom(z)}>{z}×</button>
                  ))}
                </div>
              </div>
            </div>
            <p className="mode-help">{text.modeHelp[mode]}</p>

            {mode === 'cube' ? (
              <div className="cube-wrap" data-cube>
                <SpectralCube3D frames={cubeFrames} current={currentIndex} onSelect={select} locale={url.lang} height="min(70vh, 640px)" />
              </div>
            ) : (
            <SkyCanvas
              grid={search.grid}
              image={view.image}
              kind={view.kind}
              stretch={stretch}
              levels={levels}
              divScale={divScale}
              unit={view.unit || '—'}
              flags={mode === 'frame' || mode === 'raw' ? current.flags : null}
              flagBits={flagBits}
              showFlags={ov.flags}
              gaia={gaiaRings}
              skybot={skybotRings}
              target={targetMark}
              centroid={centroid ? { x: centroid.x, y: centroid.y, sx: centroid.sx, sy: centroid.sy } : null}
              probe={probePix}
              zoom={zoom}
              caption={caption}
              captionColor={mode === 'goggles' || mode === 'coadd' ? 'transparent' : lambdaColor(current.lambda_um)}
              text={text}
              onProbe={onProbe}
            />
            )}

            <div className="layers" role="group" aria-label={text.overlays}>
              <span className="p-label">{text.overlays}</span>
              {(['target', 'gaia', 'skybot', 'centroid', 'flags'] as const).map((k) => (
                <button key={k} type="button" className={`chip chip-${k}`} aria-pressed={ov[k]} onClick={() => setOv((o) => ({ ...o, [k]: !o[k] }))}>
                  <i aria-hidden />{text.ov[k]}
                  {k === 'gaia' && gaia && <span className="p-data chip-n">{gaiaRings.length}</span>}
                  {k === 'skybot' && !isLive && <span className="p-data chip-n">—</span>}
                </button>
              ))}
              <span className="layers-note">{text.predictedLegend}{ov.gaia ? (url.lang === 'es' ? ' Vector = 10 años de movimiento propio.' : ' Vector = 10 yr of proper motion.') : ''}</span>
              {!isLive && ov.skybot && <span className="layers-note">{url.lang === 'es' ? 'SkyBoT requiere la API en vivo.' : 'SkyBoT needs the live API.'}</span>}
              {isLive && skybot?.status === 'error' && <span className="layers-note">SkyBoT: {skybot.error}</span>}
            </div>

            <section className="padwrap" aria-labelledby="pad-h">
              <header className="padwrap-h">
                <h2 id="pad-h" className="p-label">{text.pad}</h2>
                <div className="transport">
                  <button type="button" className="btn btn-primary" onClick={() => setPlaying((p) => !p)} aria-pressed={playing}>{playing ? text.pause : text.play}</button>
                  {mode !== 'raw' && (
                    <div className="seg seg-small" role="radiogroup" aria-label={text.axis}>
                      <button type="button" role="radio" aria-checked={axis === 'time'} className="seg-b" onClick={() => setAxis('time')}>{text.axisTime}</button>
                      <button type="button" role="radio" aria-checked={axis === 'lambda'} className="seg-b" onClick={() => setAxis('lambda')}>{text.axisLambda}</button>
                    </div>
                  )}
                  <div className="seg seg-small" role="radiogroup" aria-label={text.speed}>
                    {SPEEDS.map((s) => (
                      <button key={s} type="button" role="radio" aria-checked={speed === s} className="seg-b" onClick={() => setSpeed(s)}>{s} fps</button>
                    ))}
                  </div>
                </div>
              </header>
              <ScrubPad frames={frames} seasons={seasons} current={current} matched={matchedSet} raw={mode === 'raw'} refSeason={mode === 'diff' ? refSeason : null} text={text} onSelect={select} />
              <p className="panel-note">{mode === 'raw' ? text.modeHelp.raw : text.padHelp} <span className="p-data">{text.keyboard}</span></p>
            </section>
          </section>

          <aside className="deck-side">
            <section className="panel readout" aria-labelledby="ro-h">
              <header className="panel-h">
                <h2 id="ro-h" className="p-display">{current.provenance.obs_id}</h2>
                <span className="p-data panel-sub">{current.collection}</span>
              </header>
              <dl className="kv p-data">
                <dt>{text.date}</dt><dd>{current.date.replace('T', ' ').slice(0, 19)} · MJD {current.mjd.toFixed(5)}</dd>
                <dt>{text.lambda}</dt><dd><i className="sw" style={{ background: lambdaColor(current.lambda_um) }} />{current.lambda_um.toFixed(4)} µm · {text.band} {current.bandwidth_um.toFixed(4)} µm</dd>
                <dt>{text.detector}</dt><dd>D{current.detector} · {text.season} S{current.season} ({formatMjdDate(seasons.find((s) => s.index === current.season)?.start_mjd ?? current.mjd)})</dd>
                <dt>{text.valid}</dt><dd>{(current.valid_fraction * 100).toFixed(1)}%{current.saturated_at_center ? ' · OVERFLOW @ centre' : ''}</dd>
                <dt>{text.matched}</dt><dd>{matched.length} {text.frames} · {new Set(matched.map((f) => f.season)).size} {text.seasons}</dd>
                <dt>FITS</dt><dd><a href={current.provenance.url} target="_blank" rel="noreferrer">IRSA cutout</a></dd>
              </dl>
              <div className="motion">
                <span className="p-label">{text.motion}</span>
                {preset?.expected?.pm_arcsec_yr ? (
                  <p className="p-data">{text.expected}: {text.pmLine(preset.expected.pm_arcsec_yr, yrSpan, (preset.expected.pm_arcsec_yr * yrSpan) / pixscale)} · PSF ≈ 1.3 px</p>
                ) : null}
                {motion ? (
                  <>
                    <p className="p-data">{text.predictedShift} D{motion.det} S{motion.sA}→S{motion.sB} ({motion.dtYr.toFixed(2)} yr): {motion.predArcsec.toFixed(2)}″ = {(motion.predArcsec / pixscale).toFixed(2)} px</p>
                    <p className="p-data">
                      {text.measuredShift}: {motion.measured ? `${motion.measured.arcsec.toFixed(2)}″ ± ${motion.measured.err.toFixed(2)}″ (co-adds ${motion.nA}+${motion.nB})` : text.noCentroid}
                      {motion.sat ? ` · ${motion.sat} sat.` : ''}
                    </p>
                  </>
                ) : (
                  <p className="p-data">{centroid ? `${text.measured} (${text.modes[mode]}): S/N ${centroid.snr.toFixed(1)} · σ ${(centroid.sx * pixscale).toFixed(2)}″ × ${(centroid.sy * pixscale).toFixed(2)}″` : text.noCentroid}</p>
                )}
              </div>
            </section>

            <VerdictPanel
              data={verdict}
              status={verdictStatus}
              error={verdictLive?.error}
              sourceLabel={isLive ? '/v2/verdict' : verdict?.method ?? ''}
              text={text}
            />

            {probe && (
              <SpectrumPanel
                data={specData}
                source={specSource}
                status={specStatus}
                error={specError}
                probe={probe}
                currentFrameId={current.id}
                text={text}
              />
            )}
          </aside>
        </main>
      )}

      {data && search && (
        <footer className="colophon">
          <div>
            <span className="p-label">{text.provenance}</span>
            <p>{search.provenance.citation}</p>
            <p className="p-data">{search.provenance.collections.join(' · ')} · {frames.length} {text.frames} · {seasons.length} {text.seasons} · {formatRa(search.query.ra)} {formatDec(search.query.dec)} · {search.query.fov}′ · {search.grid.n}×{search.grid.n} px @ {search.grid.pixscale_arcsec}″</p>
          </div>
          {search.provenance.processing && (
            <div>
              <span className="p-label">{text.processing}</span>
              <p>{String(search.provenance.processing)}</p>
            </div>
          )}
          <div>
            <span className="p-label">{text.queries}</span>
            <ul className="p-data">{search.provenance.query_urls.map((q) => <li key={q}><a href={q} target="_blank" rel="noreferrer">{q.replace('https://', '')}</a></li>)}</ul>
            <p className="p-data">generated {search.provenance.generated_utc}</p>
          </div>
        </footer>
      )}
    </div>
  );
}
