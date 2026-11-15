'use client';

import { useEffect, useRef } from 'react';
import { computeLevels, renderGray } from '../../lib/prism/imaging';

interface Props {
  image: Float32Array;
  n: number;
  x: number;
  y: number;
  r: number;
  ariaLabel: string;
  onMove: (x: number, y: number) => void;
  onRadius: (r: number) => void;
  minR: number;
  maxR: number;
}

function cssVar(el: Element, name: string, fallback: string) {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/**
 * The SPHEREx plate (median co-add, asinh stretch, north up / east left) with a draggable
 * listening circle. Pointer: tap or drag. Keyboard: arrows move (Shift = 3 px), +/- resize.
 */
export default function PlateCanvas({ image, n, x, y, r, ariaLabel, onMove, onRadius, minR, maxR }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const plateRef = useRef<HTMLCanvasElement | null>(null);
  const dragging = useRef(false);
  const sizeRef = useRef(0);
  const posRef = useRef({ x, y, r });
  const redrawRef = useRef<() => void>(() => {});

  // Off-screen n x n render of the plate.
  useEffect(() => {
    const off = document.createElement('canvas');
    off.width = n; off.height = n;
    const octx = off.getContext('2d');
    if (!octx) return;
    const img = octx.createImageData(n, n);
    renderGray(image, computeLevels(image, 'asinh'), 'asinh', img.data);
    octx.putImageData(img, 0, 0);
    plateRef.current = off;
    redrawRef.current();
  }, [image, n]);

  useEffect(() => {
    posRef.current = { x, y, r };
    redrawRef.current();
  }, [x, y, r]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const signal = cssVar(wrap, '--p-signal', '#ff5a1f');
    const ink = cssVar(wrap, '--p-ink', '#ece8e1');
    const ink3 = cssVar(wrap, '--p-ink-3', '#8f8a81');
    let dpr = 1;

    const draw = () => {
      const s = sizeRef.current;
      if (!s) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, s, s);
      if (plateRef.current) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(plateRef.current, 0, 0, s, s);
      }
      const k = s / n;
      const { x: px, y: py, r: pr } = posRef.current;
      const cx = (px + 0.5) * k, cy = (py + 0.5) * k, rr = pr * k;
      // Soft dimming outside the circle so the listened region reads at a glance.
      ctx.save();
      ctx.fillStyle = 'rgba(11,10,9,0.38)';
      ctx.beginPath();
      ctx.rect(0, 0, s, s);
      ctx.arc(cx, cy, rr, 0, Math.PI * 2, true);
      ctx.fill('evenodd');
      ctx.restore();
      ctx.strokeStyle = signal;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.stroke();
      // Tick marks on the ring (instrument reticle).
      ctx.lineWidth = 1;
      for (let a = 0; a < 4; a++) {
        const ang = (a * Math.PI) / 2;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(ang) * (rr + 3), cy + Math.sin(ang) * (rr + 3));
        ctx.lineTo(cx + Math.cos(ang) * (rr + 9), cy + Math.sin(ang) * (rr + 9));
        ctx.stroke();
      }
      // Compass.
      ctx.fillStyle = ink3;
      ctx.font = '11.5px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('N', s / 2, 13);
      ctx.textAlign = 'left';
      ctx.fillText('E', 6, s / 2 + 4);
      ctx.fillStyle = ink;
    };
    redrawRef.current = draw;

    const resize = () => {
      const w = Math.floor(wrap.getBoundingClientRect().width);
      dpr = Math.min(2, window.devicePixelRatio || 1);
      sizeRef.current = w;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(w * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${w}px`;
      draw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => { ro.disconnect(); redrawRef.current = () => {}; };
  }, [n]);

  const toGrid = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const k = rect.width / n;
    const gx = (e.clientX - rect.left) / k - 0.5;
    const gy = (e.clientY - rect.top) / k - 0.5;
    return { gx: Math.min(n - 1, Math.max(0, gx)), gy: Math.min(n - 1, Math.max(0, gy)) };
  };

  return (
    <div
      ref={wrapRef}
      className="sym-plate"
      role="application"
      tabIndex={0}
      aria-label={ariaLabel}
      onPointerDown={(e) => {
        dragging.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const { gx, gy } = toGrid(e);
        onMove(gx, gy);
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        const { gx, gy } = toGrid(e);
        onMove(gx, gy);
      }}
      onPointerUp={() => { dragging.current = false; }}
      onPointerCancel={() => { dragging.current = false; }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 3 : 1;
        const clamp = (v: number) => Math.min(n - 1, Math.max(0, v));
        let handled = true;
        if (e.key === 'ArrowLeft') onMove(clamp(x - step), y);
        else if (e.key === 'ArrowRight') onMove(clamp(x + step), y);
        else if (e.key === 'ArrowUp') onMove(x, clamp(y - step));
        else if (e.key === 'ArrowDown') onMove(x, clamp(y + step));
        else if (e.key === '+' || e.key === '=') onRadius(Math.min(maxR, r + 0.5));
        else if (e.key === '-' || e.key === '_') onRadius(Math.max(minR, r - 0.5));
        else handled = false;
        if (handled) e.preventDefault();
      }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
