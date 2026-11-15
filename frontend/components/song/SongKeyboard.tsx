'use client';

import { useEffect, useRef } from 'react';
import { lambdaColor } from '../../lib/prism/ramp';
import { FRAME_UM, CUBE_DEPTH } from '../../lib/song/spherex';

/**
 * Mutable state shared between the song page and the keyboard canvas (no React re-render per
 * tile or per note): which frames have arrived, their values, and per-key light levels.
 */
export class KeyStore {
  arrived = new Uint8Array(CUBE_DEPTH);   // 0 waiting, 1 arrived, 2 blank / no data
  arrivedAt = new Float64Array(CUBE_DEPTH);
  value: (number | null)[] = new Array(CUBE_DEPTH).fill(null);
  lit = new Float64Array(CUBE_DEPTH);     // time (performance.now) a key was last struck
  playhead = -1;                          // frame index of the latest melody note, -1 = none
  progress = -1;                          // 0..1 while playing, -1 otherwise
  reset() {
    this.arrived.fill(0); this.arrivedAt.fill(0); this.value = new Array(CUBE_DEPTH).fill(null);
    this.lit.fill(0); this.playhead = -1; this.progress = -1;
  }
}

const COLOURS = FRAME_UM.map((um) => lambdaColor(um));
const TICKS = [1, 2, 3, 4, 5];
const DETECTOR_STARTS = [0, 17, 34, 51, 68, 85];

function normalise(values: readonly (number | null)[]): number[] {
  const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (!v.length) return values.map(() => 0);
  const lo = v[Math.floor(v.length * 0.03)], hi = v[Math.min(v.length - 1, Math.floor(v.length * 0.98))];
  return values.map((x) => (x === null ? 0 : Math.max(0, Math.min(1, (x - lo) / Math.max(1e-6, hi - lo)))));
}

/** 102-key spectral keyboard on a canvas; animates key arrival, note strikes and a playhead. */
export default function SongKeyboard({ store, label, reducedMotion }: { store: KeyStore; label: string; reducedMotion: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0, w = 0, h = 0, dpr = 1;
    let normKey = '', norm: number[] = [];
    const css = getComputedStyle(cv);
    const ink3 = css.getPropertyValue('--p-ink-3').trim() || '#8f8a81';
    const rule = css.getPropertyValue('--p-rule-2').trim() || '#3a3733';
    const signal = css.getPropertyValue('--p-signal').trim() || '#ff5a1f';
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = cv.clientWidth; h = cv.clientHeight;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    resize();
    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (!w || !h) return;
      const now = performance.now();
      const k = store.value.map((v) => (v === null ? 'n' : v.toFixed(3))).join(',');
      if (k !== normKey) { normKey = k; norm = normalise(store.value); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const axis = 18, top = 4, kh = h - axis - top, n = CUBE_DEPTH, kw = w / n;
      const gap = kw > 5 ? 1.5 : kw > 3 ? 1 : 0.5;
      for (let i = 0; i < n; i++) {
        const x = i * kw;
        const state = store.arrived[i];
        if (state === 0) {
          ctx.strokeStyle = rule; ctx.lineWidth = 1;
          ctx.strokeRect(x + gap / 2 + 0.5, top + kh * 0.55 + 0.5, Math.max(1, kw - gap - 1), kh * 0.45 - 1);
          continue;
        }
        if (state === 2) {
          ctx.fillStyle = rule; ctx.fillRect(x + kw / 2 - 0.5, top + kh * 0.7, 1, kh * 0.3);
          continue;
        }
        const age = reducedMotion ? 1 : Math.min(1, (now - store.arrivedAt[i]) / 380);
        const v = norm[i] ?? 0;
        const bh = kh * (0.18 + 0.82 * v) * (0.4 + 0.6 * age);
        const strike = store.lit[i] ? Math.max(0, 1 - (now - store.lit[i]) / 900) : 0;
        ctx.globalAlpha = Math.min(1, 0.32 + 0.5 * v + 0.6 * strike);
        ctx.fillStyle = COLOURS[i];
        ctx.fillRect(x + gap / 2, top + kh - bh, Math.max(1, kw - gap), bh);
        if (strike > 0) {
          ctx.globalAlpha = strike;
          ctx.fillStyle = '#f6f2ea';
          ctx.fillRect(x + gap / 2, top + kh - bh - 3, Math.max(1, kw - gap), 3);
        }
        ctx.globalAlpha = 1;
      }
      // Detector boundaries and axis ticks.
      ctx.fillStyle = ink3; ctx.strokeStyle = rule; ctx.lineWidth = 1;
      ctx.font = '10.5px ' + (getComputedStyle(document.body).getPropertyValue('--p-font-data') || 'monospace');
      ctx.textBaseline = 'top';
      ctx.beginPath(); ctx.moveTo(0, top + kh + 2.5); ctx.lineTo(w, top + kh + 2.5); ctx.stroke();
      for (const d of DETECTOR_STARTS) { ctx.beginPath(); ctx.moveTo(d * kw + 0.5, top + kh + 2); ctx.lineTo(d * kw + 0.5, top + kh + 6); ctx.stroke(); }
      for (const um of TICKS) {
        let bi = 0, best = Infinity;
        FRAME_UM.forEach((l, i) => { const dd = Math.abs(l - um); if (dd < best) { best = dd; bi = i; } });
        const tx = (bi + 0.5) * kw;
        ctx.textAlign = um === 5 ? 'right' : um === 1 ? 'left' : 'center';
        ctx.fillText(um === 5 ? '5 µm' : String(um), um === 5 ? w : um === 1 ? Math.max(0, tx - 3) : tx, top + kh + 6);
      }
      // Playhead.
      if (store.playhead >= 0 && store.progress >= 0) {
        const px = (store.playhead + 0.5) * kw;
        ctx.strokeStyle = signal; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, top + kh); ctx.stroke();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [store, reducedMotion]);
  return <canvas ref={ref} className="sg-kb" role="img" aria-label={label} />;
}
