'use client';

import { useEffect, useRef } from 'react';
import type { StarField } from '../../lib/look/hooks';
import { NAMED_STARS } from '../../lib/look/stars';
import { applyM, enuToAltAz, eqjToEnu, type BodyState, type M3 } from '../../lib/look/sky';

export interface DomeTarget { id: string; name: string; ra: number; dec: number }

/**
 * All-sky dome (azimuthal equidistant): zenith at the centre, horizon at the rim, North up and
 * East to the LEFT, as when lying on your back looking up with your head to the North.
 */
export default function DomeChart({ m, field, bodies, targets, cardinal, bodyNames, pick, onPick, label }: {
  m: M3; field: StarField | null; bodies: BodyState[]; targets: DomeTarget[]; cardinal: string[]; bodyNames: Record<string, string>;
  pick: { alt: number; az: number } | null; onPick: (alt: number, az: number) => void; label: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const draw = () => {
      const size = c.clientWidth;
      if (!size) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = Math.round(size * dpr); c.height = Math.round(size * dpr);
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cs = getComputedStyle(document.documentElement);
      const bodyFont = cs.getPropertyValue('--p-font-body').trim() || 'sans-serif';
      const cx = size / 2, cy = size / 2, R = size / 2 - 26;
      const xy = (alt: number, az: number) => {
        const r = ((90 - alt) / 90) * R, a = (az * Math.PI) / 180;
        return { x: cx - r * Math.sin(a), y: cy - r * Math.cos(a) };
      };
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = '#0e0d0c';
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(236,232,225,0.14)';
      ctx.lineWidth = 1;
      for (const alt of [30, 60]) { ctx.beginPath(); ctx.arc(cx, cy, ((90 - alt) / 90) * R, 0, Math.PI * 2); ctx.stroke(); }
      for (let az = 0; az < 360; az += 45) { const p = xy(0, az); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p.x, p.y); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(236,232,225,0.5)';
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.font = `500 13px ${bodyFont}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      cardinal.forEach((lab, i) => {
        if (i % 2) return;
        const r = R + 14, a = (i * 45 * Math.PI) / 180;
        ctx.fillStyle = 'rgba(236,232,225,0.85)';
        ctx.fillText(lab, cx - r * Math.sin(a), cy - r * Math.cos(a));
      });
      // stars
      if (field) {
        for (let i = 0; i < field.n; i++) {
          const v = field.vmag[i];
          if (v > 5) break;
          const e = applyM(m, [field.xyz[i * 3], field.xyz[i * 3 + 1], field.xyz[i * 3 + 2]]);
          if (e[2] < 0) continue;
          const { alt, az } = enuToAltAz(e);
          const p = xy(alt, az);
          const r = Math.max(0.5, 2.2 - 0.38 * v);
          ctx.fillStyle = `rgba(236,232,225,${Math.min(1, 0.35 + (5 - v) / 6).toFixed(2)})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
        }
      }
      // marks: bodies, then StarChord targets
      const labels: { text: string; x: number; y: number; off: number; font: string; color: string }[] = [];
      for (const b of bodies) {
        if (b.alt < 0) continue;
        const p = xy(b.alt, b.az);
        const big = b.id === 'Sun' || b.id === 'Moon';
        ctx.strokeStyle = 'rgba(236,232,225,0.95)';
        ctx.fillStyle = b.id === 'Sun' ? 'rgba(236,232,225,0.95)' : 'rgba(236,232,225,0.25)';
        ctx.beginPath(); ctx.arc(p.x, p.y, big ? 6 : 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      const tgLabels: typeof labels = [];
      for (const tg of targets) {
        const e = eqjToEnu(m, tg.ra, tg.dec);
        if (e[2] < 0) continue;
        const { alt, az } = enuToAltAz(e);
        const p = xy(alt, az);
        ctx.strokeStyle = '#ff5a1f'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1;
        tgLabels.push({ text: tg.name, x: p.x, y: p.y, off: 9, font: `500 12px ${bodyFont}`, color: '#ff5a1f' });
      }
      // labels in priority order (targets, bodies by brightness, bright stars), skipping collisions
      labels.push(...tgLabels);
      for (const b of [...bodies].filter((x) => x.alt >= 0).sort((a, c) => (a.mag ?? 9) - (c.mag ?? 9))) {
        const p = xy(b.alt, b.az);
        labels.push({ text: bodyNames[b.id] ?? b.id, x: p.x, y: p.y, off: 8, font: `500 12px ${bodyFont}`, color: 'rgba(236,232,225,0.95)' });
      }
      for (const s of NAMED_STARS) {
        if (s.v > 1.3) continue;
        const e = eqjToEnu(m, s.ra, s.dec);
        if (e[2] < 0.05) continue;
        const { alt, az } = enuToAltAz(e);
        const p = xy(alt, az);
        labels.push({ text: s.name, x: p.x, y: p.y, off: 5, font: `400 11.5px ${bodyFont}`, color: 'rgba(236,232,225,0.6)' });
      }
      const boxes: [number, number, number, number][] = [];
      const hit = (b: [number, number, number, number]) => boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
      ctx.textBaseline = 'middle';
      for (const l of labels) {
        ctx.font = l.font;
        const w = ctx.measureText(l.text).width;
        const right: [number, number, number, number] = [l.x + l.off, l.y - 7, l.x + l.off + w, l.y + 7];
        const left: [number, number, number, number] = [l.x - l.off - w, l.y - 7, l.x - l.off, l.y + 7];
        const box = !hit(right) ? right : !hit(left) ? left : null;
        if (!box) continue;
        boxes.push(box);
        ctx.fillStyle = l.color;
        ctx.textAlign = 'left';
        ctx.fillText(l.text, box[0], l.y);
      }
      if (pick) {
        const p = xy(pick.alt, pick.az);
        ctx.strokeStyle = '#ff5a1f'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(p.x - 12, p.y); ctx.lineTo(p.x - 4, p.y); ctx.moveTo(p.x + 4, p.y); ctx.lineTo(p.x + 12, p.y);
        ctx.moveTo(p.x, p.y - 12); ctx.lineTo(p.x, p.y - 4); ctx.moveTo(p.x, p.y + 4); ctx.lineTo(p.x, p.y + 12);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [m, field, bodies, targets, cardinal, bodyNames, pick]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget;
    const rect = c.getBoundingClientRect();
    const size = rect.width, R = size / 2 - 26;
    const x = e.clientX - rect.left - size / 2, y = e.clientY - rect.top - size / 2;
    const r = Math.hypot(x, y);
    if (r > R) return;
    const alt = 90 - (r / R) * 90;
    let az = (Math.atan2(-x, -y) * 180) / Math.PI;
    if (az < 0) az += 360;
    onPick(alt, az);
  };

  return <canvas ref={ref} className="look-dome" role="img" aria-label={label} onClick={onClick} />;
}
