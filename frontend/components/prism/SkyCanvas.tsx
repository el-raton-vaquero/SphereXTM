'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDec, formatRa, makeProjector } from '../../lib/prism/coords';
import { flagNames, renderDepth, renderDiverging, renderGray, type Levels, type Stretch } from '../../lib/prism/imaging';
import type { PrismText } from '../../lib/prism/i18n';
import type { Grid } from '../../lib/prism/types';

export type RenderKind = 'gray' | 'diverging' | 'depth';

export interface Ring { x: number; y: number; dx?: number; dy?: number; label?: string; mag?: number | null }
export interface TargetMark { x: number; y: number; trail: { x: number; y: number }[]; label: string }
export interface CentroidMark { x: number; y: number; sx: number; sy: number }

interface Props {
  grid: Grid;
  image: Float32Array | null;
  kind: RenderKind;
  stretch: Stretch;
  levels: Levels;
  divScale: number;
  unit: string;
  flags: Uint32Array | null;
  flagBits: Record<string, number>;
  showFlags: boolean;
  gaia: Ring[];
  skybot: Ring[];
  target: TargetMark | null;
  centroid: CentroidMark | null;
  probe: { x: number; y: number } | null;
  zoom: number;
  caption: string;
  captionColor: string;
  text: PrismText;
  onProbe: (x: number, y: number) => void;
  onProbeReset?: () => void;
}

const WIDE = { top: 26, right: 16, bottom: 30, left: 56 };
const NARROW = { top: 26, right: 12, bottom: 30, left: 44 };
const ARCSEC_STEPS = [5, 10, 15, 20, 30, 60, 120, 300, 600, 1200];
const RA_SEC_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
const ALERT_FLAGS = ['OVERFLOW', 'BLOOM', 'NONFUNC', 'SUR_ERROR'];

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export default function SkyCanvas(props: Props) {
  const { grid, image, kind, stretch, levels, divScale, flags, flagBits, showFlags, zoom } = props;
  const n = grid.n;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(480);
  const [narrow, setNarrow] = useState(false);
  const MARGIN = narrow ? NARROW : WIDE;
  const proj = useMemo(() => makeProjector(grid), [grid]);

  // Camera: visible window in pixel units [x0, y0, w]. Animated toward the target window.
  const [view, setView] = useState({ cx: n / 2, cy: n / 2, w: n });
  const viewRef = useRef(view);
  const anim = useRef<number | null>(null);
  const goal = useRef({ cx: n / 2, cy: n / 2, w: n });

  const animateTo = useCallback((next: { cx: number; cy: number; w: number }) => {
    goal.current = next;
    if (anim.current) cancelAnimationFrame(anim.current);
    if (prefersReducedMotion()) {
      viewRef.current = next;
      setView(next);
      return;
    }
    const from = { ...viewRef.current };
    const t0 = performance.now();
    const dur = 320;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      const v = { cx: from.cx + (next.cx - from.cx) * e, cy: from.cy + (next.cy - from.cy) * e, w: from.w + (next.w - from.w) * e };
      viewRef.current = v;
      setView(v);
      if (k < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  }, []);

  const clampView = useCallback((cx: number, cy: number, w: number) => {
    const h = w / 2;
    return { cx: Math.min(n - h, Math.max(h, cx)), cy: Math.min(n - h, Math.max(h, cy)), w };
  }, [n]);

  // Zoom changes: move camera toward probe (or keep centre).
  useEffect(() => {
    const w = n / zoom;
    const c = props.probe ?? { x: n / 2 - 0.5, y: n / 2 - 0.5 };
    const id = requestAnimationFrame(() => animateTo(clampView(zoom === 1 ? n / 2 : c.x + 0.5, zoom === 1 ? n / 2 : c.y + 0.5, w)));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, n]);

  useEffect(() => () => { if (anim.current) cancelAnimationFrame(anim.current); }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const isNarrow = el.clientWidth < 520;
      const m = isNarrow ? NARROW : WIDE;
      setNarrow(isNarrow);
      setSize(Math.max(200, Math.min(el.clientWidth - m.left - m.right, 720)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Offscreen n×n rasters.
  const raster = useMemo(() => {
    if (typeof document === 'undefined' || !image) return null;
    const c = document.createElement('canvas');
    c.width = n; c.height = n;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const img = ctx.createImageData(n, n);
    if (kind === 'diverging') renderDiverging(image, divScale, img.data, n);
    else if (kind === 'depth') renderDepth(image, divScale, img.data);
    else renderGray(image, levels, stretch, img.data);
    ctx.putImageData(img, 0, 0);
    return c;
  }, [image, kind, levels, stretch, divScale, n]);

  const flagRaster = useMemo(() => {
    if (typeof document === 'undefined' || !flags || !showFlags) return null;
    const c = document.createElement('canvas');
    c.width = n; c.height = n;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const img = ctx.createImageData(n, n);
    const ignore = (1 << (flagBits.SOURCE ?? 21)) | (1 << (flagBits.FULLSAMPLE ?? 12));
    let alertMask = 0;
    for (const f of ALERT_FLAGS) if (flagBits[f] !== undefined) alertMask |= 1 << flagBits[f];
    for (let i = 0; i < n * n; i++) {
      const v = flags[i] & ~ignore;
      if (!v) continue;
      const o = i * 4;
      if (v & alertMask) { img.data[o] = 224; img.data[o + 1] = 100; img.data[o + 2] = 79; img.data[o + 3] = 170; }
      else { img.data[o] = 226; img.data[o + 1] = 181; img.data[o + 2] = 74; img.data[o + 3] = 110; }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }, [flags, showFlags, flagBits, n]);

  const k = size / view.w; // screen px per image px
  const x0 = view.cx - view.w / 2;
  const y0 = view.cy - view.w / 2;
  const toScreen = useCallback((x: number, y: number) => ({ sx: (x + 0.5 - x0) * k, sy: (y + 0.5 - y0) * k }), [x0, y0, k]);

  // Draw main canvas.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(size * dpr);
    cv.height = Math.round(size * dpr);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0b0a09';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const s = cv.width / view.w;
    if (raster) ctx.drawImage(raster, 0, 0, n, n, -x0 * s, -y0 * s, n * s, n * s);
    if (flagRaster) ctx.drawImage(flagRaster, 0, 0, n, n, -x0 * s, -y0 * s, n * s, n * s);
  }, [raster, flagRaster, size, view, x0, y0, n]);

  // Coordinate ticks for the visible window.
  const ticks = useMemo(() => {
    const spanArcsec = view.w * grid.pixscale_arcsec;
    const decStep = ARCSEC_STEPS.find((s) => spanArcsec / s <= 6) ?? 1200;
    const centre = proj.pixToSky(view.cx - 0.5, view.cy - 0.5);
    const cosd = Math.cos((centre.dec * Math.PI) / 180);
    const raStepSec = RA_SEC_STEPS.find((s) => spanArcsec / (s * 15 * cosd) <= 6) ?? 120;
    const out = { dec: [] as { s: number; label: string; major: boolean }[], ra: [] as { s: number; label: string; major: boolean }[] };
    const top = proj.pixToSky(view.cx, y0 - 0.5).dec;
    const bottom = proj.pixToSky(view.cx, y0 + view.w - 0.5).dec;
    const minor = 5;
    const dStep = decStep / 3600 / minor;
    for (let d = Math.ceil(Math.min(top, bottom) / dStep) * dStep; d <= Math.max(top, bottom); d += dStep) {
      const p = proj.skyToPix(centre.ra, d);
      const sy = toScreen(0, p.y).sy;
      const idx = Math.round(d / dStep);
      const major = idx % minor === 0;
      if (sy < 0 || sy > size) continue;
      out.dec.push({ s: sy, major, label: major ? formatDec(d, 0).slice(4) : '' });
    }
    const left = proj.pixToSky(x0 - 0.5, view.cy).ra;
    const right = proj.pixToSky(x0 + view.w - 0.5, view.cy).ra;
    const rStep = (raStepSec * 15) / 3600 / minor;
    let lo = Math.min(left, right), hi = Math.max(left, right);
    if (hi - lo > 180) { const t = lo; lo = hi - 360; hi = t; }
    for (let r = Math.ceil(lo / rStep) * rStep; r <= hi; r += rStep) {
      const ra = ((r % 360) + 360) % 360;
      const p = proj.skyToPix(ra, centre.dec);
      const sx = toScreen(p.x, 0).sx;
      const major = Math.round(r / rStep) % minor === 0;
      if (sx < 0 || sx > size) continue;
      out.ra.push({ s: sx, major, label: major ? formatRa(ra, raStepSec < 1 ? 1 : 0).slice(3) : '' });
    }
    return out;
  }, [view, grid.pixscale_arcsec, proj, toScreen, size, x0, y0]);

  // Hover readout.
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ px: number; py: number; cx: number; cy: number; moved: boolean } | null>(null);

  const eventToPix = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: x0 + ((e.clientX - r.left) / r.width) * view.w - 0.5, y: y0 + ((e.clientY - r.top) / r.height) * view.w - 0.5 };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, cx: view.cx, cy: view.cy, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = eventToPix(e);
    setHover({ x: Math.round(p.x), y: Math.round(p.y) });
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px, dy = e.clientY - d.py;
    if (Math.hypot(dx, dy) > 4) d.moved = true;
    if (d.moved && zoom > 1) {
      const v = clampView(d.cx - dx / k, d.cy - dy / k, view.w);
      viewRef.current = v;
      setView(v);
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) {
      const p = eventToPix(e);
      if (p.x >= -0.5 && p.y >= -0.5 && p.x < n - 0.5 && p.y < n - 0.5) props.onProbe(p.x, p.y);
    }
  };

  const hoverInfo = useMemo(() => {
    if (!hover || hover.x < 0 || hover.y < 0 || hover.x >= n || hover.y >= n) return null;
    const sky = proj.pixToSky(hover.x, hover.y);
    const i = hover.y * n + hover.x;
    const v = image ? image[i] : NaN;
    const names = flags ? flagNames(flags[i], flagBits).filter((f) => f !== 'SOURCE' && f !== 'FULLSAMPLE') : [];
    return { sky, v, names };
  }, [hover, image, flags, flagBits, proj, n]);

  const t = props.text;
  const full = size + MARGIN.left + MARGIN.right;
  const scaleArcsec = [10, 15, 20, 30, 60, 120, 300].find((s) => (s / grid.pixscale_arcsec) * k >= size * 0.14) ?? 300;
  const scalePx = (scaleArcsec / grid.pixscale_arcsec) * k;
  const psfR = Math.max(5, 1.2 * k);

  return (
    <div className="pv" ref={wrapRef}>
      <div className="pv-plate" style={{ width: full, height: size + MARGIN.top + MARGIN.bottom }}>
        <div className="pv-caption" style={{ left: MARGIN.left, width: size }}>
          <span className="pv-swatch" style={{ background: props.captionColor }} aria-hidden />
          <span className="p-data">{props.caption}</span>
        </div>
        <canvas
          ref={canvasRef}
          className="pv-canvas"
          style={{ left: MARGIN.left, top: MARGIN.top, width: size, height: size, cursor: zoom > 1 ? 'grab' : 'crosshair' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHover(null)}
          onKeyDown={(e) => {
            // Keyboard probe: arrows move it one pixel (Shift: 4), Enter re-measures, Esc returns to centre.
            const step = e.shiftKey ? 4 : 1;
            const p = props.probe ?? { x: (n - 1) / 2, y: (n - 1) / 2 };
            const mv: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
            if (mv[e.key]) {
              const x = Math.min(n - 1, Math.max(0, Math.round(p.x) + mv[e.key][0]));
              const y = Math.min(n - 1, Math.max(0, Math.round(p.y) + mv[e.key][1]));
              props.onProbe(x, y);
              setHover({ x, y });
            } else if (e.key === 'Enter') props.onProbe(p.x, p.y);
            else if (e.key === 'Escape') props.onProbeReset?.();
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
          onBlur={() => setHover(null)}
          tabIndex={0}
          data-probe
          role="application"
          aria-roledescription="sky image"
          aria-label={`${props.caption}. ${t.probeHelp}`}
        />
        {!image && (
          <div className="pv-empty p-data" style={{ left: MARGIN.left, top: MARGIN.top, width: size, height: size }}>
            <span>{props.caption}</span>
          </div>
        )}
        <svg className="pv-overlay" width={full} height={size + MARGIN.top + MARGIN.bottom} aria-hidden>
          <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
            <rect x={-0.5} y={-0.5} width={size + 1} height={size + 1} className="pv-frame" />
            {ticks.dec.map((d, i) => (
              <g key={`d${i}`}>
                <line x1={-(d.major ? 9 : 4)} x2={0} y1={d.s} y2={d.s} className="pv-tick" />
                <line x1={size} x2={size + (d.major ? 9 : 4)} y1={d.s} y2={d.s} className="pv-tick" />
                {d.label && <text x={-12} y={d.s + 3.5} textAnchor="end" className="pv-ticklabel">{d.label}</text>}
              </g>
            ))}
            {ticks.ra.map((r, i) => (
              <g key={`r${i}`}>
                <line y1={-(r.major ? 9 : 4)} y2={0} x1={r.s} x2={r.s} className="pv-tick" />
                <line y1={size} y2={size + (r.major ? 9 : 4)} x1={r.s} x2={r.s} className="pv-tick" />
                {r.label && <text y={size + 21} x={r.s} textAnchor="middle" className="pv-ticklabel">{r.label}</text>}
              </g>
            ))}
            {ticks.dec.filter((d) => d.major).flatMap((d) => ticks.ra.filter((r) => r.major).map((r) => (
              <path key={`x${d.s}-${r.s}`} d={`M${r.s - 3},${d.s}h6M${r.s},${d.s - 3}v6`} className="pv-reticle" />
            )))}
            <g>
              {props.target && props.target.trail.length > 1 && (
                <polyline
                  points={props.target.trail.map((p) => { const s = toScreen(p.x, p.y); return `${s.sx},${s.sy}`; }).join(' ')}
                  className="pv-trail"
                />
              )}
              {props.gaia.map((g, i) => {
                const s = toScreen(g.x, g.y);
                if (s.sx < -10 || s.sy < -10 || s.sx > size + 10 || s.sy > size + 10) return null;
                const r = Math.max(3.5, psfR * (g.mag != null ? Math.max(0.55, Math.min(1.4, (21 - g.mag) / 10)) : 0.8));
                return (
                  <g key={`g${i}`}>
                    <circle cx={s.sx} cy={s.sy} r={r} className="pv-ghost" />
                    {g.dx !== undefined && g.dy !== undefined && (Math.hypot(g.dx, g.dy) * k > 2) && (
                      <line x1={s.sx} y1={s.sy} x2={s.sx + g.dx * k} y2={s.sy + g.dy * k} className="pv-vector" />
                    )}
                  </g>
                );
              })}
              {props.skybot.map((a, i) => {
                const s = toScreen(a.x, a.y);
                return (
                  <g key={`a${i}`}>
                    <path d={`M${s.sx},${s.sy - 7}l7,7l-7,7l-7,-7z`} className="pv-skybot" />
                    <text x={s.sx + 9} y={s.sy - 7} className="pv-label">{a.label}</text>
                  </g>
                );
              })}
              {props.target && (() => {
                const s = toScreen(props.target.x, props.target.y);
                return (
                  <g>
                    <circle cx={s.sx} cy={s.sy} r={psfR + 4} className="pv-target" />
                    {(() => {
                      // Flip the label left of the reticle when it would run past the plate (phones).
                      const label = narrow ? props.target.label.replace(/\s*\(.*\)\s*$/, '') : props.target.label;
                      const estW = label.length * 6.4;
                      const flip = s.sx + psfR + 8 + estW > size;
                      return <text x={flip ? s.sx - psfR - 8 : s.sx + psfR + 8} y={s.sy - psfR - 4} textAnchor={flip ? 'end' : 'start'} className="pv-label pv-label-signal">{label}</text>;
                    })()}
                  </g>
                );
              })()}
              {props.centroid && (() => {
                const s = toScreen(props.centroid.x, props.centroid.y);
                return (
                  <g>
                    <ellipse cx={s.sx} cy={s.sy} rx={Math.max(1.5, props.centroid.sx * k)} ry={Math.max(1.5, props.centroid.sy * k)} className="pv-ellipse" />
                    <ellipse cx={s.sx} cy={s.sy} rx={Math.max(3, 2 * props.centroid.sx * k)} ry={Math.max(3, 2 * props.centroid.sy * k)} className="pv-ellipse pv-ellipse-2" />
                    <path d={`M${s.sx - 3},${s.sy}h6M${s.sx},${s.sy - 3}v6`} className="pv-centroid-x" />
                  </g>
                );
              })()}
              {props.probe && (() => {
                const s = toScreen(props.probe.x, props.probe.y);
                const r = Math.max(6, 1.46 * k);
                return <path d={`M${s.sx - r - 6},${s.sy}h6M${s.sx + r},${s.sy}h6M${s.sx},${s.sy - r - 6}v6M${s.sx},${s.sy + r}v6`} className="pv-probe" />;
              })()}
            </g>
            <g transform={`translate(12,${size - 14})`} className="pv-scale">
              <line x1={0} x2={scalePx} y1={0} y2={0} />
              <line x1={0} x2={0} y1={-4} y2={4} />
              <line x1={scalePx} x2={scalePx} y1={-4} y2={4} />
              <text x={scalePx / 2} y={-7} textAnchor="middle">{scaleArcsec >= 60 ? `${scaleArcsec / 60}′` : `${scaleArcsec}″`}</text>
            </g>
            <g transform={`translate(${size - 18},${size - 18})`} className="pv-compass">
              <line x1={0} y1={0} x2={0} y2={-26} />
              <line x1={0} y1={0} x2={-26} y2={0} />
              <text x={0} y={-30} textAnchor="middle">N</text>
              <text x={-31} y={3.5} textAnchor="end">E</text>
            </g>
          </g>
        </svg>
      </div>
      <div className="pv-readout p-data" aria-live="off">
        {hoverInfo ? (
          <>
            <span><em>RA</em> {formatRa(hoverInfo.sky.ra)}</span>
            <span><em>Dec</em> {formatDec(hoverInfo.sky.dec)}</span>
            <span><em>{t.pixel}</em> {Number.isFinite(hoverInfo.v) ? `${hoverInfo.v.toPrecision(4)} ${props.unit}` : '—'}</span>
            <span><em>{t.flagsAt}</em> {hoverInfo.names.length ? hoverInfo.names.join(' ') : t.none}</span>
          </>
        ) : (
          <span className="pv-readout-idle">{t.cursor} — {t.spectrumHelp}</span>
        )}
      </div>
    </div>
  );
}
