'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, withLang } from '../../lib/i18n';
import type { Messages } from '../../lib/i18n/en';
import BrandMark from '../brand/BrandMark';
import SiteNav from '../site/SiteNav';
import { formatDec, formatRA, parseRaDec } from './astro';
import { COSMOS_PRESETS, findPreset, resolveWithSesame, type CosmosPresetId } from './presets';
import { loadStarCatalog } from './stars';
import type { CosmosEngine, CosmosLabels, CosmosMode, CosmosViewState } from './CosmosEngine';
import Reticle from './Reticle';
import { keepGreek } from '../../lib/prism/greek';

const SURVEY_DAYS = 184; // 2025-05-01 → 2025-11-01
const SURVEY_START_MS = Date.UTC(2025, 4, 1);
const AUTO_NAV_S = 4;
const LOCK_FOV = 6;
const ENTRY_IDS = ['explore', 'sky', 'symphony', 'look', 'song'] as const;

interface Target {
  id?: CosmosPresetId;
  name: string;
  ra: number;
  dec: number;
  epoch: string;
}

/** Entry points to the four sections. Rendered twice (side column on wide screens, inline in the
 * panel on narrow ones); CSS shows exactly one, so only one is in the accessibility tree. */
function EntryList({ variant }: { variant: 'side' | 'inline' }) {
  const { locale, t: all } = useLocale();
  const t = all.cosmos;
  return (
    <nav className={`cz-entries cz-entries-${variant}`} aria-label={t.entriesLabel}>
      <p className="p-label">{t.entriesLabel}</p>
      <ol>
        {ENTRY_IDS.map((id, i) => (
          <li key={id}>
            <a href={withLang(`/${id}`, locale)}>
              <span className="cz-entry-n p-data">{String(i + 1).padStart(2, '0')}</span>
              <span className="cz-entry-name">{all.nav[id]}</span>
              <span className="cz-entry-desc">{t.entries[id]}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
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

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

const engineLabels = (tx: Messages['cosmos']): CosmosLabels => ({
  ecliptic: tx.ecliptic,
  galactic: tx.galactic,
  sun: tx.sun,
  earth: tx.earth,
  spacecraft: tx.spacecraft,
  moon: tx.moon,
  planets: tx.planets,
});

const utcStamp = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const isoDay = (day: number) => new Date(SURVEY_START_MS + day * 86400000).toISOString().slice(0, 10);

export default function CosmosLanding() {
  const { locale, t: all } = useLocale();
  const t = all.cosmos;
  const router = useRouter();
  const reduced = useReducedMotion();
  const [force3d, setForce3d] = useState(false);
  const [webgl, setWebgl] = useState(true);
  const use3d = webgl && (!reduced || force3d);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLElement>(null);
  const topRef = useRef<HTMLElement>(null);
  const engineRef = useRef<CosmosEngine | null>(null);
  const [ready, setReady] = useState(false);
  const [starCount, setStarCount] = useState(0);
  const [view, setView] = useState<CosmosViewState>({
    mode: 'orbit',
    ra: 0,
    dec: 0,
    fov: 38,
    day: 0,
    flying: false,
    date: 0,
    live: true,
    subSolar: { lat: 0, lon: 0 },
    moonPhase: 0,
  });
  const [day, setDay] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [locked, setLocked] = useState<Target | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef(t);
  const pickRef = useRef<((ra: number, dec: number) => void) | null>(null);
  useEffect(() => {
    textRef.current = t;
  }, [t]);

  // ---------------------------------------------------------- engine boot
  useEffect(() => {
    if (!hasWebGL()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- capability probe needs the DOM
      setWebgl(false);
      return;
    }
    if (!use3d || !canvasRef.current || !labelsRef.current) return;
    let cancelled = false;
    const ctl = new AbortController();
    let engine: CosmosEngine | null = null;
    Promise.all([import('./CosmosEngine'), loadStarCatalog(ctl.signal)])
      .then(([mod, stars]) => {
        if (cancelled || !canvasRef.current || !labelsRef.current) return;
        const tx = textRef.current;
        engine = new mod.CosmosEngine(canvasRef.current, labelsRef.current, {
          reducedMotion: reduced,
          onView: setView,
          onPick: (ra, dec) => pickRef.current?.(ra, dec),
          labels: engineLabels(tx),
        });
        engine.setStars(stars);
        engineRef.current = engine;
        setStarCount(stars.n);
        setReady(true);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      ctl.abort();
      engine?.dispose();
      engineRef.current = null;
      setReady(false);
    };
  }, [use3d, reduced]);

  // Relabel engine-side labels on locale change.
  useEffect(() => {
    engineRef.current?.setLabels(engineLabels(t));
  }, [t, ready]);

  // Pause rendering when the tab is hidden or the stage is off-screen.
  useEffect(() => {
    if (!ready || !stageRef.current) return;
    let onScreen = true;
    const sync = () => engineRef.current?.setActive(onScreen && document.visibilityState === 'visible');
    const io = new IntersectionObserver((entries) => {
      onScreen = entries[0]?.isIntersecting ?? true;
      sync();
    });
    io.observe(stageRef.current);
    document.addEventListener('visibilitychange', sync);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
  }, [ready]);

  // Survey playback is driven by the engine; mirror its day into React.
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const e = engineRef.current;
      if (!e) return;
      const d = e.getDay();
      setDay(d);
      if (d >= SURVEY_DAYS) setPlaying(false);
    }, 100);
    return () => window.clearInterval(id);
  }, [playing]);

  useEffect(() => {
    engineRef.current?.setPlaying(playing);
  }, [playing, ready]);

  // ---------------------------------------------------------- navigation
  const prismHref = useCallback(
    (tg: Target) => {
      const p = new URLSearchParams({ ra: tg.ra.toFixed(6), dec: tg.dec.toFixed(6) });
      if (tg.id) p.set('target', tg.id);
      return withLang(`/explore?${p.toString()}`, locale);
    },
    [locale],
  );

  useEffect(() => {
    if (!locked) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- countdown starts when a lock lands
    setCountdown(AUTO_NAV_S);
    const started = performance.now();
    const id = window.setInterval(() => {
      const left = AUTO_NAV_S - Math.floor((performance.now() - started) / 1000);
      if (left <= 0) {
        window.clearInterval(id);
        setCountdown(0);
        router.push(prismHref(locked));
      } else setCountdown(left);
    }, 200);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        window.clearInterval(id);
        setCountdown(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('keydown', onKey);
    };
  }, [locked, router, prismHref]);

  const lockOn = useCallback(async (tg: Target) => {
    setLocked(null);
    setCountdown(null);
    setStatus(null);
    const e = engineRef.current;
    if (e) await e.flyTo(tg.ra, tg.dec, LOCK_FOV);
    setLocked(tg);
  }, []);

  useEffect(() => {
    pickRef.current = (ra, dec) => void lockOn({ name: textRef.current.custom, ra, dec, epoch: 'J2000' });
  }, [lockOn]);

  const onSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const q = query.trim();
    if (!q) return;
    const coords = parseRaDec(q);
    if (coords) return lockOn({ name: t.custom, ...coords, epoch: 'J2000' });
    const preset = findPreset(q);
    if (preset) return lockOn({ id: preset.id, name: preset.name, ra: preset.ra, dec: preset.dec, epoch: preset.epoch });
    setStatus(t.resolving);
    const r = await resolveWithSesame(q);
    if (r) return lockOn({ name: q, ra: r.ra, dec: r.dec, epoch: 'J2000 · CDS Sesame' });
    setStatus(t.notFound(q));
  };

  const setMode = (m: CosmosMode) => {
    setLocked(null);
    setCountdown(null);
    void engineRef.current?.setMode(m);
  };

  const onCanvasKey = (e: React.KeyboardEvent) => {
    const eng = engineRef.current;
    if (!eng) return;
    const step = 24;
    const map: Record<string, () => void> = {
      ArrowLeft: () => eng.nudge(step, 0),
      ArrowRight: () => eng.nudge(-step, 0),
      ArrowUp: () => eng.nudge(0, step),
      ArrowDown: () => eng.nudge(0, -step),
      '+': () => eng.zoom(0.8),
      '=': () => eng.zoom(0.8),
      '-': () => eng.zoom(1.25),
    };
    const fn = map[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  const backToNow = () => {
    setPlaying(false);
    engineRef.current?.setLive();
  };

  const fmtLat = (v: number) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? t.compass.n : t.compass.s}`;
  const fmtLon = (v: number) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? t.compass.e : t.compass.w}`;

  // The target panel scrolls above the bottom bar instead of sliding under it.
  useEffect(() => {
    const root = rootRef.current, bottom = bottomRef.current, top = topRef.current;
    if (!root || !bottom || typeof ResizeObserver === 'undefined') return;
    const sync = () => {
      root.style.setProperty('--cz-bottom-h', `${Math.ceil(bottom.getBoundingClientRect().height)}px`);
      if (top) root.style.setProperty('--cz-top-h', `${Math.ceil(top.getBoundingClientRect().bottom) + 10}px`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(bottom);
    if (top) ro.observe(top);
    return () => ro.disconnect();
  }, []);

  const mode = view.mode;
  const showReticle = !!locked && !view.flying;

  return (
    <div className="cz-root" ref={rootRef} data-mode={mode} data-locked={locked ? '' : undefined}>
      <div className="cz-stage" ref={stageRef}>
        {use3d ? (
          <>
            <canvas
              ref={canvasRef}
              className="cz-canvas"
              tabIndex={0}
              aria-label={t.canvasLabel}
              onKeyDown={onCanvasKey}
            />
            <div className="cz-labels" ref={labelsRef} />
          </>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- static fallback, intrinsic size known
          <img className="cz-static" src="/cosmos/cosmos-static.jpg" alt="" width={1600} height={900} />
        )}
        {showReticle && use3d && <Reticle fov={view.fov} ra={locked.ra} dec={locked.dec} reduced={reduced} />}
      </div>

      <header className="cz-top" ref={topRef}>
        <BrandMark size="sm" href={null} className="cz-brand" />
        <div className="cz-top-r">
          {use3d && (
            <div className="cz-seg" role="group" aria-label={t.modeLabel}>
              <button type="button" aria-pressed={mode === 'orbit'} onClick={() => setMode('orbit')} disabled={!ready}>
                {t.modeOrbit}
              </button>
              <button type="button" aria-pressed={mode === 'sky'} onClick={() => setMode('sky')} disabled={!ready}>
                {t.modeSky}
              </button>
            </div>
          )}
          <SiteNav current="home" className="cz-nav" />
        </div>
      </header>

      <EntryList variant="side" />

      <section className="cz-panel" aria-labelledby="cz-title">
        <p className="p-label">{t.kicker}</p>
        <h1 id="cz-title" className="cz-title p-display">
          {t.title}
        </h1>
        <p className="cz-lede">{t.lede}</p>
        <EntryList variant="inline" />


        <form className="cz-search" onSubmit={onSubmit} role="search">
          <label htmlFor="cz-q" className="p-label">
            {keepGreek(t.searchLabel)}
          </label>
          <div className="cz-search-row">
            <input
              id="cz-q"
              className="p-data"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.placeholder}
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" className="cz-go">
              {t.go}
            </button>
          </div>
          <p className="cz-status p-data" role="status" aria-live="polite">
            {status ?? ''}
          </p>
        </form>

        <table className="cz-presets">
          <caption className="p-label">{t.presets}</caption>
          <thead>
            <tr>
              <th scope="col">{t.colTarget}</th>
              <th scope="col">α</th>
              <th scope="col">δ</th>
            </tr>
          </thead>
          <tbody>
            {COSMOS_PRESETS.map((p) => (
              <tr key={p.id} data-active={locked?.id === p.id || undefined}>
                <th scope="row">
                  <button
                    type="button"
                    onClick={() => lockOn({ id: p.id, name: p.name, ra: p.ra, dec: p.dec, epoch: p.epoch })}
                  >
                    <span className="cz-pname">{p.name}</span>
                    <span className="cz-pkind">{all.targets[p.id]?.kind ?? ''}</span>
                  </button>
                </th>
                <td className="p-data">{formatRA(p.ra, 0)}</td>
                <td className="p-data">{formatDec(p.dec)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {locked && (
        <aside className="cz-lock" aria-live="polite">
          <p className="p-label cz-lock-k">{t.locked}</p>
          <p className="cz-lock-name p-display">{locked.name}</p>
          <dl className="p-data">
            <div>
              <dt>α</dt>
              <dd>{formatRA(locked.ra, 2)}</dd>
            </div>
            <div>
              <dt>δ</dt>
              <dd>{formatDec(locked.dec, 1)}</dd>
            </div>
            <div>
              <dt>{t.degLabel}</dt>
              <dd>
                {locked.ra.toFixed(5)} {locked.dec >= 0 ? '+' : '−'}
                {Math.abs(locked.dec).toFixed(5)}
              </dd>
            </div>
            <div>
              <dt>{t.epoch}</dt>
              <dd>{locked.epoch}</dd>
            </div>
          </dl>
          <div className="cz-lock-actions">
            <a className="cz-go" href={prismHref(locked)} autoFocus>
              {t.open} →
            </a>
            <button
              type="button"
              className="cz-ghost"
              onClick={() => {
                setCountdown(null);
                setLocked(null);
              }}
            >
              {t.stay}
            </button>
          </div>
          {countdown !== null && countdown > 0 && (
            <div className="cz-count p-data">
              <span>{t.autoNav(countdown)}</span>
              <span className="cz-count-bar" style={{ ['--k' as string]: `${(countdown / AUTO_NAV_S) * 100}%` }} />
            </div>
          )}
        </aside>
      )}

      <footer className="cz-bottom" ref={bottomRef}>
        <div className="cz-readout p-data" aria-live="off">
          {use3d && ready ? (
            <>
              <span className="cz-clock">
                <b>{view.live ? t.clockNow : t.clockSurvey}</b> {view.date ? utcStamp(view.date) : ''}
                {!view.live && (
                  <button type="button" className="cz-ghost cz-now" onClick={backToNow}>
                    {t.clockBack}
                  </button>
                )}
              </span>
              {mode === 'sky' ? (
                <>
                  <span>
                    <b>{t.centre}</b> α {formatRA(view.ra, 0)} δ {formatDec(view.dec)}
                  </span>
                  <span>
                    <b>{t.fov}</b> {view.fov.toFixed(view.fov < 10 ? 1 : 0)}°{view.fov < 20 ? ` · ${t.fineGrid}` : ''}
                  </span>
                </>
              ) : (
                <>
                  <span>
                    <b>☉</b> {t.subSolar(fmtLat(view.subSolar.lat), fmtLon(view.subSolar.lon))} · {t.moonLit(Math.round(view.moonPhase * 100))}
                  </span>
                  <span>
                    <b>{t.orbitLbl}</b> {t.orbitDesc}
                  </span>
                </>
              )}
              <span className="cz-dim cz-hint">{mode === 'sky' && view.fov < 20 ? t.bscLimit : t.dblHint}</span>
            </>
          ) : (
            <span className="cz-dim">{error ?? (!webgl ? t.noWebgl : reduced && !force3d ? t.reduced : '…')}</span>
          )}
          {!use3d && webgl && (
            <button type="button" className="cz-ghost" onClick={() => setForce3d(true)}>
              {t.load3d}
            </button>
          )}
        </div>

        {use3d && (
          <div className="cz-survey">
            <div className="cz-survey-head">
              <span className="p-label">{t.survey}</span>
              <span className="p-data cz-date">
                {isoDay(day)} · {t.day} {Math.round(day).toString().padStart(3, '0')}/{SURVEY_DAYS}
              </span>
            </div>
            <div className="cz-survey-row">
              <button
                type="button"
                className="cz-play"
                aria-label={playing ? t.pause : t.play}
                disabled={!ready}
                onClick={() => {
                  if (!playing && day >= SURVEY_DAYS) {
                    setDay(0);
                    engineRef.current?.setDay(0);
                  }
                  setPlaying((p) => !p);
                }}
              >
                {playing ? (
                  <svg viewBox="0 0 10 10" aria-hidden="true"><rect x="2" y="1.5" width="2" height="7" /><rect x="6" y="1.5" width="2" height="7" /></svg>
                ) : (
                  <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 1.5 L8.5 5 L2.5 8.5 Z" /></svg>
                )}
              </button>
              <div className="cz-scrub">
                <input
                  type="range"
                  min={0}
                  max={SURVEY_DAYS}
                  step={1}
                  value={Math.round(day)}
                  disabled={!ready}
                  aria-label={t.survey}
                  aria-valuetext={`${isoDay(day)}, ${t.day} ${Math.round(day)}`}
                  onChange={(e) => {
                    const d = Number(e.target.value);
                    setPlaying(false);
                    setDay(d);
                    engineRef.current?.setDay(d);
                  }}
                />
                <div className="cz-ticks p-data" aria-hidden="true">
                  {[0, 31, 61, 92, 123, 153, 184].map((d) => (
                    <span key={d} style={{ left: `${(d / SURVEY_DAYS) * 100}%` }}>
                      {new Date(SURVEY_START_MS + d * 86400000).toLocaleDateString(locale, { month: 'short', timeZone: 'UTC' })}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <p className="cz-note">{t.surveyNote}</p>
          </div>
        )}

        <ul className="cz-legend p-data">
          <li><i className="lg-grid" />{t.legendGrid}</li>
          <li><i className="lg-ecl" />{t.legendEcl}</li>
          <li><i className="lg-gal" />{t.legendGal}</li>
          {use3d && <li><i className="lg-cov" />{t.legendCov}</li>}
          {use3d && <li><i className="lg-now" />{t.legendNow}</li>}
          {use3d && <li><i className="lg-body" />{t.legendBodies}</li>}
          {use3d && mode === 'orbit' && <li className="cz-dim">{t.scaleNote}</li>}
          {use3d && mode === 'orbit' && <li className="cz-dim">{t.cloudNote}</li>}
          {starCount > 0 && <li className="cz-dim">{t.stars(starCount)}</li>}
          <li className="cz-credits-li">
            <details className="cz-credits">
              <summary>{t.creditsTitle}</summary>
              <ul>
                {t.credits.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </details>
          </li>
        </ul>
      </footer>
    </div>
  );
}
