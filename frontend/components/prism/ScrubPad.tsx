'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatMjdDate } from '../../lib/prism/coords';
import { DETECTOR_RANGES, LAMBDA_MAX, LAMBDA_MIN, detectorColor, lambdaColor } from '../../lib/prism/ramp';
import type { PrismText } from '../../lib/prism/i18n';
import type { Frame, Season } from '../../lib/prism/types';

interface Props {
  frames: Frame[];
  seasons: Season[];
  current: Frame;
  matched: Set<number>;
  raw: boolean;
  refSeason: number | null;
  text: PrismText;
  onSelect: (index: number) => void;
}

const M = { top: 12, right: 34, bottom: 30, left: 46 };
const GAP = 44;
const H = 214;

export default function ScrubPad({ frames, seasons, current, matched, raw, refSeason, text, onSelect }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(300, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    const inner = W - M.left - M.right - GAP * Math.max(0, seasons.length - 1);
    const spans = seasons.map((s) => Math.max(12, s.end_mjd - s.start_mjd));
    const total = spans.reduce((a, b) => a + b, 0) || 1;
    const segs: { index: number; x: number; w: number; s: Season }[] = [];
    let cursor = M.left;
    for (let i = 0; i < seasons.length; i++) {
      const w = Math.max(84, (spans[i] / total) * inner);
      segs.push({ index: seasons[i].index, x: cursor, w, s: seasons[i] });
      cursor += w + GAP;
    }
    const scale = (W - M.right - M.left) / Math.max(1, cursor - GAP - M.left);
    segs.forEach((g) => { g.x = M.left + (g.x - M.left) * scale; g.w *= scale; });
    return segs;
  }, [W, seasons]);

  const plotH = H - M.top - M.bottom;
  const yOf = (um: number) => M.top + (1 - (um - LAMBDA_MIN) / (LAMBDA_MAX - LAMBDA_MIN)) * plotH;
  const xOf = (f: Frame) => {
    const seg = layout.find((g) => g.index === f.season) ?? layout[0];
    if (!seg) return M.left;
    const span = Math.max(12, seg.s.end_mjd - seg.s.start_mjd);
    const pad = (span - (seg.s.end_mjd - seg.s.start_mjd)) / 2;
    return seg.x + ((f.mjd - seg.s.start_mjd + pad) / span) * seg.w;
  };
  const pts = frames.map((f) => ({ f, x: xOf(f), y: yOf(f.lambda_um) }));

  const drag = useRef<{ x: number; y: number; axis: 'time' | 'lambda' | null } | null>(null);

  const local = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const nearest = (cands: typeof pts, x: number, y: number, wx: number, wy: number) => {
    let best = cands[0], bd = Infinity;
    for (const p of cands) {
      const d = wx * (p.x - x) ** 2 + wy * (p.y - y) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };

  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = local(e);
    drag.current = { ...p, axis: null };
    const hit = nearest(pts, p.x, p.y, 1, 1);
    if (hit) onSelect(hit.f.index);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = local(e);
    if (!d.axis) {
      const dx = Math.abs(p.x - d.x), dy = Math.abs(p.y - d.y);
      if (Math.max(dx, dy) < 6) return;
      d.axis = raw ? 'time' : dx >= dy ? 'time' : 'lambda';
    }
    let cands = pts;
    if (d.axis === 'time' && !raw) cands = pts.filter((q) => matched.has(q.f.index));
    if (d.axis === 'lambda') cands = pts.filter((q) => q.f.season === current.season);
    if (!cands.length) return;
    const hit = d.axis === 'time' ? nearest(cands, p.x, p.y, 1, 0) : nearest(cands, p.x, p.y, 0, 1);
    if (hit && hit.f.index !== current.index) onSelect(hit.f.index);
  };
  const onUp = () => { drag.current = null; };

  const cur = pts.find((p) => p.f.index === current.index);
  const half = current.bandwidth_um / 2;
  const rawPath = raw ? pts.map((p) => `${p.x},${p.y}`).join(' ') : '';

  return (
    <div className="pad" ref={ref}>
      <svg
        width={W}
        height={H}
        className="pad-svg"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        role="presentation"
      >
        {DETECTOR_RANGES.map(([a, b], i) => (
          <g key={i}>
            <rect x={M.left} width={W - M.left - M.right} y={yOf(b)} height={yOf(a) - yOf(b)} className={i % 2 ? 'pad-band pad-band-odd' : 'pad-band'} />
            <rect x={W - M.right + 6} width={3} y={yOf(b)} height={yOf(a) - yOf(b)} fill={detectorColor(i + 1)} />
            <text x={W - M.right + 13} y={(yOf(a) + yOf(b)) / 2 + 3.5} className="pad-det">D{i + 1}</text>
          </g>
        ))}
        {[1, 2, 3, 4, 5].map((um) => (
          <g key={um}>
            <line x1={M.left - 5} x2={M.left} y1={yOf(um)} y2={yOf(um)} className="pad-tick" />
            <text x={M.left - 8} y={yOf(um) + 3.5} textAnchor="end" className="pad-label">{um} µm</text>
          </g>
        ))}
        {layout.map((g, i) => (
          <g key={g.index}>
            {refSeason === g.index && <rect x={g.x - 4} width={g.w + 8} y={M.top} height={plotH} className="pad-ref" />}
            <line x1={g.x} x2={g.x + g.w} y1={H - M.bottom + 1} y2={H - M.bottom + 1} className="pad-axis" />
            <line x1={g.x} x2={g.x} y1={H - M.bottom + 1} y2={H - M.bottom + 5} className="pad-tick" />
            <line x1={g.x + g.w} x2={g.x + g.w} y1={H - M.bottom + 1} y2={H - M.bottom + 5} className="pad-tick" />
            <text x={g.x} y={H - M.bottom + 15} className="pad-label">{`S${g.index} · ${formatMjdDate(g.s.start_mjd).slice(0, 7)}`}</text>
            {i > 0 && (
              <text x={g.x - GAP / 2} y={H - 3} textAnchor="middle" className="pad-gap">
                {`+${Math.round(g.s.start_mjd - layout[i - 1].s.end_mjd)} d`}
              </text>
            )}
            {i > 0 && <path d={`M${g.x - GAP / 2 - 4},${H - M.bottom - 3}l3,8M${g.x - GAP / 2 + 1},${H - M.bottom - 3}l3,8`} className="pad-break" />}
          </g>
        ))}
        {cur && !raw && (
          <rect x={M.left} width={W - M.left - M.right} y={yOf(current.lambda_um + half)} height={Math.max(1, yOf(current.lambda_um - half) - yOf(current.lambda_um + half))} className="pad-matchband" />
        )}
        {cur && (
          <g className="pad-cross">
            <line x1={cur.x} x2={cur.x} y1={M.top} y2={H - M.bottom} />
            <line x1={M.left} x2={W - M.right} y1={cur.y} y2={cur.y} />
          </g>
        )}
        {raw && <polyline points={rawPath} className="pad-rawpath" />}
        {pts.map(({ f, x, y }) => {
          const isCur = f.index === current.index;
          const isMatch = matched.has(f.index);
          const c = lambdaColor(f.lambda_um);
          const dim = !raw && !isMatch && !isCur;
          return f.saturated_at_center ? (
            <circle key={f.index} cx={x} cy={y} r={isCur ? 5 : 3.6} fill="none" stroke={c} strokeWidth={1.3} opacity={dim ? 0.45 : 1} />
          ) : (
            <circle key={f.index} cx={x} cy={y} r={isCur ? 5 : 3.6} fill={c} opacity={dim ? 0.38 : 1} />
          );
        })}
        {cur && <circle cx={cur.x} cy={cur.y} r={8.5} className="pad-current" />}
      </svg>
      <div className="pad-legend p-data">
        <span><i className="pad-dot" /> {frames.length} {text.frames}</span>
        <span><i className="pad-dot pad-dot-hollow" /> {text.saturatedPoint}</span>
        {!raw && <span><i className="pad-swatch-band" /> ±½ {text.band} · {matched.size} {text.matched}</span>}
      </div>
    </div>
  );
}
