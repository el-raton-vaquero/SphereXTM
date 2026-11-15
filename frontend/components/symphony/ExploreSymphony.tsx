'use client';

/**
 * Star symphony for /explore: plays the REAL SPHEREx spectrum under the explorer's probe
 * (lib/prism/probeSpectrum). Saturated points are dropped (their flux is unreliable); the dock
 * bins the remaining per-frame points into the 102 bands itself.
 */
import { useProbeSpectrum, getProbeSpectrum } from '../../lib/prism/probeSpectrum';
import SymphonyDock, { type SymphonySpectrum } from './SymphonyDock';

export default function ExploreSymphony() {
  const probe = useProbeSpectrum();

  const getSpectrum = (): SymphonySpectrum | null => {
    const p = getProbeSpectrum();
    if (!p || !p.lambda_um.length) return null;
    const lambda_um: number[] = [];
    const intensity: number[] = [];
    p.lambda_um.forEach((l, i) => {
      if (p.saturated[i]) return;
      const v = p.intensity[i];
      if (!Number.isFinite(v)) return;
      lambda_um.push(l);
      intensity.push(v);
    });
    if (!lambda_um.length) return null;
    return { lambda_um, intensity, label: p.label, provenance: 'spherex' };
  };

  return <SymphonyDock getSpectrum={getSpectrum} refreshKey={probe?.key ?? null} showLink={false} />;
}
