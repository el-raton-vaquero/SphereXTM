'use client';

/* eslint-disable @next/next/no-img-element -- external hips2fits cut-outs, not optimisable */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, withLang } from '../../lib/i18n';
import { formatDec, formatRa } from '../../lib/prism/coords';
import type { Progress } from '../../lib/prism/types';
import { HIPS_CREDIT, HIPS_HOSTS, HIPS_LAYERS, HIPS_POLICY_URL, HIPS_RANGE_UM, HIPS_RELEASE, hips2fitsUrl, wcsFovDeg, type HipsLayer, type TanWcs } from '../../lib/look/hips';
import { RegionUnavailable, loadRegion, targetsByDistance, type RegionImage } from '../../lib/look/region';

export type HipsStatus = 'loading' | 'ok' | 'failed';

/** Outcome per cut-out URL, so remounting (side-by-side <-> blend) does not wait for a dead host again. */
const HIPS_MEMO = new Map<string, { key: string; host: number; status: HipsStatus }>();

/** A real SPHEREx HiPS cut-out for an exact TAN WCS, trying the CDS mirror when the main host fails. */
export function HipsImage({ wcs, layer, className, style, onStatus, alt }: {
  wcs: TanWcs; layer: HipsLayer; className?: string; style?: React.CSSProperties; onStatus?: (s: HipsStatus) => void; alt: string;
}) {
  const urls = useMemo(() => HIPS_HOSTS.map((h) => hips2fitsUrl(layer, wcs, h)), [layer, wcs]);
  const key = urls[0];
  const [state, setStateRaw] = useState<{ key: string; host: number; status: HipsStatus }>(() => HIPS_MEMO.get(key) ?? { key, host: 0, status: 'loading' });
  const setState = useCallback((u: { key: string; host: number; status: HipsStatus } | ((s: { key: string; host: number; status: HipsStatus }) => { key: string; host: number; status: HipsStatus })) => {
    setStateRaw((s) => {
      const next = typeof u === 'function' ? u(s) : u;
      if (next.status !== 'loading') HIPS_MEMO.set(next.key, next);
      return next;
    });
  }, []);
  const cur = state.key === key ? state : HIPS_MEMO.get(key) ?? { key, host: 0, status: 'loading' as HipsStatus };
  const cb = useRef(onStatus);
  useEffect(() => { cb.current = onStatus; }, [onStatus]);
  useEffect(() => { cb.current?.(cur.status); }, [cur.status, key]);
  const n = urls.length;
  const advance = useCallback((host: number) => {
    setState((s) => {
      const c = s.key === key ? s : { key, host: 0, status: 'loading' as HipsStatus };
      if (c.host !== host || c.status !== 'loading') return c; // stale event
      return host + 1 < n ? { key, host: host + 1, status: 'loading' } : { key, host, status: 'failed' };
    });
  }, [key, n, setState]);
  // A host that neither loads nor errors (outage pages that hang) counts as failed after 15 s.
  useEffect(() => {
    if (cur.status !== 'loading') return;
    const id = setTimeout(() => advance(cur.host), 15000);
    return () => clearTimeout(id);
  }, [cur.status, cur.host, advance]);
  if (cur.status === 'failed') return null;
  return (
    <img
      key={`${key}-${cur.host}`}
      src={urls[cur.host]}
      alt={alt}
      className={className}
      style={{ ...style, visibility: cur.status === 'ok' ? 'visible' : 'hidden' }}
      decoding="async"
      referrerPolicy="no-referrer"
      onLoad={() => setState({ key, host: cur.host, status: 'ok' })}
      onError={() => advance(cur.host)}
    />
  );
}

/** Band picker + provenance line for the HiPS layer. */
export function HipsControls({ layer, setLayer, status, wcs }: { layer: HipsLayer; setLayer: (l: HipsLayer) => void; status: HipsStatus; wcs: TanWcs }) {
  const { t } = useLocale();
  const L = t.look;
  return (
    <div className="look-hips-meta">
      <label className="look-field look-field-inline">
        <span className="p-label">{L.hipsLayer}</span>
        <select className="look-select" value={layer} onChange={(e) => setLayer(e.target.value as HipsLayer)}>
          {HIPS_LAYERS.map((l) => (
            <option key={l} value={l}>{l === 'color' ? L.hipsColor : L.hipsBand(l, HIPS_RANGE_UM[l])}</option>
          ))}
        </select>
      </label>
      <p className="look-prov">
        <span className="look-tag look-tag-real">{t.common.realData}</span>{' '}
        {status === 'loading' && <span>{L.hipsLoading} </span>}
        {status === 'failed' ? <span className="look-warn">{L.hipsFailed}</span> : <span>{L.hipsNote}</span>}{' '}
        <span className="p-data">{HIPS_RELEASE} · {L.hipsField(wcsFovDeg(wcs).toFixed(wcsFovDeg(wcs) < 5 ? 1 : 0))} · </span>
        <a href={HIPS_POLICY_URL} target="_blank" rel="noreferrer" className="p-data">{HIPS_CREDIT}</a>
      </p>
    </div>
  );
}

/** Draws a RegionImage into a canvas (one canvas pixel per SPHEREx grid pixel; CSS scales it). */
export function RegionCanvas({ region, className, style }: { region: RegionImage; className?: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = region.n; c.height = region.n;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(region.n, region.n);
    img.data.set(region.rgba);
    ctx.putImageData(img, 0, 0);
  }, [region]);
  return <canvas ref={ref} className={className} style={style} aria-hidden="true" />;
}

type RegionState =
  | { status: 'loading'; key: string; progress: Progress | null }
  | { status: 'ok'; key: string; region: RegionImage }
  | { status: 'error'; key: string; reason: 'no-live' | 'no-coverage' | 'failed' };

/** Loads real SPHEREx frames for (ra, dec): nearby preset snapshot, else live search. */
export function useRegion(ra: number, dec: number, nonce = 0) {
  const key = `${ra.toFixed(4)},${dec.toFixed(4)},${nonce}`;
  const [state, setState] = useState<RegionState>({ status: 'loading', key, progress: null });
  useEffect(() => {
    const ctrl = new AbortController();
    loadRegion(ra, dec, (p) => { if (!ctrl.signal.aborted) setState({ status: 'loading', key, progress: p }); }, ctrl.signal)
      .then((region) => setState({ status: 'ok', key, region }))
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setState({ status: 'error', key, reason: e instanceof RegionUnavailable ? e.reason : 'failed' });
      });
    return () => ctrl.abort();
  }, [ra, dec, key]);
  return state.key === key ? state : ({ status: 'loading', key, progress: null } as RegionState);
}

export function explorerHref(ra: number, dec: number, presetId?: string) {
  return presetId ? `/explore?target=${presetId}` : `/explore?ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}`;
}

/** Real SPHEREx frames at a position, with provenance, actions and the nearest StarChord targets. */
export function RegionPanel({ ra, dec, onRegion, onPickTarget, compact }: {
  ra: number; dec: number; onRegion?: (r: RegionImage | null) => void; onPickTarget?: (id: string) => void; compact?: boolean;
}) {
  const { locale, t } = useLocale();
  const L = t.look;
  const [nonce, setNonce] = useState(0);
  const st = useRegion(ra, dec, nonce);
  const near = useMemo(() => targetsByDistance(ra, dec).slice(0, 3), [ra, dec]);
  const cb = useRef(onRegion);
  useEffect(() => { cb.current = onRegion; }, [onRegion]);
  useEffect(() => { cb.current?.(st.status === 'ok' ? st.region : null); }, [st]);

  const region = st.status === 'ok' ? st.region : null;
  return (
    <section className={`look-region${compact ? ' look-region-compact' : ''}`} aria-live="polite">
      <h3 className="look-h3">{L.cutoutTitle}</h3>
      <p className="look-coords p-data">
        {L.ra} {formatRa(ra, 1)} · {L.dec} {formatDec(dec, 0)}
      </p>
      {st.status === 'loading' && (
        <div className="look-loading">
          <span className="look-spinner" aria-hidden="true" />
          <span>{L.loadingFrames}</span>
          {st.progress && t.explore.stage[st.progress.stage] && <span className="p-data look-dim">{t.explore.stage[st.progress.stage]}{st.progress.stage === 'snapshot' && st.progress.message ? ` · ${st.progress.message}` : typeof st.progress.done === 'number' && typeof st.progress.total === 'number' ? ` · ${st.progress.done}/${st.progress.total}` : ''}</span>}
        </div>
      )}
      {st.status === 'error' && (
        <div className="look-empty">
          <p>{st.reason === 'no-live' ? L.noLive : st.reason === 'no-coverage' ? L.noCoverage : L.failed}</p>
          {st.reason === 'failed' && <button type="button" className="look-btn" onClick={() => setNonce((n) => n + 1)}>{L.retry}</button>}
        </div>
      )}
      {region && (
        <div className="look-region-body">
          <RegionCanvas region={region} className="look-cutout" />
          <div className="look-region-text">
            <p className="look-prov">
              <span className="look-tag look-tag-real">{t.common.realData}</span>{' '}
              {region.origin === 'snapshot'
                ? L.cutoutSnapshot(region.presetName ?? region.presetId ?? '', region.offsetDeg.toFixed(2))
                : L.cutoutLive}
            </p>
            <p className="look-dim">{L.cutoutColour}</p>
            <p className="p-data look-dim">
              {region.dates ? L.cutoutFrames(region.nFrames, region.dates[0], region.dates[1]) : region.nFrames}
              {' · '}{L.cutoutField(region.fovArcmin.toFixed(1))}
              {region.origin === 'snapshot' ? ` · ${region.generated}` : ''}
            </p>
            <p className="look-actions">
              <a className="look-btn look-btn-primary" href={withLang(explorerHref(region.centre.ra, region.centre.dec, region.presetId), locale)}>{L.openExplorer}</a>
              <a className="look-btn" href={withLang(`/sky?ra=${ra.toFixed(4)}&dec=${dec.toFixed(4)}`, locale)}>{L.openSky}</a>
            </p>
          </div>
        </div>
      )}
      {st.status === 'error' && (
        <p className="look-actions">
          <a className="look-btn" href={withLang(explorerHref(ra, dec), locale)}>{L.openExplorer}</a>
        </p>
      )}
      {!compact && (
        <div className="look-near">
          <h4 className="p-label">{L.nearestTargets}</h4>
          <ul className="look-near-list">
            {near.map((n) => (
              <li key={n.id}>
                <span className="look-near-name">{n.name}</span>
                <span className="p-data look-dim">{L.degAway(n.sep < 10 ? n.sep.toFixed(1) : n.sep.toFixed(0))}</span>
                {onPickTarget && <button type="button" className="look-link" onClick={() => onPickTarget(n.id)}>{L.showTarget}</button>}
                <a className="look-link" href={withLang(`/explore?target=${n.id}`, locale)}>{L.explore}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
