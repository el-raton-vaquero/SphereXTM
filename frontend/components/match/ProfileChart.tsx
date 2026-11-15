'use client';

import { FRAME_UM } from '../../lib/look/hipsRender';
import { lambdaColor } from '../../lib/prism/ramp';
import { BAND_HZ, N_BANDS } from '../../lib/match/bands';

/** Standardise the finite values (mean 0, sd 1). */
function standardise(v: number[]): number[] {
  const f = v.filter(Number.isFinite);
  if (!f.length) return v.map(() => NaN);
  const m = f.reduce((a, b) => a + b, 0) / f.length;
  const sd = Math.sqrt(f.reduce((a, b) => a + (b - m) ** 2, 0) / f.length) || 1;
  return v.map((x) => (Number.isFinite(x) ? (x - m) / sd : NaN));
}

const W = 408, H = 176, TOP = 22, BOT = 22, MID = TOP + (H - TOP - BOT) / 2, AMP = (H - TOP - BOT) / 2 / 3;
const UM_TICKS = [0.75, 1, 2, 3, 4, 5];
const HZ_TICKS = [7000, 2000, 500, 100];
const xOfBand = (i: number) => (i + 0.5) * (W / N_BANDS);
function xOfUm(um: number) {
  let i = 0;
  while (i < N_BANDS - 1 && FRAME_UM[i + 1] < um) i++;
  const a = FRAME_UM[i], b = FRAME_UM[Math.min(N_BANDS - 1, i + 1)];
  return xOfBand(i + (b > a ? Math.max(0, Math.min(1, (um - a) / (b - a))) : 0));
}
function xOfHz(hz: number) {
  const i = (Math.log(BAND_HZ[0] / hz) / Math.log(BAND_HZ[0] / BAND_HZ[N_BANDS - 1])) * (N_BANDS - 1);
  return xOfBand(i);
}
const hzLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : String(hz));

/** The song's 102-band profile (bars, wavelength-ramp colours) against a sky point's spectrum (line). */
export default function ProfileChart({ song, sky, valid, title, songLabel, skyLabel, hzAxis, umAxis }: {
  song: number[]; sky: number[]; valid: boolean[]; title: string; songLabel: string; skyLabel: string; hzAxis: string; umAxis: string;
}) {
  const s = standardise(song.map((v, i) => (valid[i] === false ? NaN : v)));
  const k = standardise(sky.map((v, i) => (valid[i] === false ? NaN : v)));
  const y = (v: number) => MID - Math.max(-3, Math.min(3, v)) * AMP;
  const bw = W / N_BANDS - 0.8;
  let path = '';
  let pen = false;
  k.forEach((v, i) => {
    if (!Number.isFinite(v)) { pen = false; return; }
    path += `${pen ? 'L' : 'M'}${xOfBand(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  return (
    <figure className="mt-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        <line x1="0" x2={W} y1={MID} y2={MID} stroke="var(--p-rule-2)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {s.map((v, i) => Number.isFinite(v) && (
          <rect key={i} x={xOfBand(i) - bw / 2} width={bw} y={Math.min(MID, y(v))} height={Math.max(0.6, Math.abs(y(v) - MID))} fill={lambdaColor(FRAME_UM[i])} opacity="0.8" />
        ))}
        <path d={path} fill="none" stroke="var(--p-ink)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {HZ_TICKS.map((hz) => (
          <g key={hz}>
            <line x1={xOfHz(hz)} x2={xOfHz(hz)} y1={TOP - 5} y2={TOP - 1} stroke="var(--p-tick)" vectorEffect="non-scaling-stroke" />
            <text x={xOfHz(hz)} y={TOP - 8} className="mt-chart-t" textAnchor="middle">{hzLabel(hz)}</text>
          </g>
        ))}
        {UM_TICKS.map((um) => (
          <g key={um}>
            <line x1={xOfUm(um)} x2={xOfUm(um)} y1={H - BOT + 1} y2={H - BOT + 5} stroke="var(--p-tick)" vectorEffect="non-scaling-stroke" />
            <text x={xOfUm(um)} y={H - 6} className="mt-chart-t" textAnchor="middle">{um}</text>
          </g>
        ))}
      </svg>
      <figcaption className="mt-chart-cap">
        <span className="mt-chart-axis p-data">{hzAxis}</span>
        <span className="mt-legend"><span className="mt-key mt-key-bars" aria-hidden="true" />{songLabel}</span>
        <span className="mt-legend"><span className="mt-key mt-key-line" aria-hidden="true" />{skyLabel}</span>
        <span className="mt-chart-axis p-data">{umAxis}</span>
      </figcaption>
    </figure>
  );
}
