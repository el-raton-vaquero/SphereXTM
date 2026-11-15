/**
 * "What am I looking at?" — a short, honest reading of the image currently on screen in /explore.
 * Pure: measures the pixels (robust background, noise, signal at the target) and combines that with
 * the frame metadata (saturation, quality flags, coverage, wavelength, view mode) into a headline
 * plus 1-3 plain-language reasons. Nothing here is a scientific claim; it explains what the
 * picture shows (noise, a source, a saturated star, an artifact...) and why.
 */
import type { Frame, ViewMode } from './types';

export type ReadingKind = 'source' | 'faint' | 'noise' | 'saturated' | 'artifact' | 'partial' | 'empty' | 'diff-static' | 'diff-moving' | 'info';

export interface Reading { kind: ReadingKind; title: string; lines: string[]; snr: number | null }

export interface ReadingInput {
  mode: ViewMode;
  image: Float32Array | null;
  n: number;
  /** Target pixel position on the grid (falls back to the centre). */
  at: { x: number; y: number } | null;
  current: Frame;
  /** Frames combined into the image (co-add / difference). */
  nFrames: number;
  locale: 'en' | 'es';
}

const ARTIFACT = new Set(['TRANSIENT', 'PERSIST', 'OUTLIER', 'CROSSTALK', 'GHOST', 'GHOST_FPA', 'GHOST_EXT', 'STREAK', 'SNOWBALL', 'HALO']);
const BAD = new Set(['SUR_ERROR', 'NONFUNC', 'DICHROIC', 'MISSING_DATA', 'HOT', 'COLD', 'PHANMISS']);
const SAT = new Set(['OVERFLOW', 'NONLINEAR', 'BLOOM']);

function median(a: number[]): number { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }

export interface ImageStats { valid: number; med: number; sigma: number; peak: number; trough: number; snr: number; neg: number }

/** Robust background (median), noise (1.4826·MAD) and the strongest signal within 3 px of `at`. */
export function imageStats(img: Float32Array, n: number, at: { x: number; y: number } | null): ImageStats {
  const vals: number[] = [];
  const step = Math.max(1, Math.floor(img.length / 20000));
  let valid = 0;
  for (let i = 0; i < img.length; i++) if (Number.isFinite(img[i])) valid++;
  for (let i = 0; i < img.length; i += step) if (Number.isFinite(img[i])) vals.push(img[i]);
  const med = median(vals);
  const sigma = Math.max(1e-9, 1.4826 * median(vals.map((v) => Math.abs(v - med))));
  const cx = at ? at.x : n / 2, cy = at ? at.y : n / 2;
  let peak = -Infinity, trough = Infinity;
  for (let y = Math.floor(cy - 3); y <= Math.ceil(cy + 3); y++) for (let x = Math.floor(cx - 3); x <= Math.ceil(cx + 3); x++) {
    if (x < 0 || y < 0 || x >= n || y >= n || Math.hypot(x - cx, y - cy) > 3.2) continue;
    const v = img[y * n + x];
    if (!Number.isFinite(v)) continue;
    if (v > peak) peak = v;
    if (v < trough) trough = v;
  }
  return {
    valid: img.length ? valid / img.length : 0, med, sigma,
    peak: Number.isFinite(peak) ? peak : NaN, trough: Number.isFinite(trough) ? trough : NaN,
    snr: Number.isFinite(peak) ? (peak - med) / sigma : NaN,
    neg: Number.isFinite(trough) ? (med - trough) / sigma : NaN,
  };
}

const T = {
  en: {
    lam: (l: number) => `${l.toFixed(2)} µm`,
    source: 'A clear source at the target',
    sourceWhy: (s: string) => `The target stands ${s}× above the background noise, so what you see there is real light.`,
    faint: 'A faint source, close to the noise',
    faintWhy: (s: string) => `The target is only ${s}× the noise: there is probably something there, but a single frame barely shows it.`,
    noise: 'Mostly noise',
    noiseWhy: (l: string) => `At ${l} the target is too faint to rise above the grain in one short exposure. The grain is detector and photon noise plus the glow of zodiacal dust.`,
    noiseTipFrame: 'Try "Co-add": combining many frames lowers the noise and can reveal faint objects.',
    noiseTipCoadd: (k: number) => `Even after combining ${k} frames nothing rises clearly above the noise at this wavelength; try another detector or season.`,
    flicker: 'Each SPHEREx frame sees the sky in a different colour, so brightness changes from frame to frame even if nothing moves.',
    saturated: 'Saturated star: the centre is not real structure',
    saturatedWhy: 'This star is too bright for SPHEREx: the detector fills up, so the core is clipped, flat or blank and can bleed into rings and streaks. Its brightness and position here cannot be trusted.',
    artifact: 'Possible artifact at the target',
    artifactWhy: (f: string) => `The pipeline flags this spot (${f}): ghosts, streaks, cosmic-ray hits or leftover charge can look like sources but are not.`,
    bad: (f: string) => `Some pixels at the target are marked unusable (${f}).`,
    partial: 'Partly outside the detector',
    partialWhy: (p: string) => `Only ${p}% of this view has data; blank areas fall off the edge of the detector or were masked.`,
    empty: 'No data here',
    emptyWhy: 'This frame does not cover the target. Pick another frame on the timeline.',
    diffStatic: 'Difference: nothing obvious changed',
    diffStaticWhy: 'Stars that stay put cancel out (grey). What remains is noise and small calibration differences between seasons.',
    diffMoving: 'Difference: a dark/bright pair at the target',
    diffMovingWhy: 'Bright = where the light is now, dark = where it was in the reference season. A pair like this is the signature of motion (or a change in brightness).',
    coaddInfo: (k: number) => `Median of ${k} frames from one detector and season: the noise drops roughly with √${k} ≈ ${Math.sqrt(k).toFixed(1)}.`,
    goggles: 'Molecule map (computed)',
    gogglesWhy: 'Bright where light is missing in the molecule\'s absorption band compared with its neighbours. It is a ratio of frames, so noisy where the sky is faint.',
    raw: 'Raw time order: every frame in the order it was taken, so both the colour and the sky change between frames.',
  },
  es: {
    lam: (l: number) => `${l.toFixed(2)} µm`,
    source: 'Una fuente clara en el objetivo',
    sourceWhy: (s: string) => `El objetivo está ${s} veces por encima del ruido de fondo: lo que ves ahí es luz real.`,
    faint: 'Una fuente débil, casi al nivel del ruido',
    faintWhy: (s: string) => `El objetivo apenas llega a ${s} veces el ruido: probablemente hay algo, pero un solo cuadro casi no lo muestra.`,
    noise: 'Casi todo es ruido',
    noiseWhy: (l: string) => `A ${l} el objetivo es demasiado débil para destacar sobre el "granulado" en una exposición corta. Ese granulado es ruido del detector y de los fotones, más el brillo del polvo zodiacal.`,
    noiseTipFrame: 'Prueba "Co-add": combinar muchos cuadros baja el ruido y puede revelar objetos débiles.',
    noiseTipCoadd: (k: number) => `Aun combinando ${k} cuadros nada destaca claramente sobre el ruido en esta longitud de onda; prueba otro detector o temporada.`,
    flicker: 'Cada cuadro de SPHEREx ve el cielo en un color distinto, por eso el brillo cambia de un cuadro a otro aunque nada se mueva.',
    saturated: 'Estrella saturada: el centro no es estructura real',
    saturatedWhy: 'Esta estrella es demasiado brillante para SPHEREx: el detector se llena, así que el núcleo sale recortado, plano o en blanco y puede derramarse en anillos y rayas. Su brillo y posición aquí no son confiables.',
    artifact: 'Posible artefacto en el objetivo',
    artifactWhy: (f: string) => `El pipeline marca este punto (${f}): fantasmas, rayas, impactos de rayos cósmicos o carga residual pueden parecer fuentes sin serlo.`,
    bad: (f: string) => `Algunos píxeles del objetivo están marcados como inservibles (${f}).`,
    partial: 'En parte fuera del detector',
    partialWhy: (p: string) => `Solo el ${p}% de esta vista tiene datos; las zonas vacías caen fuera del borde del detector o fueron enmascaradas.`,
    empty: 'Aquí no hay datos',
    emptyWhy: 'Este cuadro no cubre el objetivo. Elige otro cuadro en la línea de tiempo.',
    diffStatic: 'Diferencia: no cambió nada evidente',
    diffStaticWhy: 'Las estrellas que no se mueven se cancelan (gris). Lo que queda es ruido y pequeñas diferencias de calibración entre temporadas.',
    diffMoving: 'Diferencia: un par oscuro/brillante en el objetivo',
    diffMovingWhy: 'Brillante = donde está la luz ahora; oscuro = donde estaba en la temporada de referencia. Un par así es la firma del movimiento (o de un cambio de brillo).',
    coaddInfo: (k: number) => `Mediana de ${k} cuadros de un detector y temporada: el ruido baja aproximadamente como √${k} ≈ ${Math.sqrt(k).toFixed(1)}.`,
    goggles: 'Mapa de molécula (calculado)',
    gogglesWhy: 'Brilla donde falta luz en la banda de absorción de la molécula comparada con sus vecinas. Es un cociente de cuadros, así que se ve ruidoso donde el cielo es débil.',
    raw: 'Orden de tiempo crudo: todos los cuadros en el orden en que se tomaron, así que cambian tanto el color como el cielo.',
  },
};

export function readImage(inp: ReadingInput): Reading | null {
  const { mode, image, n, at, current, nFrames, locale } = inp;
  const L = T[locale] ?? T.en;
  if (mode === 'cube') return null;
  const flags = current.center_flags ?? [];
  const art = flags.filter((f) => ARTIFACT.has(f));
  const bad = flags.filter((f) => BAD.has(f));
  const sat = current.saturated_at_center || flags.some((f) => SAT.has(f));
  const single = mode === 'frame' || mode === 'raw';

  if (!image) return { kind: 'empty', title: L.empty, lines: [L.emptyWhy], snr: null };
  const st = imageStats(image, n, at);
  const snr = Number.isFinite(st.snr) ? st.snr : null;
  const s1 = (v: number) => v.toFixed(v < 10 ? 1 : 0);

  if (mode === 'goggles') return { kind: 'info', title: L.goggles, lines: [L.gogglesWhy], snr: null };

  if (mode === 'diff') {
    const moving = snr !== null && st.snr >= 5 && Number.isFinite(st.neg) && st.neg >= 5;
    return moving
      ? { kind: 'diff-moving', title: L.diffMoving, lines: [L.diffMovingWhy], snr }
      : { kind: 'diff-static', title: L.diffStatic, lines: [L.diffStaticWhy], snr };
  }

  if (single && sat) return { kind: 'saturated', title: L.saturated, lines: [L.saturatedWhy], snr };
  if (st.valid < 0.02) return { kind: 'empty', title: L.empty, lines: [L.emptyWhy], snr: null };

  const lines: string[] = [];
  let kind: ReadingKind, title: string;
  if (single && art.length) {
    kind = 'artifact'; title = L.artifact; lines.push(L.artifactWhy(art.join(', ')));
  } else if (snr !== null && snr >= 8) {
    kind = 'source'; title = L.source; lines.push(L.sourceWhy(s1(snr)));
  } else if (snr !== null && snr >= 4) {
    kind = 'faint'; title = L.faint; lines.push(L.faintWhy(s1(snr)));
  } else {
    kind = 'noise'; title = L.noise;
    lines.push(L.noiseWhy(L.lam(current.lambda_um)));
    lines.push(mode === 'coadd' ? L.noiseTipCoadd(nFrames) : L.noiseTipFrame);
  }
  if (single && bad.length) lines.push(L.bad(bad.join(', ')));
  if (st.valid < 0.8) {
    if (kind === 'source' || kind === 'faint') lines.push(L.partialWhy(String(Math.round(st.valid * 100))));
    else if (kind !== 'noise') { kind = 'partial'; title = L.partial; lines.unshift(L.partialWhy(String(Math.round(st.valid * 100)))); }
    else lines.push(L.partialWhy(String(Math.round(st.valid * 100))));
  }
  if (mode === 'coadd' && kind !== 'noise') lines.push(L.coaddInfo(nFrames));
  if (mode === 'raw') lines.push(L.raw);
  else if (single && lines.length < 3) lines.push(L.flicker);
  return { kind, title, lines: lines.slice(0, 3), snr };
}
