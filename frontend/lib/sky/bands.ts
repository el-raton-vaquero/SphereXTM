/**
 * Visible-sky "bands" for the star symphony (frontend/lib/symphony).
 *
 * WHAT THIS IS: a colour-based approximation. For every catalogue star the /sky view currently
 * shows (above the horizon and inside the field of view) we take its V magnitude and B−V colour,
 * turn B−V into a temperature (Ballesteros 2012), and add a blackbody spectrum scaled to the
 * star's V-band flux. The sum is sampled on a SPHEREx-like grid of 102 wavelengths
 * (0.75–5.0 µm, 17 log-spaced channels in each of the 6 detector ranges).
 *
 * WHAT THIS IS NOT: SPHEREx data. Real SPHEREx spectra come only from snapshots or the backend.
 * Any UI that plays or plots these values must say "colour-based approximation, not SPHEREx data"
 * (i18n key t.sky.bandsLabel).
 *
 * API
 *   getVisibleSkyBands(): SkyBand[]            current snapshot (102 entries, intensity 0..1;
 *                                              empty array when no /sky view is mounted)
 *   getVisibleSkyInfo(): VisibleSkyInfo | null  star count, direction, time of the snapshot
 *   subscribeVisibleSky(cb): () => void         called (≤ 4 Hz) whenever the view changes
 */

export interface SkyBand {
  lambda_um: number;
  /** Relative intensity, normalised so the brightest band is 1. */
  intensity: number;
}

export interface VisibleSkyInfo {
  kind: 'colour-based-approximation';
  starCount: number;
  /** Sum of V-band fluxes relative to a V=0 star. */
  totalFluxV: number;
  /** Centre of the view, J2000 degrees. */
  ra: number;
  dec: number;
  fovDeg: number;
  timeMs: number;
}

/** SPHEREx detector ranges (µm) and the 102-channel centre grid used here. */
export const SPHEREX_DETECTOR_EDGES_UM = [0.75, 1.09, 1.62, 2.42, 3.82, 4.42, 5.0] as const;
export const SKY_BAND_CENTERS_UM: number[] = (() => {
  const out: number[] = [];
  for (let d = 0; d < 6; d++) {
    const a = Math.log(SPHEREX_DETECTOR_EDGES_UM[d]);
    const b = Math.log(SPHEREX_DETECTOR_EDGES_UM[d + 1]);
    for (let k = 0; k < 17; k++) out.push(Math.exp(a + ((k + 0.5) / 17) * (b - a)));
  }
  return out;
})();

/** B−V → effective temperature (K), Ballesteros (2012). */
export function bvToTemperature(bv: number): number {
  const b = Math.max(-0.4, Math.min(2.0, Number.isFinite(bv) ? bv : 0.6));
  return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}

const C2 = 14387.77; // hc/k in µm·K
/** Planck B_λ up to a constant (λ in µm). */
const planck = (lam: number, T: number) => 1 / (lam ** 5 * (Math.exp(C2 / (lam * T)) - 1));

/** Blackbody spectrum normalised to 1 at V (0.55 µm), sampled on SKY_BAND_CENTERS_UM. */
export function blackbodyBands(T: number, out: Float64Array = new Float64Array(SKY_BAND_CENTERS_UM.length)): Float64Array {
  const ref = planck(0.55, T);
  for (let k = 0; k < SKY_BAND_CENTERS_UM.length; k++) out[k] = planck(SKY_BAND_CENTERS_UM[k], T) / ref;
  return out;
}

/** Temperature-binned blackbody cache (50 K steps) so per-frame sums stay cheap. */
const cache = new Map<number, Float64Array>();
export function cachedBlackbody(T: number): Float64Array {
  const key = Math.round(T / 50) * 50;
  let v = cache.get(key);
  if (!v) {
    v = blackbodyBands(key);
    cache.set(key, v);
  }
  return v;
}

type Provider = () => { bands: SkyBand[]; info: VisibleSkyInfo } | null;
let provider: Provider | null = null;
let last: { bands: SkyBand[]; info: VisibleSkyInfo } | null = null;
const listeners = new Set<(bands: SkyBand[], info: VisibleSkyInfo) => void>();

/** Called by the /sky engine. Returns an unregister function. */
export function registerVisibleSkyProvider(p: Provider): () => void {
  provider = p;
  return () => {
    if (provider === p) {
      provider = null;
      last = null;
    }
  };
}

/** Called by the /sky engine when the view changed (throttled there). */
export function publishVisibleSky(bands: SkyBand[], info: VisibleSkyInfo): void {
  last = { bands, info };
  listeners.forEach((cb) => cb(bands, info));
}

export function hasVisibleSkyListeners(): boolean {
  return listeners.size > 0;
}

export function getVisibleSkyBands(): SkyBand[] {
  if (provider) last = provider() ?? last;
  return last ? last.bands : [];
}

export function getVisibleSkyInfo(): VisibleSkyInfo | null {
  if (!last && provider) last = provider();
  return last ? last.info : null;
}

export function subscribeVisibleSky(cb: (bands: SkyBand[], info: VisibleSkyInfo) => void): () => void {
  listeners.add(cb);
  if (last) cb(last.bands, last.info);
  return () => {
    listeners.delete(cb);
  };
}
