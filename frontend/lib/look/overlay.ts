/**
 * Canvas overlay for the camera / manual sky view: horizon and alt-az grid, BSC5 stars, named
 * stars, Sun/Moon/planets and the StarChord targets, projected with the pinhole camera model.
 * Colours follow the StarChord tokens: paper ink for the sky furniture, signal orange only for
 * StarChord targets and the reticle.
 */
import { focalPx, project, dot, type CamBasis, type View } from './camera';
import type { StarField } from './hooks';
import { NAMED_STARS } from './stars';
import { altAzToEnu, applyM, eqjToEnu, type BodyState, type M3, type V3 } from './sky';

export interface OverlayLayers { stars: boolean; planets: boolean; targets: boolean; grid: boolean }
export interface OverlayTarget { id: string; name: string; ra: number; dec: number }

export interface OverlayInput {
  ctx: CanvasRenderingContext2D;
  view: View;
  dpr: number;
  basis: CamBasis;
  m: M3; // EQJ -> ENU
  field: StarField | null;
  bodies: BodyState[];
  targets: OverlayTarget[];
  layers: OverlayLayers;
  labels: { cardinal: string[]; bodies: Record<string, string>; horizon: string };
  /** Opaque night background (manual mode) instead of a transparent overlay on video. */
  background: boolean;
  fonts: { data: string; body: string };
}

const INK = 'rgba(236,232,225,';
const SIGNAL = '#ff5a1f';

function polyline(ctx: CanvasRenderingContext2D, pts: ({ x: number; y: number } | null)[], maxJump: number) {
  let open = false;
  let prev: { x: number; y: number } | null = null;
  ctx.beginPath();
  for (const p of pts) {
    if (!p || (prev && Math.hypot(p.x - prev.x, p.y - prev.y) > maxJump)) { open = false; prev = p; if (!p) continue; }
    if (!open) { ctx.moveTo(p.x, p.y); open = true; } else ctx.lineTo(p.x, p.y);
    prev = p;
  }
  ctx.stroke();
}

/** Draws the overlay and returns the screen positions of targets (for hit testing). */
export function drawOverlay(o: OverlayInput): { id: string; x: number; y: number }[] {
  const { ctx, view, dpr, basis, m, field, layers } = o;
  const W = view.w, H = view.h;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (o.background) {
    ctx.fillStyle = '#0b0a09';
    ctx.fillRect(0, 0, W, H);
  }
  const P = (d: V3) => project(basis, view, d);
  const maxJump = Math.max(W, H) * 0.8;

  // Ground shading below the horizon (manual mode only; on video the real ground is visible).
  // Manual mode has zero roll, so the horizon (a great circle) projects to a horizontal line.
  if (o.background) {
    const altC = Math.asin(Math.max(-1, Math.min(1, basis.f[2])));
    const yH = H / 2 + Math.tan(altC) * focalPx(view);
    if (yH < H) {
      ctx.fillStyle = '#151412';
      ctx.fillRect(0, Math.max(0, yH), W, H - Math.max(0, yH));
    }
  }

  ctx.lineWidth = 1;
  if (layers.grid) {
    ctx.strokeStyle = `${INK}0.16)`;
    for (const alt of [30, 60]) {
      const pts = [];
      for (let az = 0; az <= 360; az += 2) pts.push(P(altAzToEnu(alt, az)));
      polyline(ctx, pts, maxJump);
    }
    for (let az = 0; az < 360; az += 45) {
      const pts = [];
      for (let alt = 0; alt <= 88; alt += 2) pts.push(P(altAzToEnu(alt, az)));
      polyline(ctx, pts, maxJump);
    }
  }
  // Horizon (always) + cardinal points
  ctx.strokeStyle = `${INK}0.45)`;
  {
    const pts = [];
    for (let az = 0; az <= 360; az += 1) pts.push(P(altAzToEnu(0, az)));
    polyline(ctx, pts, maxJump);
  }
  ctx.font = `500 13px ${o.fonts.body}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  o.labels.cardinal.forEach((lab, i) => {
    const p = P(altAzToEnu(0, i * 45));
    if (!p || p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) return;
    ctx.fillStyle = i % 2 ? `${INK}0.55)` : `${INK}0.95)`;
    ctx.fillText(lab, p.x, p.y - 4);
  });

  // Stars (BSC5)
  if (layers.stars && field) {
    const limit = o.background ? 5.5 : 4.8;
    for (let i = 0; i < field.n; i++) {
      const v = field.vmag[i];
      if (v > limit) break; // sorted by magnitude
      const e = applyM(m, [field.xyz[i * 3], field.xyz[i * 3 + 1], field.xyz[i * 3 + 2]]);
      if (e[2] < -0.02) continue;
      const p = P(e);
      if (!p || p.x < -4 || p.x > W + 4 || p.y < -4 || p.y > H + 4) continue;
      const r = Math.max(0.6, 2.6 - 0.42 * v);
      const a = Math.min(1, 0.35 + 0.65 * (5.5 - v) / 6);
      ctx.fillStyle = `${INK}${a.toFixed(2)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (layers.stars) {
    ctx.font = `400 12px ${o.fonts.body}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const fovFactor = view.vfov > 70 ? 1.6 : 2.4;
    for (const s of NAMED_STARS) {
      if (s.v > fovFactor && view.vfov > 45) continue;
      const e = eqjToEnu(m, s.ra, s.dec);
      if (e[2] < -0.02) continue;
      const p = P(e);
      if (!p || p.x < 0 || p.x > W - 30 || p.y < 8 || p.y > H - 8) continue;
      if (!field) { ctx.fillStyle = `${INK}0.9)`; ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = `${INK}0.72)`;
      ctx.fillText(s.name, p.x + 6, p.y - 6);
    }
  }

  // Sun, Moon, planets
  if (layers.planets) {
    ctx.font = `500 12.5px ${o.fonts.body}`;
    ctx.textBaseline = 'middle';
    for (const b of o.bodies) {
      const e = altAzToEnu(b.alt, b.az);
      const p = P(e);
      if (!p || p.x < -30 || p.x > W + 30 || p.y < -30 || p.y > H + 30) continue;
      const big = b.id === 'Sun' || b.id === 'Moon';
      const r = big ? Math.max(5, (0.26 / view.vfov) * H) : 4;
      ctx.strokeStyle = `${INK}0.95)`;
      ctx.fillStyle = b.id === 'Sun' ? `${INK}0.95)` : `${INK}0.25)`;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = `${INK}0.95)`;
      ctx.textAlign = 'left';
      ctx.fillText(o.labels.bodies[b.id] ?? b.id, p.x + r + 5, p.y);
    }
  }

  // StarChord targets
  const hits: { id: string; x: number; y: number }[] = [];
  if (layers.targets) {
    ctx.font = `500 12.5px ${o.fonts.body}`;
    for (const t of o.targets) {
      const e = eqjToEnu(m, t.ra, t.dec);
      const p = P(e);
      const onScreen = p && p.x > 0 && p.x < W && p.y > 0 && p.y < H;
      if (onScreen && p) {
        ctx.strokeStyle = SIGNAL;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(p.x - 14, p.y); ctx.lineTo(p.x - 10, p.y); ctx.moveTo(p.x + 10, p.y); ctx.lineTo(p.x + 14, p.y); ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = SIGNAL;
        ctx.textAlign = 'left';
        ctx.fillText(t.name, p.x + 16, p.y);
        hits.push({ id: t.id, x: p.x, y: p.y });
      } else if (e[2] > 0) {
        // Edge marker pointing toward an off-screen target above the horizon.
        const dx = dot(e, basis.r), dy = dot(e, basis.u);
        const ang = Math.atan2(-dy, dx);
        const cx = W / 2, cy = H / 2;
        const k = Math.min((W / 2 - 18) / Math.abs(Math.cos(ang) || 1e-6), (H / 2 - 18) / Math.abs(Math.sin(ang) || 1e-6));
        const x = cx + Math.cos(ang) * k, y = cy + Math.sin(ang) * k;
        ctx.save();
        ctx.translate(x, y); ctx.rotate(ang);
        ctx.fillStyle = SIGNAL;
        ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-4, -5); ctx.lineTo(-4, 5); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    }
  }

  // Reticle
  const cx = W / 2, cy = H / 2;
  ctx.strokeStyle = SIGNAL;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cx, cy, 22, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 34, cy); ctx.lineTo(cx - 26, cy); ctx.moveTo(cx + 26, cy); ctx.lineTo(cx + 34, cy);
  ctx.moveTo(cx, cy - 34); ctx.lineTo(cx, cy - 26); ctx.moveTo(cx, cy + 26); ctx.lineTo(cx, cy + 34);
  ctx.stroke();
  ctx.lineWidth = 1;
  return hits;
}
