'use client';

import { useLocale } from '../../lib/i18n';
import { KEYS, type Analysis } from '../../lib/symphony/core';

/** Which spectral properties drive the sound right now: key (spectral colour) and feature voices. */
export default function TimbreList({ analysis }: { analysis: Analysis | null }) {
  const { t } = useLocale();
  const ts = t.symphony;
  if (!analysis) return null;
  const key = KEYS[analysis.colour];
  // CH4 absorption and PAH emission share a window: show whichever applies.
  const ch4 = analysis.features.find((f) => f.id === 'ch4');
  const pah = analysis.features.find((f) => f.id === 'pah');
  const rows = analysis.features.filter((f) => (f.id === 'pah' ? pah?.detected : f.id === 'ch4' ? !pah?.detected || ch4?.detected : true));
  return (
    <div className="sym-timbre">
      <div className="sym-timbre-key">
        <span className="p-label">{ts.keyLabel}</span>
        <span className="sym-timbre-keyline">
          {ts.keyLine(ts.colourNames[analysis.colour], key.name, ts.scaleNames[key.scale])}
        </span>
        <span className="sym-help">{ts.colourHelp}</span>
      </div>
      <ul className="sym-features">
        {rows.map((f) => {
          const meta = ts.features[f.id];
          const measurable = Number.isFinite(f.depth);
          return (
            <li key={f.id} className={f.detected ? 'is-on' : measurable ? '' : 'is-na'}>
              <span className="sym-feat-dot" aria-hidden="true" />
              <span className="sym-feat-name">{meta.name}</span>
              <span className="sym-feat-where p-data">{meta.where}</span>
              <span className="sym-feat-state">
                {f.detected ? meta.voice : measurable ? ts.featureNone : ts.featureNA}
              </span>
              {f.detected && (
                <span className="sym-feat-depth p-data">
                  {f.depth < 0 ? ts.featureExcess(Math.round(-f.depth * 100)) : ts.featureDepth(Math.round(f.depth * 100))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="sym-help">{ts.featuresNote}</p>
    </div>
  );
}

/** Short sentence for screen readers / one-line summaries. */
export function featureSummary(analysis: Analysis | null, ts: { features: Record<string, { name: string; voice: string }>; featureDetected: (n: string, v: string) => string; announceFeatures: (l: string) => string; announceNoFeatures: string }): string {
  if (!analysis) return '';
  const on = analysis.features.filter((f) => f.detected);
  if (!on.length) return ts.announceNoFeatures;
  return ts.announceFeatures(on.map((f) => ts.featureDetected(ts.features[f.id].name, ts.features[f.id].voice)).join('; '));
}
