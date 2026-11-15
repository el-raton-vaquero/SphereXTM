'use client';

import { useLocale } from '../../lib/i18n';
import type { V2Target } from '../../lib/prism/types';

/** Empty/failure state: the six presets with friendly blurbs, each opening a saved real snapshot. */
export default function PresetSuggestions({ targets, onPick }: { targets: V2Target[]; onPick: (t: V2Target) => void }) {
  const { t } = useLocale();
  return (
    <div className="xp-suggest">
      <h2 className="xp-h3">{t.explore.suggestTitle}</h2>
      <p className="xp-small">{t.explore.suggestBody}</p>
      <ul>
        {targets.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => onPick(p)}>
              <span className="xp-suggest-name p-display">{t.targets[p.id]?.name ?? p.name}</span>
              <span className="xp-suggest-kind">{t.targets[p.id]?.kind ?? t.explore.categories[p.category] ?? p.category}</span>
              <span className="xp-suggest-blurb">{t.targets[p.id]?.blurb ?? ''}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
