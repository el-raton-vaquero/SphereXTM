/**
 * Probe spectrum bridge: the /explore page publishes the spectrum under its probe (the
 * crosshair the visitor moves by clicking the sky image or with the arrow keys) and any other
 * client component (the star symphony dock) reads it, without prop drilling or a shared
 * React tree.
 *
 *   import { getProbeSpectrum, subscribeProbeSpectrum, useProbeSpectrum } from '../../lib/prism/probeSpectrum';
 *   const s = useProbeSpectrum();          // re-renders on every change (null until data loads)
 *   const now = getProbeSpectrum();        // one-off read, e.g. inside an audio callback
 *   const off = subscribeProbeSpectrum(() => retune(getProbeSpectrum()));
 *
 * Every value is REAL SPHEREx forced photometry: one point per frame at the probe position
 * (in-browser aperture sum on the reprojected cutouts, or the backend /v2/spectrum or the
 * snapshot's stored spectrum when available). Nothing is interpolated or invented; points the
 * detector saturated are kept but marked in `saturated` so a consumer can mute or soften them.
 */
import { useSyncExternalStore } from 'react';

export interface ProbeSpectrum {
  /** Wavelength of each point, µm, ascending (0.75–5.0). Several frames can share a band. */
  lambda_um: number[];
  /** Measured flux at the probe for each point (same order). May be ≤ 0 for faint/noisy spots. */
  intensity: number[];
  /** 1σ uncertainty of `intensity` (same unit). */
  err: number[];
  /** True where OVERFLOW/NONLINEAR/BLOOM touched the aperture: the value is unreliable. */
  saturated: boolean[];
  /** Unit of `intensity` and `err` (normally 'mJy'). */
  unit: string;
  /** Human label: target name (or "Custom position") plus the probe coordinates. */
  label: string;
  /** Always 'spherex': these are measurements of real SPHEREx frames. */
  provenance: 'spherex';
  /** Which pipeline produced the numbers. */
  source: 'live' | 'snapshot' | 'client';
  /** Probe position (ICRS degrees). */
  ra: number;
  dec: number;
  /** Changes whenever the probe moves or the data source changes (use it to detect updates). */
  key: string;
}

let current: ProbeSpectrum | null = null;
const listeners = new Set<() => void>();

/** Latest probe spectrum published by /explore, or null when none is loaded. */
export function getProbeSpectrum(): ProbeSpectrum | null {
  return current;
}

/** Called by the explorer only. Notifies subscribers when the key changes. */
export function publishProbeSpectrum(next: ProbeSpectrum | null): void {
  if (current === next || (current && next && current.key === next.key)) return;
  current = next;
  listeners.forEach((fn) => fn());
}

/** Subscribe to changes; returns the unsubscribe function. */
export function subscribeProbeSpectrum(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** React hook over the bridge (client components only). */
export function useProbeSpectrum(): ProbeSpectrum | null {
  return useSyncExternalStore(subscribeProbeSpectrum, getProbeSpectrum, () => null);
}
