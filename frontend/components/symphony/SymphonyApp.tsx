'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocale, withLang } from '../../lib/i18n';
import { PRESETS } from '../../lib/prism/presets';
import { loadSnapshot } from '../../lib/prism/snapshot';
import { analyseSpectrum, binToBands } from '../../lib/symphony/core';
import type { SymphonySpectrum } from '../../lib/symphony/engine';
import { brightestNearCentre, preparePlate, regionSpectrum, type Plate, type RegionMode } from '../../lib/symphony/region';
import SiteHeader from '../site/SiteHeader';

const noopSubscribe = () => () => {};
import ExportPanel from './ExportPanel';
import PlateCanvas from './PlateCanvas';
import SpectralKeyboard from './SpectralKeyboard';
import TimbreList, { featureSummary } from './TimbreList';
import Transport from './Transport';
import { downloadBlob, useSymphony } from './useSymphony';

interface Loaded { id: string; name: string; generated: string; plate: Plate }

const DEFAULT_ID = 'm101';
const MIN_R = 1;
const MAX_R = 8;

function readInitialTarget(): string {
  if (typeof window === 'undefined') return DEFAULT_ID;
  const id = new URLSearchParams(window.location.search).get('target');
  return id && PRESETS.some((p) => p.id === id) ? id : DEFAULT_ID;
}

export default function SymphonyApp() {
  const { locale, t } = useLocale();
  // "700 years ago" from today's year (the static prerender says 1326, the build year − 700).
  const ago700 = useSyncExternalStore(noopSubscribe, () => new Date().getFullYear() - 700, () => 1326);
  const ts = t.symphony;
  const s = useSymphony();
  const { setSpectrum, getEngine } = s;

  const [targetId, setTargetId] = useState<string>(DEFAULT_ID);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [pos, setPos] = useState({ x: 19, y: 19 });
  const [r, setR] = useState(2.5);
  const [mode, setMode] = useState<RegionMode>('source');
  const [recSecs, setRecSecs] = useState<number | null>(null);
  const cache = useRef(new Map<string, Loaded>());
  const fieldListRef = useRef<HTMLUListElement>(null);

  // Target from ?target= once on the client (the server renders the default).
  useEffect(() => {
    const id = readInitialTarget();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from the URL after hydration
    if (id !== DEFAULT_ID) setTargetId(id);
  }, []);

  // Load (or reuse) the snapshot for the chosen field.
  useEffect(() => {
    const hit = cache.current.get(targetId);
    const ctrl = new AbortController();
    const applyLoaded = (l: Loaded) => {
      setLoaded(l);
      setPos(brightestNearCentre(l.plate));
      setProgress(null);
    };
    if (hit) {
      applyLoaded(hit);
      return;
    }
    setError(false);
    setProgress(ts.loadingPlate(''));
    loadSnapshot(targetId, (p) => setProgress(ts.loadingPlate(p.message ?? '')), ctrl.signal)
      .then(({ snapshot, search }) => {
        const l: Loaded = { id: targetId, name: snapshot.name, generated: snapshot.generated_utc, plate: preparePlate(search) };
        cache.current.set(targetId, l);
        applyLoaded(l);
      })
      .catch((e: unknown) => {
        if ((e as { name?: string })?.name === 'AbortError') return;
        setProgress(null);
        setError(true);
      });
    return () => ctrl.abort();
    // ts.loadingPlate changes with the locale only; the load itself must not restart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);

  // Keep ?target= in the URL (and ?lang=), without a navigation; keep the chosen field visible.
  useEffect(() => {
    const list = fieldListRef.current;
    const btn = list?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (list && btn) {
      const li = btn.parentElement as HTMLElement;
      if (li.offsetLeft < list.scrollLeft || li.offsetLeft + li.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = li.offsetLeft - 16;
    }
    const url = new URL(window.location.href);
    if (targetId === DEFAULT_ID) url.searchParams.delete('target');
    else url.searchParams.set('target', targetId);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
  }, [targetId]);

  const region = useMemo(() => {
    if (!loaded) return null;
    return regionSpectrum(loaded.plate, pos.x, pos.y, r, mode);
  }, [loaded, pos, r, mode]);

  const label = loaded ? `${loaded.name} · (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)})` : '';
  const spectrum = useMemo<SymphonySpectrum | null>(
    () => (region && region.nFrames > 0 ? { lambda_um: region.lambda_um, intensity: region.intensity, label, provenance: 'spherex' } : null),
    [region, label],
  );
  const analysis = useMemo(() => (spectrum ? analyseSpectrum(binToBands(spectrum.lambda_um, spectrum.intensity)) : null), [spectrum]);

  // Real-time: every move of the circle feeds the engine, which glides to the new spectrum.
  useEffect(() => {
    setSpectrum(spectrum);
  }, [spectrum, setSpectrum]);

  const startRec = useCallback(async () => {
    if (!s.playing) await s.play();
    const e = getEngine();
    if (e?.startRecording(60)) setRecSecs(0);
  }, [s, getEngine]);

  const stopRec = useCallback(() => {
    const e = getEngine();
    const blob = e?.stopRecording();
    setRecSecs(null);
    if (blob) downloadBlob(blob, `listar-${targetId}-${Date.now()}.wav`);
  }, [getEngine, targetId]);

  // Recording timer.
  useEffect(() => {
    if (recSecs === null) return;
    const id = setInterval(() => {
      const e = getEngine();
      if (!e || !e.isRecording) return;
      const secs = Math.floor(e.recordingSeconds);
      setRecSecs(secs);
      if (secs >= 60) stopRec();
    }, 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recSecs === null, getEngine]);

  const move = useCallback((x: number, y: number) => setPos({ x, y }), []);
  const arcsec = loaded ? (r * loaded.plate.pixscale_arcsec).toFixed(0) : '0';
  const announce = featureSummary(analysis, ts);
  const snapDate = loaded ? loaded.generated.slice(0, 10) : '';

  return (
    <div className="site-page sym-page">
      <SiteHeader current="symphony" />
      <main className="sym-main" id="main">
        <header className="sym-intro">
          <p className="p-label">{ts.eyebrow}</p>
          <h1 className="sym-h1 p-display">{ts.title}</h1>
          <p className="sym-lede">{ts.lede}</p>
          <p className="sym-integrity">
            <span className="sym-tag">{ts.integritySpherex}</span>
            <span className="sym-help">{ts.integrityNote}</span>
          </p>
        </header>

        <section className="sym-fields" aria-labelledby="sym-field-label">
          <div className="sym-fields-head">
            <h2 id="sym-field-label" className="p-label">{ts.fieldLabel}</h2>
            <span className="sym-help">{ts.fieldHint}</span>
          </div>
          <ul className="sym-field-list" ref={fieldListRef}>
            {PRESETS.map((p) => (
              <li key={p.id}>
                <button type="button" className="sym-field" aria-pressed={p.id === targetId} onClick={() => setTargetId(p.id)}>
                  <span className="sym-field-name">{p.name}</span>
                  <span className="sym-field-kind">{t.targets[p.id]?.kind}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <div className="sym-stage">
          <section className="sym-plate-col" aria-label={ts.plateTitle}>
            {loaded && loaded.id === targetId ? (
              <>
                <PlateCanvas
                  image={loaded.plate.coadd}
                  n={loaded.plate.n}
                  x={pos.x}
                  y={pos.y}
                  r={r}
                  minR={MIN_R}
                  maxR={MAX_R}
                  ariaLabel={ts.plateAria(Math.round(pos.x), Math.round(pos.y), arcsec)}
                  onMove={move}
                  onRadius={setR}
                />
                <p className="sym-caption p-data">
                  {ts.plateCaption(loaded.plate.frames.length, ((loaded.plate.n * loaded.plate.pixscale_arcsec) / 60).toFixed(1))}
                </p>
                <p className="sym-caption p-data">{ts.snapshotNote(snapDate)}</p>
              </>
            ) : (
              <div className="sym-plate sym-plate-empty" role="status">
                <span>{error ? ts.loadError : progress ?? t.common.loading}</span>
              </div>
            )}
            <p className="sym-help">{ts.regionHint}</p>
          </section>

          <section className="sym-control-col" aria-label={ts.timbreTitle}>
            <Transport s={s} />
            {!s.playing && <p className="sym-help">{ts.playHint}</p>}

            <div className="sym-row">
              <label className="sym-range">
                <span className="p-label">{ts.radius}</span>
                <input type="range" min={MIN_R} max={MAX_R} step={0.5} value={r} onChange={(e) => setR(Number(e.target.value))} />
                <span className="p-data sym-range-val">{arcsec}″</span>
              </label>
            </div>

            <fieldset className="sym-mode">
              <legend className="p-label">{ts.modeLabel}</legend>
              {(['source', 'sky'] as RegionMode[]).map((m) => (
                <label key={m} className="sym-mode-opt">
                  <input type="radio" name="sym-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
                  <span>
                    <span className="sym-mode-name">{m === 'source' ? ts.modeSource : ts.modeSky}</span>
                    <span className="sym-help">{m === 'source' ? ts.modeSourceHint : ts.modeSkyHint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="sym-timbre-wrap">
              <h2 className="p-label">{ts.timbreTitle}</h2>
              <TimbreList analysis={analysis} />
            </div>

            <div className="sym-rec">
              {recSecs === null ? (
                <button type="button" className="sym-btn" onClick={() => void startRec()} disabled={!s.supported || !spectrum}>{ts.record}</button>
              ) : (
                <button type="button" className="sym-btn is-rec" onClick={stopRec}>{ts.stopRecord(recSecs)}</button>
              )}
              <span className="sym-help">{ts.recordHint}</span>
            </div>

            <ExportPanel spectrum={spectrum} slug={loaded ? `${targetId}-${pos.x.toFixed(0)}-${pos.y.toFixed(0)}` : targetId} />
          </section>
        </div>

        <section className="sym-kb-section" aria-labelledby="sym-kb-title">
          <div className="sym-kb-head">
            <h2 id="sym-kb-title" className="sym-h2 p-display">{ts.keyboardTitle}</h2>
            <span className="p-data sym-kb-stats">
              {analysis ? ts.bandsFilled(analysis.valid) : ''}
              {region ? ` · ${ts.framesUsed(region.nFrames, region.nPixels)}` : ''}
            </span>
          </div>
          <SpectralKeyboard
            bands={analysis?.norm ?? null}
            getEngine={getEngine}
            playing={s.playing}
            ariaLabel={ts.keyboardAria(analysis?.valid ?? 0)}
            shortLabel={ts.keyboardShort}
            longLabel={ts.keyboardLong}
          />
          <p className="sym-help">{ts.keyboardLegend}</p>
          <p className="sym-sr" aria-live="polite">{s.playing ? announce : ''}</p>
        </section>

        <div className="sym-lower">
          <section className="sym-how" aria-labelledby="sym-how-title">
            <h2 id="sym-how-title" className="sym-h2 p-display">{ts.howTitle}</h2>
            <ol>
              {ts.howSteps.map((step, i) => <li key={i}>{step}</li>)}
            </ol>
          </section>
          <section className="sym-epoch" aria-labelledby="sym-epoch-title">
            <p className="p-label">{ago700}</p>
            <h2 id="sym-epoch-title" className="sym-h2 p-display">{ts.epochTitle}</h2>
            <p>{ts.epochBody(ago700)}</p>
            <a className="site-btn" href={withLang('/sky?epoch=ago700', locale)}>{ts.epochCta(ago700)}</a>
          </section>
        </div>
      </main>
      <footer className="site-footer p-data">{t.common.credit}</footer>
    </div>
  );
}
