'use client';

import { useEffect, useState } from 'react';
import { formatDec, formatRA } from './astro';

/**
 * Lock reticle drawn at the centre of the 3D stage. The tick ruler is a true
 * angular scale for the current vertical field of view (arcminutes).
 */
export default function Reticle({ fov, ra, dec, reduced }: { fov: number; ra: number; dec: number; reduced: boolean }) {
  const [h, setH] = useState(800);
  const [w, setW] = useState(1200);
  useEffect(() => {
    const on = () => {
      setH(window.innerHeight);
      setW(window.innerWidth);
    };
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  const size = w <= 900 ? 180 : 232;
  const half = size / 2;
  const pxPerArcmin = h / (fov * 60);
  // Choose a tick step that keeps ticks ≥ 7 px apart.
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  const step = steps.find((s) => s * pxPerArcmin >= 7) ?? 120;
  const major = step * 5;
  const ticks: { x: number; major: boolean; v: number }[] = [];
  const maxArcmin = (half - 6) / pxPerArcmin;
  for (let v = -Math.floor(maxArcmin / step) * step; v <= maxArcmin + 1e-9; v += step) {
    ticks.push({ x: v * pxPerArcmin, major: Math.abs(v % major) < 1e-6, v });
  }
  const br = 18; // bracket arm
  const g = 34; // inner gap of crosshair
  const fmt = (v: number) => (major >= 60 ? `${v / 60}°` : `${v}′`);

  return (
    <div className={`cz-reticle${reduced ? ' is-static' : ''}`} aria-hidden="true">
      <svg width={size} height={size} viewBox={`${-half} ${-half} ${size} ${size}`}>
        <g className="rt-brackets">
          {[
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
          ].map(([sx, sy]) => (
            <path
              key={`${sx}${sy}`}
              d={`M ${sx * (half - 2)} ${sy * (half - 2 - br)} L ${sx * (half - 2)} ${sy * (half - 2)} L ${sx * (half - 2 - br)} ${sy * (half - 2)}`}
            />
          ))}
        </g>
        <g className="rt-cross">
          <line x1={-half + 14} y1={0} x2={-g / 2} y2={0} />
          <line x1={g / 2} y1={0} x2={half - 14} y2={0} />
          <line x1={0} y1={-half + 14} x2={0} y2={-g / 2} />
          <line x1={0} y1={g / 2} x2={0} y2={half - 14} />
        </g>
        <g className="rt-ticks">
          {ticks.map((tk) => (
            <line key={`h${tk.v}`} x1={tk.x} x2={tk.x} y1={half - 2} y2={half - 2 - (tk.major ? 8 : 4)} />
          ))}
          {ticks.map((tk) => (
            <line key={`v${tk.v}`} y1={-tk.x} y2={-tk.x} x1={-half + 2} x2={-half + 2 + (tk.major ? 8 : 4)} />
          ))}
        </g>
        <g className="rt-text">
          {ticks
            .filter((tk) => tk.major && tk.v !== 0)
            .map((tk) => (
              <text key={`t${tk.v}`} x={tk.x} y={half - 14} textAnchor="middle">
                {fmt(tk.v)}
              </text>
            ))}
          <text x={0} y={-half - 8} textAnchor="middle">N</text>
          <text x={-half - 10} y={4} textAnchor="middle">E</text>
        </g>
      </svg>
      <div className="rt-coord p-data">
        <span>α {formatRA(ra, 2)}</span>
        <span>δ {formatDec(dec, 1)}</span>
      </div>
    </div>
  );
}
