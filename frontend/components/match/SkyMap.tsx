'use client';

import type { CoarseHit, FineHit } from '../../lib/match/client';

/**
 * Small all-sky map (equirectangular, RA increasing to the left as on the sky): the 50 coarse
 * candidates, the region being searched now, and the best matches so far.
 */
export default function SkyMap({ hits, current, best, label }: {
  hits: CoarseHit[]; current?: { ra: number; dec: number } | null; best: FineHit[]; label: string;
}) {
  const x = (ra: number) => 360 - (((ra % 360) + 360) % 360);
  const y = (dec: number) => 90 - dec;
  return (
    <svg className="mt-map" viewBox="-4 -4 368 188" role="img" aria-label={label}>
      <rect x="0" y="0" width="360" height="180" fill="none" stroke="var(--p-rule-2)" vectorEffect="non-scaling-stroke" />
      {[60, 120, 180, 240, 300].map((v) => <line key={v} x1={v} x2={v} y1="0" y2="180" stroke="var(--p-rule)" vectorEffect="non-scaling-stroke" />)}
      {[30, 60, 90, 120, 150].map((v) => <line key={v} y1={v} y2={v} x1="0" x2="360" stroke="var(--p-rule)" strokeDasharray={v === 90 ? undefined : '2 3'} vectorEffect="non-scaling-stroke" />)}
      {hits.map((h) => <circle key={h.pix} cx={x(h.ra)} cy={y(h.dec)} r="1.8" fill="var(--p-ink-3)" />)}
      {current && (
        <g className="mt-map-cur">
          <circle cx={x(current.ra)} cy={y(current.dec)} r="6" fill="none" stroke="var(--p-ink)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </g>
      )}
      {best.slice(0, 3).map((b, i) => (
        <g key={`${b.npix}-${b.col}-${b.row}`}>
          <circle cx={x(b.ra)} cy={y(b.dec)} r={i === 0 ? 4 : 3} fill={i === 0 ? 'var(--p-signal)' : 'none'} stroke="var(--p-signal)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        </g>
      ))}
    </svg>
  );
}
