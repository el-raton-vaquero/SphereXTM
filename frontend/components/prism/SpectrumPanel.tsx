'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDec, formatRa } from '../../lib/prism/coords';
import { LAMBDA_MAX, LAMBDA_MIN, lambdaColor } from '../../lib/prism/ramp';
import type { PrismText } from '../../lib/prism/i18n';
import type { SpectrumResponse } from '../../lib/prism/types';

export type SpectrumSource = 'live' | 'snapshot' | 'client';

interface Props {
  data: SpectrumResponse | null;
  source: SpectrumSource;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  probe: { ra: number; dec: number };
  currentFrameId?: string;
  text: PrismText;
}

const MARKERS = ['circle', 'square', 'triangle', 'diamond'] as const;
const H = 210;
const M = { top: 14, right: 12, bottom: 30, left: 46 };

function marker(kind: (typeof MARKERS)[number], x: number, y: number, r: number) {
  switch (kind) {
    case 'square': return `M${x - r},${y - r}h${2 * r}v${2 * r}h${-2 * r}z`;
    case 'triangle': return `M${x},${y - r * 1.2}l${r * 1.1},${r * 2}h${-r * 2.2}z`;
    case 'diamond': return `M${x},${y - r * 1.3}l${r * 1.3},${r * 1.3}l${-r * 1.3},${r * 1.3}l${-r * 1.3},${-r * 1.3}z`;
    default: return `M${x - r},${y}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`;
  }
}

function fmtTick(v: number) {
  if (Math.abs(v) < 1e-9) return '0';
  const a = Math.abs(v);
  if (a >= 1e4 || a < 1e-3) return v.toExponential(0).replace('e+', 'e');
  return String(+v.toPrecision(3));
}

function niceTicks(lo: number, hi: number, n = 4) {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n + 1) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(+v.toPrecision(10));
  return out;
}

export default function SpectrumPanel({ data, source, status, error, probe, currentFrameId, text }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(380);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [showRaw, setShowRaw] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(260, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Only measured points: the backend also lists frames where no flux could be measured
  // (off_frame / incomplete / no_background), with flux = null and a status.
  const pts = useMemo(() => (data?.points ?? []).filter((p) => p.flux != null && p.err != null && Number.isFinite(p.flux) && Number.isFinite(p.lambda_um)), [data]);
  const seasons = useMemo(() => [...new Set(pts.map((p) => p.season))].sort((a, b) => a - b), [pts]);
  const unit = pts[0]?.unit ?? 'mJy';
  // Points that carry usable flux: measured, unsaturated, no artifact flags.
  const nUsable = pts.filter((p) => !p.saturated && !(p.artifact_flags && p.artifact_flags.length)).length;
  const noFlux = pts.length > 0 && nUsable < 6;
  const visible = useMemo(() => (noFlux && !showRaw ? [] : pts.filter((p) => !hidden.has(p.season))), [noFlux, showRaw, pts, hidden]);
  const uncorrected = (p: { aperture_correction_method?: string }) => (p.aperture_correction_method ?? '').startsWith('none');
  const anyUncorrected = visible.some(uncorrected) && visible.some((p) => !uncorrected(p));
  const yr = useMemo(() => {
    const ok = visible.filter((p) => !p.saturated && Number.isFinite(p.flux));
    const use = (ok.length >= 3 ? ok : visible).map((p) => p.flux).sort((a, b) => a - b);
    if (!use.length) return [0, 1];
    // Robust range (5th–95th percentile, widened) so one outlier cannot flatten the spectrum;
    // points outside are drawn clipped at the edge as open arrows.
    const q = (f: number) => use[Math.min(use.length - 1, Math.max(0, Math.round(f * (use.length - 1))))];
    const p05 = q(0.05), p95 = q(0.95);
    const spread = Math.max(p95 - p05, Math.abs(p95) * 0.1, 1e-6);
    let lo = Math.max(use[0], p05 - 0.6 * spread);
    let hi = Math.min(use[use.length - 1], p95 + 0.6 * spread);
    const curve = data?.classification?.best?.curve;
    if (curve?.length) { lo = Math.min(lo, ...curve.map((c) => c.flux)); hi = Math.max(hi, ...curve.map((c) => c.flux)); }
    lo = Math.min(lo, 0);
    const pad = (hi - lo) * 0.1 || 1;
    return [lo - pad, hi + pad];
  }, [visible, data]);

  const x = (um: number) => M.left + ((um - LAMBDA_MIN) / (LAMBDA_MAX - LAMBDA_MIN)) * (W - M.left - M.right);
  const y = (f: number) => M.top + (1 - (f - yr[0]) / (yr[1] - yr[0])) * (H - M.top - M.bottom);
  const clampY = (v: number) => Math.min(H - M.bottom, Math.max(M.top, v));

  const srcLabel = source === 'live' ? text.specLive : source === 'snapshot' ? text.specSnapshot : text.specClient;
  const cls = data?.classification?.best ? data.classification : null;
  const best = cls?.best ?? null;
  const notDetected = data?.classification?.detected === false;
  const clsCaveats = !cls && data?.classification?.caveats?.length ? data.classification.caveats.join(' ') : '';

  return (
    <section className="panel" aria-labelledby="spec-h">
      <header className="panel-h">
        <h2 id="spec-h" className="p-display">{text.spectrum}</h2>
        <span className="p-data panel-sub">{text.spectrumAt} {formatRa(probe.ra, 1)} {formatDec(probe.dec, 0)}</span>
      </header>
      <div ref={ref} className="spec-plot">
        {status === 'loading' && <div className="spec-state p-data spec-loading">{text.specLoading}</div>}
        {noFlux && !showRaw && <div className="spec-state p-data">{text.noUsableFlux(pts.length - nUsable, pts.length)}</div>}
        {status === 'error' && <div className="spec-state p-data spec-error">{error}</div>}
        {status === 'ready' && !pts.length && <div className="spec-state p-data">{data?.caveats?.[0] ?? '—'} · 0 pts</div>}
        <svg width={W} height={H} role="img" aria-label={`${text.spectrum}: ${pts.length} points`}>
          {niceTicks(yr[0], yr[1]).map((v) => (
            <g key={v}>
              <line x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} className={v === 0 ? 'spec-zero' : 'spec-grid'} />
              <text x={M.left - 6} y={y(v) + 3.5} textAnchor="end" className="spec-label">{fmtTick(v)}</text>
            </g>
          ))}
          {[1, 2, 3, 4, 5].map((um) => (
            <g key={um}>
              <line x1={x(um)} x2={x(um)} y1={H - M.bottom} y2={H - M.bottom + 4} className="spec-tick" />
              <text x={x(um)} y={H - M.bottom + 15} textAnchor="middle" className="spec-label">{um}</text>
            </g>
          ))}
          <text x={W - M.right} y={H - 3} textAnchor="end" className="spec-label">λ [µm]</text>
          <text x={W - M.right} y={M.top - 4} textAnchor="end" className="spec-label">F [{unit}]</text>
          <line x1={M.left} x2={W - M.right} y1={H - M.bottom} y2={H - M.bottom} className="spec-axis" />
          {best?.curve && best.curve.length > 1 && (
            <polyline points={best.curve.map((c) => `${x(c.lambda_um)},${clampY(y(c.flux))}`).join(' ')} className="spec-model" />
          )}
          {visible.map((p, i) => {
            const cx = x(p.lambda_um), cy = clampY(y(p.flux));
            const c = lambdaColor(p.lambda_um);
            const kind = MARKERS[Math.max(0, seasons.indexOf(p.season)) % MARKERS.length];
            const isCur = p.frame_id === currentFrameId;
            return (
              <g key={i}>
                {p.err > 0 && <line x1={cx} x2={cx} y1={clampY(y(p.flux - p.err))} y2={clampY(y(p.flux + p.err))} stroke={c} strokeWidth={1} opacity={0.7} />}
                {cy !== y(p.flux) ? (
                  <path d={cy <= M.top ? `M${cx},${cy}l-3.5,6h7z` : `M${cx},${cy}l-3.5,-6h7z`} fill="none" stroke={c} strokeWidth={1} />
                ) : (
                  <path d={marker(kind, cx, cy, isCur ? 4.6 : 3.2)} fill={p.saturated ? 'none' : c} fillOpacity={anyUncorrected && uncorrected(p) ? 0.35 : 1} stroke={c} strokeWidth={p.saturated || (anyUncorrected && uncorrected(p)) ? 1.1 : 0} />
                )}
                {isCur && <circle cx={cx} cy={cy} r={8} className="spec-current" />}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="spec-legend p-data">
        {seasons.map((s, i) => (
          <button
            key={s}
            type="button"
            className="chip"
            aria-pressed={!hidden.has(s)}
            onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(s)) n.delete(s); else n.add(s); return n; })}
          >
            <svg width={10} height={10} aria-hidden><path d={marker(MARKERS[i % MARKERS.length], 5, 5, 3.2)} fill="currentColor" /></svg>
            S{s} · {pts.filter((p) => p.season === s).length}
          </button>
        ))}
        <span className="spec-hollow"><svg width={10} height={10} aria-hidden><circle cx={5} cy={5} r={3.4} fill="none" stroke="currentColor" /></svg> {text.saturatedPoint}</span>
        {anyUncorrected && <span className="spec-hollow"><svg width={10} height={10} aria-hidden><circle cx={5} cy={5} r={3.4} fill="currentColor" fillOpacity={0.35} stroke="currentColor" /></svg> {text.uncorrectedPoint}</span>}
        {noFlux && <button type="button" className="chip" aria-pressed={showRaw} onClick={() => setShowRaw((v) => !v)}>{showRaw ? text.hideSatPoints : text.showSatPoints}</button>}
      </div>
      <p className="panel-note">{srcLabel}{data?.method ? ` — ${data.method}` : ''}</p>
      {cls && best ? (
        <div className="spec-class">
          <div className="p-data spec-best">
            <span className="p-label">{text.bestFit}</span>{' '}
            {best.class.replace(/_/g, ' ')} · {best.label ?? best.template}
            {best.teff ? ` · Teff ${Math.round(best.teff)} K` : ''} · χ²ᵣ {best.chi2_red.toFixed(2)}
          </div>
          <ul className="rank">
            {cls.ranking.slice(0, 5).map((r) => (
              <li key={r.class + r.template}>
                <span className="p-data rank-name" title={r.template}>{r.spectral_type ? `${r.spectral_type} · ` : ''}{r.label ?? r.template}</span>
                <span className="rank-bar"><i style={{ width: `${Math.round(r.prob * 100)}%` }} /></span>
                <span className="p-data rank-p">{(r.prob * 100).toFixed(0)}%</span>
              </li>
            ))}
          </ul>
          <p className="panel-note">{cls.method}. {cls.caveats.join(' ')}</p>
        </div>
      ) : (
        <p className="panel-note">{notDetected ? <strong className="spec-nodet">{text.noDetection}</strong> : text.noClassification}{clsCaveats ? ` ${clsCaveats}` : ''}</p>
      )}
      {data?.caveats && data.caveats.length > 0 && (
        <ul className="caveats">{data.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
      )}
    </section>
  );
}
