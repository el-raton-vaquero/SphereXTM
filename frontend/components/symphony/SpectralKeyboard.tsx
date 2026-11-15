'use client';

import { useEffect, useRef } from 'react';
import { BANDS, N_BANDS } from '../../lib/symphony/core';
import type { SymphonyEngine } from '../../lib/symphony/engine';
import { lambdaColor } from '../../lib/prism/ramp';

interface Props {
  /** Normalised band values (0..1, NaN = empty) shown when silent; while playing the engine's glide is drawn. */
  bands: ArrayLike<number> | null;
  getEngine: () => SymphonyEngine | null;
  playing: boolean;
  compact?: boolean;
  ariaLabel: string;
  shortLabel?: string;
  longLabel?: string;
}

const KEY_COLOURS = BANDS.map((b) => lambdaColor(b.center));
const TICKS = [0.75, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

/** x position (0..1) of a wavelength on the band axis (bands are equal-width keys). */
function tickPos(um: number): number {
  for (const b of BANDS) {
    if (um >= b.lo && um <= b.hi) return (b.index + Math.log(um / b.lo) / Math.log(b.hi / b.lo)) / N_BANDS;
  }
  // In a gap between detectors: snap to the nearest band edge.
  let best = 0, bestD = Infinity;
  for (const b of BANDS) {
    const d = Math.abs(Math.log(um / b.center));
    if (d < bestD) { bestD = d; best = b.index + (um > b.center ? 1 : 0); }
  }
  return best / N_BANDS;
}

function cssVar(el: Element, name: string, fallback: string) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * 102-key "spectral keyboard": one key per SPHEREx band, coloured by the wavelength ramp.
 * Bars show the band's brightness in the region; keys light up as their notes play.
 */
export default function SpectralKeyboard({ bands, getEngine, playing, compact, ariaLabel, shortLabel, longLabel }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bandsRef = useRef(bands);
  const drawRef = useRef<() => void>(() => {});

  useEffect(() => {
    bandsRef.current = bands;
    drawRef.current();
  }, [bands]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const ink3 = cssVar(wrap, '--p-ink-3', '#8f8a81');
    const rule = cssVar(wrap, '--p-rule', '#2a2825');
    const rule2 = cssVar(wrap, '--p-rule-2', '#3a3733');
    const signal = cssVar(wrap, '--p-signal', '#ff5a1f');
    let w = 0, h = 0, dpr = 1;

    const draw = () => {
      if (!w || !h) return;
      const eng = getEngine();
      const vis = playing && eng ? eng.getVisual() : null;
      const vals = vis ? vis.bands : bandsRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const kw = w / N_BANDS;
      const keyH = compact ? h * 0.42 : h * 0.34;
      const barTop = compact ? 2 : 6;
      const barH = h - keyH - barTop - (compact ? 3 : 6);
      const keyY = h - keyH;
      // Detector separators.
      ctx.fillStyle = rule;
      for (let d = 1; d < 6; d++) ctx.fillRect(Math.round(d * 17 * kw) - 0.5, 0, 1, h);
      for (let i = 0; i < N_BANDS; i++) {
        const x = i * kw;
        const v = vals ? vals[i] : NaN;
        const lit = vis ? vis.lit[i] : 0;
        const col = KEY_COLOURS[i];
        const gap = kw > 4 ? 1 : 0.5;
        if (Number.isFinite(v)) {
          const bh = Math.max(1, v * barH);
          ctx.globalAlpha = 0.28 + 0.5 * lit;
          ctx.fillStyle = col;
          ctx.fillRect(x + gap / 2, barTop + barH - bh, kw - gap, bh);
        } else {
          // Hatched stub: no data in this band.
          ctx.globalAlpha = 1;
          ctx.strokeStyle = rule2;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x + 1, barTop + barH);
          ctx.lineTo(x + kw - 1, barTop + barH - Math.min(kw, 6));
          ctx.stroke();
        }
        // Key.
        const lift = lit * (compact ? 2 : 4);
        ctx.globalAlpha = Number.isFinite(v) ? 0.22 + 0.78 * lit : 0.08;
        ctx.fillStyle = col;
        ctx.fillRect(x + gap / 2, keyY - lift, kw - gap, keyH + lift);
      }
      ctx.globalAlpha = 1;
      // Cursor.
      if (vis && vis.cursor >= 0) {
        ctx.fillStyle = signal;
        ctx.fillRect(Math.round((vis.cursor + 0.5) * kw) - 1, 0, 2, h);
      }
      // Baseline.
      ctx.fillStyle = ink3;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(0, keyY - 1, w, 1);
      ctx.globalAlpha = 1;
    };
    drawRef.current = draw;

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(10, Math.floor(r.width));
      h = Math.max(10, Math.floor(r.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      draw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    let raf = 0;
    if (playing) {
      const loop = () => { draw(); raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
    }
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      drawRef.current = () => {};
    };
  }, [playing, compact, getEngine]);

  return (
    <div className={`sym-kb${compact ? ' sym-kb-compact' : ''}`}>
      <div ref={wrapRef} className="sym-kb-canvas" role="img" aria-label={ariaLabel}>
        <canvas ref={canvasRef} />
      </div>
      {!compact && (
        <div className="sym-kb-axis p-data" aria-hidden="true">
          {TICKS.map((t) => (
            <span key={t} style={{ left: `${(tickPos(t) * 100).toFixed(2)}%` }}>{t}</span>
          ))}
        </div>
      )}
      {!compact && (shortLabel || longLabel) && (
        <div className="sym-kb-ends p-data" aria-hidden="true">
          <span>{shortLabel}</span>
          <span>{longLabel}</span>
        </div>
      )}
    </div>
  );
}
