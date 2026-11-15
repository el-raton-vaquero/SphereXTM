'use client';

/**
 * <SymphonyDock /> — a compact star-symphony player any page can mount (/sky, /explore, ...).
 *
 *   <SymphonyDock
 *     getSpectrum={() => ({ lambda_um, intensity, label: 'Betelgeuse, 1326', provenance: 'computed' })}
 *     refreshKey={selectedStarId}      // change it whenever getSpectrum() would return something new
 *   />
 *
 * getSpectrum() is read on play and whenever refreshKey changes; the music glides to the new
 * spectrum without restarting. Return null for silence (the pad keeps breathing). The integrity
 * label follows `provenance`: 'spherex' = real SPHEREx measurements, 'computed' = modelled.
 * For computed star colours, lib/symphony/core#planckBands(teffK) gives a blackbody spectrum.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, withLang } from '../../lib/i18n';
import { analyseSpectrum, binToBands } from '../../lib/symphony/core';
import type { SymphonySpectrum } from '../../lib/symphony/engine';
import SpectralKeyboard from './SpectralKeyboard';
import Transport from './Transport';
import { featureSummary } from './TimbreList';
import { useSymphony } from './useSymphony';
import './symphony.css';

export interface SymphonyDockProps {
  getSpectrum: () => SymphonySpectrum | null;
  /** Any value; when it changes the dock re-reads getSpectrum(). */
  refreshKey?: unknown;
  /** Show the link to the full /symphony page (default true). */
  showLink?: boolean;
  className?: string;
}

export default function SymphonyDock({ getSpectrum, refreshKey, showLink = true, className }: SymphonyDockProps) {
  const { locale, t } = useLocale();
  const ts = t.symphony;
  const s = useSymphony();
  const { setSpectrum } = s;
  const getRef = useRef(getSpectrum);
  const [spec, setSpec] = useState<SymphonySpectrum | null>(null);

  useEffect(() => {
    getRef.current = getSpectrum;
  });

  useEffect(() => {
    const next = getRef.current();
    setSpectrum(next);
    setSpec(next);
  }, [refreshKey, setSpectrum]);

  const analysis = useMemo(() => (spec ? analyseSpectrum(binToBands(spec.lambda_um, spec.intensity)) : null), [spec]);
  const filled = analysis?.valid ?? 0;

  return (
    <section className={`sym-dock${className ? ` ${className}` : ''}`} aria-label={ts.dockAria}>
      <div className="sym-dock-head">
        <span className="sym-dock-title p-display">{ts.dockTitle}</span>
        <span className="sym-dock-label">{spec ? spec.label : ts.dockEmpty}</span>
        {spec && (
          <span className={`sym-tag${spec.provenance === 'computed' ? ' is-computed' : ''}`}>
            {spec.provenance === 'computed' ? ts.integrityComputed : ts.integritySpherex}
          </span>
        )}
      </div>
      <SpectralKeyboard
        bands={analysis?.norm ?? null}
        getEngine={s.getEngine}
        playing={s.playing}
        compact
        ariaLabel={ts.keyboardAria(filled)}
      />
      <div className="sym-dock-foot">
        <Transport s={s} compact />
        <span className="sym-dock-feat" aria-live="polite">{s.playing ? featureSummary(analysis, ts) : ''}</span>
        {showLink && <a className="sym-dock-link" href={withLang('/symphony', locale)}>{ts.dockOpen}</a>}
      </div>
    </section>
  );
}

export type { SymphonySpectrum } from '../../lib/symphony/engine';
