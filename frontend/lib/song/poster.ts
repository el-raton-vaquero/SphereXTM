/**
 * Print-ready poster and story image for "Your Sky Song", drawn on a 2D canvas.
 *
 *   poster  2400 x 3200 px (3:4; 30 x 40 cm at 200 dpi)
 *   story   1080 x 1920 px (9:16, for social stories)
 *
 * Contents: the computed star map of that sky (stereographic dome, zenith centre, North up,
 * East left), the real SPHEREx colour image of the zenith patch, the 102-band spectral barcode
 * coloured by the StarChord wavelength ramp, the dedication, date, place, coordinates, a QR code
 * to the shareable song URL, and the integrity/credit lines.
 */
import { lambdaColor } from '../prism/ramp';
import { domeXY, type VisibleSky } from './sky';
import { encodeQr } from './qr';
import type { BodyId } from '../look/sky';

export type PosterFormat = 'poster' | 'story';
export type PosterTheme = 'night' | 'paper';

export interface PosterText {
  brand: string;          // "StarChord · Your Sky Song"
  dedication: string;
  dateLine: string;       // "15 November 2026 · 21:30 (UTC−6)"
  placeLine: string;      // "Mexico City · 19.43° N · 99.13° W"
  zenithLine: string;     // "Zenith RA 03h 12m · Dec +19° 26′"
  cardinals: { N: string; E: string; S: string; W: string };
  bodies: Partial<Record<BodyId, string>>;
  insetLabel: string;     // "SPHEREx · the patch overhead · 9°"
  insetMissing: string;
  barcodeLabel: string;   // "102 colours measured by SPHEREx · 0.75–5.0 µm"
  qrLabel: string;        // "Scan to listen"
  integrity: string;      // short integrity line
  credit: string;         // "NASA/JPL-Caltech/IPAC SPHEREx DR1 · IRSA"
}

export interface PosterData {
  sky: VisibleSky;
  lambda: readonly number[];
  value: readonly (number | null)[];
  image: HTMLCanvasElement | null;
  url: string;
  text: PosterText;
}

const PALETTE = {
  night: { bg: '#0b0a09', ink: '#ece8e1', ink2: '#a8a39a', ink3: '#8f8a81', rule: '#3a3733', faint: '#2a2825', signal: '#ff5a1f', dome: '#0f0e0c' },
  paper: { bg: '#f1ece2', ink: '#14120f', ink2: '#4d4840', ink3: '#6d675d', rule: '#c9c1b2', faint: '#ddd5c6', signal: '#d9480f', dome: '#ebe5d9' },
};

function cssFont(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

export interface Fonts { display: string; body: string; data: string }
export function resolveFonts(): Fonts {
  return {
    display: cssFont('--p-font-display', 'Georgia, serif'),
    body: cssFont('--p-font-body', 'system-ui, sans-serif'),
    data: cssFont('--p-font-data', 'ui-monospace, monospace'),
  };
}

/** Make sure the web fonts are ready before drawing text onto a canvas. */
export async function ensureFonts(f: Fonts): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  try {
    await Promise.all([
      document.fonts.load(`400 64px ${f.display}`),
      document.fonts.load(`italic 400 64px ${f.display}`),
      document.fonts.load(`400 32px ${f.body}`),
      document.fonts.load(`500 32px ${f.data}`),
    ]);
  } catch { /* draw with fallbacks */ }
}

export const FORMAT_SIZE: Record<PosterFormat, [number, number]> = { poster: [2400, 3200], story: [1080, 1920] };

/** Wrap text to lines no wider than maxW. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

function spaced(ctx: CanvasRenderingContext2D, px: number) {
  // letterSpacing is supported in Chromium/Firefox/Safari 17+; ignored elsewhere.
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${px}px`;
}

function drawDome(ctx: CanvasRenderingContext2D, sky: VisibleSky, cx: number, cy: number, R: number, pal: typeof PALETTE.night, f: Fonts, text: PosterText, theme: PosterTheme, ts = 1) {
  const s = R / 900, st = s * ts; // st: text scale
  // Disc.
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = pal.dome; ctx.fill();
  ctx.clip();
  // Altitude rings (30, 60 deg) and meridian / prime vertical.
  ctx.strokeStyle = pal.faint; ctx.lineWidth = Math.max(1, 1.6 * s);
  ctx.setLineDash([6 * s, 10 * s]);
  for (const alt of [30, 60]) {
    const r = Math.hypot(...domeXY(alt, 0)) * R;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
  ctx.setLineDash([]);
  // Stars.
  for (const st of sky.stars) {
    const [x, y] = domeXY(st.alt, st.az);
    const px = cx + x * R, py = cy + y * R;
    const r = s * (0.55 + 0.085 * Math.max(0, 6.4 - st.v) ** 1.95);
    if (theme === 'night') {
      const k = 0.28; // gentle hint of the star's B-V colour on paper-white
      const c = [st.rgb[0], st.rgb[1], st.rgb[2]].map((v, i) => Math.round(255 * (k * Math.min(1, v) + (1 - k) * [0.925, 0.91, 0.882][i])));
      if (st.v < 1.8) {
        const g = ctx.createRadialGradient(px, py, 0, px, py, r * 4.5);
        g.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},0.35)`); g.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, r * 4.5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    } else {
      ctx.fillStyle = pal.ink;
    }
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
  }
  // Moon and planets (markers), then labels with simple collision avoidance (bodies first).
  const boxes: [number, number, number, number][] = [];
  const zh = Math.tan((4.5 * Math.PI) / 180 / 2) * R + 28 * s; // keep labels off the zenith mark
  boxes.push([cx - zh, cy - zh, 2 * zh, 2 * zh]);
  const free = (x: number, y: number, w: number, h: number) => !boxes.some((b) => x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1]);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const b of sky.bodies) {
    const [x, y] = domeXY(b.alt, b.az);
    const px = cx + x * R, py = cy + y * R;
    if (b.id === 'Moon') {
      ctx.fillStyle = theme === 'night' ? '#f3efe6' : pal.ink;
      ctx.beginPath(); ctx.arc(px, py, 15 * s, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.strokeStyle = pal.ink; ctx.lineWidth = 2.2 * s;
      ctx.beginPath(); ctx.arc(px, py, 8 * s, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = pal.ink; ctx.beginPath(); ctx.arc(px, py, 3 * s, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.font = `500 ${Math.round(22 * st)}px ${f.data}`;
  ctx.fillStyle = pal.ink2;
  for (const b of sky.bodies) {
    const [x, y] = domeXY(b.alt, b.az);
    const name = (text.bodies[b.id] ?? b.id).toUpperCase();
    const w = ctx.measureText(name).width, h = 26 * st;
    const lx = cx + x * R + 24 * s;
    let ly = cy + y * R;
    for (let k = 0; k < 6 && !free(lx, ly - h / 2, w, h); k++) ly += h * (k % 2 === 0 ? 1 : -1) * (k + 1);
    boxes.push([lx, ly - h / 2, w, h]);
    ctx.fillText(name, lx, ly);
  }
  ctx.font = `400 ${Math.round(20 * st)}px ${f.data}`;
  ctx.fillStyle = pal.ink3;
  for (const l of sky.labels) {
    const [x, y] = domeXY(l.alt, l.az);
    const lx = cx + x * R + 14 * s, ly = cy + y * R + 2 * s;
    const w = ctx.measureText(l.name).width, h = 24 * st;
    if (!free(lx, ly - h / 2, w, h)) continue;
    boxes.push([lx, ly - h / 2, w, h]);
    ctx.fillText(l.name, lx, ly);
  }
  // Zenith: the patch SPHEREx is sampled from (9 deg square), in signal orange.
  const half = Math.tan((4.5 * Math.PI) / 180 / 2) * R;
  ctx.strokeStyle = pal.signal; ctx.lineWidth = 2.4 * s;
  ctx.strokeRect(cx - half, cy - half, half * 2, half * 2);
  ctx.beginPath();
  ctx.moveTo(cx - half - 26 * s, cy); ctx.lineTo(cx - half - 8 * s, cy);
  ctx.moveTo(cx + half + 8 * s, cy); ctx.lineTo(cx + half + 26 * s, cy);
  ctx.moveTo(cx, cy - half - 26 * s); ctx.lineTo(cx, cy - half - 8 * s);
  ctx.moveTo(cx, cy + half + 8 * s); ctx.lineTo(cx, cy + half + 26 * s);
  ctx.stroke();
  ctx.restore();

  // Horizon ring with azimuth ticks.
  ctx.strokeStyle = pal.ink2; ctx.lineWidth = 2.4 * s;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 1.6 * s; ctx.strokeStyle = pal.ink3;
  for (let az = 0; az < 360; az += 5) {
    const a = (az * Math.PI) / 180, len = (az % 45 === 0 ? 26 : az % 15 === 0 ? 16 : 8) * s;
    const dx = -Math.sin(a), dy = -Math.cos(a);
    ctx.beginPath(); ctx.moveTo(cx + dx * R, cy + dy * R); ctx.lineTo(cx + dx * (R + len), cy + dy * (R + len)); ctx.stroke();
  }
  // Cardinals (East left: we are looking up).
  ctx.fillStyle = pal.ink; ctx.font = `400 ${Math.round(46 * st)}px ${f.display}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const o = R + 30 * s + 26 * st;
  ctx.fillText(text.cardinals.N, cx, cy - o);
  ctx.fillText(text.cardinals.S, cx, cy + o);
  ctx.fillText(text.cardinals.E, cx - o, cy);
  ctx.fillText(text.cardinals.W, cx + o, cy);
}

function drawBarcode(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, lambda: readonly number[], value: readonly (number | null)[], pal: typeof PALETTE.night, f: Fonts, theme: PosterTheme, labelPx: number) {
  const vals = value.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const lo = vals.length ? vals[Math.floor(vals.length * 0.03)] : 0;
  const hi = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.98))] : 1;
  const n = lambda.length, bw = w / n;
  ctx.save();
  for (let i = 0; i < n; i++) {
    const v = value[i];
    const bx = x + i * bw;
    if (v === null) {
      ctx.fillStyle = pal.faint; ctx.fillRect(bx + bw * 0.45, y, Math.max(1, bw * 0.1), h);
      continue;
    }
    const t = Math.max(0, Math.min(1, (v - lo) / Math.max(1e-6, hi - lo)));
    ctx.fillStyle = lambdaColor(lambda[i]);
    ctx.globalAlpha = theme === 'night' ? 0.14 + 0.86 * t : 0.2 + 0.8 * t;
    const bh = h * (0.28 + 0.72 * t);
    ctx.fillRect(bx + bw * 0.12, y + h - bh, bw * 0.76, bh);
  }
  ctx.globalAlpha = 1;
  // Axis.
  ctx.strokeStyle = pal.rule; ctx.lineWidth = Math.max(1, labelPx / 12);
  ctx.beginPath(); ctx.moveTo(x, y + h + labelPx * 0.4); ctx.lineTo(x + w, y + h + labelPx * 0.4); ctx.stroke();
  ctx.fillStyle = pal.ink3; ctx.font = `400 ${labelPx}px ${f.data}`; ctx.textBaseline = 'top';
  const ticks = [1, 2, 3, 4, 5];
  for (const um of ticks) {
    // position by nearest frame index (frames are equal-width bars)
    let k = 0, best = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.abs(lambda[i] - um); if (d < best) { best = d; k = i; } }
    const tx = x + (k + 0.5) * bw;
    ctx.beginPath(); ctx.moveTo(tx, y + h + labelPx * 0.4); ctx.lineTo(tx, y + h + labelPx * 0.85); ctx.stroke();
    ctx.textAlign = um === 5 ? 'right' : 'center';
    ctx.fillText(`${um}${um === 5 ? ' µm' : ''}`, um === 5 ? Math.min(x + w, tx + labelPx) : tx, y + h + labelPx * 1.1);
  }
  ctx.restore();
}

function drawQr(ctx: CanvasRenderingContext2D, url: string, x: number, y: number, size: number, pal: typeof PALETTE.night): boolean {
  let q;
  try { q = encodeQr(url); } catch { return false; }
  const n = q.size + 8; // 4-module quiet zone each side
  const m = Math.floor(size / n);
  const real = m * n, ox = x + (size - real) / 2, oy = y + (size - real) / 2;
  ctx.fillStyle = '#f6f2ea'; ctx.fillRect(ox, oy, real, real);
  ctx.fillStyle = '#0b0a09';
  for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++) if (q.modules[r][c]) ctx.fillRect(ox + (c + 4) * m, oy + (r + 4) * m, m, m);
  ctx.strokeStyle = pal.rule; ctx.lineWidth = 1; ctx.strokeRect(ox + 0.5, oy + 0.5, real - 1, real - 1);
  return true;
}

function drawInset(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement | null, x: number, y: number, size: number, pal: typeof PALETTE.night, f: Fonts, missing: string, s: number) {
  ctx.fillStyle = '#050504'; ctx.fillRect(x, y, size, size);
  if (img) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, x, y, size, size);
  } else {
    ctx.fillStyle = pal.ink3; ctx.font = `400 ${Math.round(18 * s)}px ${f.data}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(missing, x + size / 2, y + size / 2);
  }
  // Corner ticks (instrument style) and the orange centre mark = the zenith.
  ctx.strokeStyle = pal.ink2; ctx.lineWidth = 2 * s;
  const L = 22 * s;
  for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + size, y, -1, 1], [x, y + size, 1, -1], [x + size, y + size, -1, -1]] as const) {
    ctx.beginPath(); ctx.moveTo(cx, cy + dy * L); ctx.lineTo(cx, cy); ctx.lineTo(cx + dx * L, cy); ctx.stroke();
  }
  ctx.strokeStyle = pal.signal; ctx.lineWidth = 2 * s;
  const c = size / 2, g = 10 * s, l = 26 * s;
  ctx.beginPath();
  ctx.moveTo(x + c - g - l, y + c); ctx.lineTo(x + c - g, y + c); ctx.moveTo(x + c + g, y + c); ctx.lineTo(x + c + g + l, y + c);
  ctx.moveTo(x + c, y + c - g - l); ctx.lineTo(x + c, y + c - g); ctx.moveTo(x + c, y + c + g); ctx.lineTo(x + c, y + c + g + l);
  ctx.stroke();
}

function label(ctx: CanvasRenderingContext2D, t: string, x: number, y: number, px: number, color: string, f: Fonts, align: CanvasTextAlign = 'left', maxW?: number) {
  ctx.save();
  ctx.font = `500 ${px}px ${f.data}`; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  spaced(ctx, px * 0.12);
  // toUpperCase() would turn the micro sign into a Greek capital Mu: keep units as written.
  const up = t.split('µm').map((x) => x.toUpperCase()).join('µm');
  if (maxW) ctx.fillText(up, x, y, maxW); else ctx.fillText(up, x, y);
  ctx.restore();
}

/** Draw a poster or story image onto `canvas` (resized to the format). */
export function drawPoster(canvas: HTMLCanvasElement, data: PosterData, format: PosterFormat, theme: PosterTheme, fonts: Fonts = resolveFonts()): void {
  const [W, H] = FORMAT_SIZE[format];
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const pal = PALETTE[theme], f = fonts, T = data.text;
  ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H);

  if (format === 'poster') {
    const M = 150, s = 1;
    // Header.
    label(ctx, T.brand, M, M, 28, pal.ink2, f);
    label(ctx, T.zenithLine, W - M, M, 28, pal.ink3, f, 'right');
    ctx.strokeStyle = pal.rule; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(M, M + 28); ctx.lineTo(W - M, M + 28); ctx.stroke();
    // Dome.
    drawDome(ctx, data.sky, W / 2, 1130, 840, pal, f, T, theme, 1.15);
    // Dedication: one line at up to 96 px, shrinking to 64 px; longer texts wrap to two lines.
    ctx.fillStyle = pal.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const maxW = W - 2 * M - 160;
    ctx.font = `italic 400 96px ${f.display}`;
    const w96 = ctx.measureText(T.dedication || '').width;
    let y: number;
    if (!T.dedication) y = 2200;
    else if (w96 <= maxW || (96 * maxW) / w96 >= 64) {
      const px = Math.min(96, Math.floor((96 * maxW) / Math.max(1, w96)));
      ctx.font = `italic 400 ${px}px ${f.display}`;
      ctx.fillText(T.dedication, W / 2, 2210);
      y = 2290;
    } else {
      ctx.font = `italic 400 64px ${f.display}`;
      const ded = wrap(ctx, T.dedication, maxW).slice(0, 2);
      ctx.fillText(ded[0], W / 2, 2170);
      if (ded[1]) ctx.fillText(ded[1], W / 2, 2246);
      y = 2300;
    }
    label(ctx, T.dateLine, W / 2, y + 20, 34, pal.ink2, f, 'center');
    label(ctx, T.placeLine, W / 2, y + 76, 30, pal.ink3, f, 'center');
    // Bottom band: inset | barcode | QR.
    const by = 2470, bh = 360;
    ctx.strokeStyle = pal.rule; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(M, by - 60); ctx.lineTo(W - M, by - 60); ctx.stroke();
    drawInset(ctx, data.image, M, by, bh, pal, f, T.insetMissing, s);
    label(ctx, T.insetLabel, M, by + bh + 46, 20, pal.ink3, f, 'left', bh);
    const qx = W - M - bh;
    const bx = M + bh + 80, bw = qx - 80 - bx;
    drawBarcode(ctx, bx, by + 30, bw, bh - 120, data.lambda, data.value, pal, f, theme, 22);
    label(ctx, T.barcodeLabel, bx, by + bh + 46, 20, pal.ink3, f, 'left', bw);
    drawQr(ctx, data.url, qx, by, bh, pal);
    label(ctx, T.qrLabel, qx + bh, by + bh + 46, 20, pal.ink3, f, 'right');
    // Footer.
    ctx.fillStyle = pal.ink3; ctx.font = `400 21px ${f.body}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const lines = wrap(ctx, T.integrity, W - 2 * M - 700).slice(0, 3);
    lines.forEach((l, i) => ctx.fillText(l, M, H - M + 10 - (lines.length - 1 - i) * 30));
    label(ctx, T.credit, W - M, H - M + 10, 19, pal.ink3, f, 'right');
  } else {
    const M = 72, s = 0.5;
    label(ctx, T.brand, M, M + 30, 20, pal.ink2, f);
    ctx.strokeStyle = pal.rule; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(M, M + 50); ctx.lineTo(W - M, M + 50); ctx.stroke();
    drawDome(ctx, data.sky, W / 2, 620, 420, pal, f, T, theme, 1.7);
    ctx.fillStyle = pal.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = `italic 400 58px ${f.display}`;
    const ded = wrap(ctx, T.dedication || '', W - 2 * M - 40).slice(0, 3);
    let y = 1200;
    for (const l of ded) { ctx.fillText(l, W / 2, y); y += 70; }
    if (!ded.length) y = 1160;
    label(ctx, T.dateLine, W / 2, y + 10, 22, pal.ink2, f, 'center');
    label(ctx, T.placeLine, W / 2, y + 48, 19, pal.ink3, f, 'center');
    const barY = Math.max(y + 110, 1390);
    drawBarcode(ctx, M, barY, W - 2 * M, 120, data.lambda, data.value, pal, f, theme, 16);
    label(ctx, T.barcodeLabel, M, barY + 178, 15, pal.ink3, f, 'left', W - 2 * M);
    const rowY = barY + 222, sz = 230;
    drawInset(ctx, data.image, M, rowY, sz, pal, f, T.insetMissing, s);
    label(ctx, T.insetLabel.split(' · ')[0], M, rowY + sz + 30, 14, pal.ink3, f);
    drawQr(ctx, data.url, W - M - sz, rowY, sz, pal);
    label(ctx, T.qrLabel, W - M, rowY + sz + 30, 14, pal.ink3, f, 'right');
    label(ctx, T.zenithLine, W / 2, rowY + sz / 2 - 10, 14, pal.ink3, f, 'center');
    label(ctx, T.credit, W / 2, rowY + sz / 2 + 22, 13, pal.ink3, f, 'center');
  }
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
}

/** The star dome alone (for the page), drawn square at `px` CSS pixels times the device ratio. */
export function drawSkyChart(canvas: HTMLCanvasElement, sky: VisibleSky, text: Pick<PosterText, 'cardinals' | 'bodies'>, px: number, dpr: number, fonts: Fonts = resolveFonts()): void {
  const W = Math.round(px * dpr);
  if (canvas.width !== W) { canvas.width = W; canvas.height = W; }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const pal = PALETTE.night;
  ctx.clearRect(0, 0, W, W);
  const ts = Math.max(1, (11 * dpr) / (20 * (W / 2 / 900) * 0.95));
  const R = W / 2 / (1 + (30 + 54 * ts) / 900);
  const full: PosterText = {
    brand: '', dedication: '', dateLine: '', placeLine: '', zenithLine: '', insetLabel: '', insetMissing: '', barcodeLabel: '', qrLabel: '', integrity: '', credit: '',
    ...text,
  };
  drawDome(ctx, sky, W / 2, W / 2, R, { ...pal, dome: pal.bg }, fonts, full, 'night', ts);
}
