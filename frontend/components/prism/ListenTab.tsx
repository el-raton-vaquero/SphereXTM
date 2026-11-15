'use client';

import { useLocale, withLang } from '../../lib/i18n';
import { useProbeSpectrum } from '../../lib/prism/probeSpectrum';

/**
 * "Listen" tab of the explorer's Details drawer.
 *
 * INTEGRATION: the star-symphony agent's <SymphonyDock> mounts in the element marked
 * `data-symphony-slot` below (replace the placeholder <p> with `<SymphonyDock />`, or portal into
 * `document.querySelector('[data-symphony-slot]')`). The dock reads the probe spectrum through
 * `useProbeSpectrum()` / `getProbeSpectrum()` from lib/prism/probeSpectrum, which this page keeps
 * up to date as the visitor moves the probe or changes target.
 */
export default function ListenTab() {
  const { locale, t } = useLocale();
  const text = t.explore;
  const spec = useProbeSpectrum();
  return (
    <div className="xp-listen">
      <h3 className="xp-h3">{text.listenTitle}</h3>
      <p className="xp-tag">{t.common.artisticMapping}</p>
      <p className="xp-body">{text.listenBody}</p>
      {spec && (
        <p className="xp-small p-data">{spec.label} · {spec.lambda_um.length} {text.frames}</p>
      )}
      <div data-symphony-slot className="xp-slot">
        <p className="xp-small">{text.listenSlot}</p>
      </div>
      <a className="xp-link" href={withLang('/symphony', locale)}>{text.listenOpen}</a>
    </div>
  );
}
