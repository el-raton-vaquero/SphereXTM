'use client';

import { useEffect, useRef } from 'react';
import { FRAME_UM } from '../../lib/look/hipsRender';
import { lambdaColor } from '../../lib/prism/ramp';
import { N_BANDS } from '../../lib/match/bands';

const COLORS = Array.from({ length: N_BANDS }, (_, i) => lambdaColor(FRAME_UM[i] ?? 5));

/**
 * 102 bars, band 0 (highest pitch, shortest wavelength) on the left. `getLevels` is polled every
 * animation frame and returns 0..1 per band (or null for an idle baseline).
 */
export default function Visualiser({ getLevels, label, reduced }: { getLevels: () => ArrayLike<number> | null; label: string; reduced: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const getRef = useRef(getLevels);
  useEffect(() => { getRef.current = getLevels; }, [getLevels]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const shown = new Float32Array(N_BANDS);
    let raf = 0;
    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const lv = getRef.current();
      for (let i = 0; i < N_BANDS; i++) {
        const target = lv ? Math.max(0, Math.min(1, Number(lv[i]) || 0)) : 0;
        shown[i] = reduced ? target : shown[i] + (target - shown[i]) * (target > shown[i] ? 0.55 : 0.18);
      }
      ctx.clearRect(0, 0, w, h);
      const gap = Math.max(1, Math.round(dpr)), bw = (w - gap * (N_BANDS - 1)) / N_BANDS;
      const base = h - 1;
      ctx.fillStyle = 'rgba(236,232,225,0.14)';
      ctx.fillRect(0, base, w, 1);
      for (let i = 0; i < N_BANDS; i++) {
        const bh = Math.max(dpr, shown[i] * (h - 2));
        ctx.fillStyle = COLORS[i];
        ctx.globalAlpha = lv ? 0.92 : 0.35;
        ctx.fillRect(i * (bw + gap), base - bh, bw, bh);
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  return <canvas ref={ref} className="mt-vis" role="img" aria-label={label} />;
}
