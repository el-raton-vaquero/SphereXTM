'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { useLocale } from '../../lib/i18n';

export const DETAIL_TABS = ['spectrum', 'motion', 'quality', 'sources', 'listen'] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

/**
 * Progressive disclosure for everything advanced. A side panel at ≥1200 px (always open);
 * below that a collapsed drawer with a "Show details" toggle. ARIA tabs with arrow-key,
 * Home and End navigation; inactive panels stay mounted (hidden) so their state survives.
 */
export default function DetailsDrawer({ panels, initial = 'spectrum' }: { panels: Record<DetailTab, ReactNode>; initial?: DetailTab }) {
  const { t } = useLocale();
  const text = t.explore;
  const [tab, setTab] = useState<DetailTab>(initial);
  const [open, setOpen] = useState(false);
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: React.KeyboardEvent) => {
    const i = DETAIL_TABS.indexOf(tab);
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % DETAIL_TABS.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + DETAIL_TABS.length) % DETAIL_TABS.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = DETAIL_TABS.length - 1;
    if (j < 0) return;
    e.preventDefault();
    e.stopPropagation();
    setTab(DETAIL_TABS[j]);
    refs.current[j]?.focus();
  };

  return (
    <section className="xp-details" data-open={open} aria-labelledby={`${base}-h`} data-coach="details">
      <div className="xp-details-head">
        <h2 id={`${base}-h`} className="xp-details-t">{text.detailsTitle}</h2>
        <button type="button" className="xp-details-toggle" aria-expanded={open} aria-controls={`${base}-body`} onClick={() => setOpen((v) => !v)}>
          {open ? text.hideDetails : text.showDetails}
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d={open ? 'M1 7l4-4 4 4' : 'M1 3l4 4 4-4'} fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
        </button>
      </div>
      <div className="xp-details-body" id={`${base}-body`}>
        <div className="xp-tabs" role="tablist" aria-label={text.detailsTitle} onKeyDown={onKey}>
          {DETAIL_TABS.map((k, i) => (
            <button
              key={k}
              ref={(el) => { refs.current[i] = el; }}
              type="button"
              role="tab"
              id={`${base}-t-${k}`}
              aria-selected={tab === k}
              aria-controls={`${base}-p-${k}`}
              tabIndex={tab === k ? 0 : -1}
              className="xp-tab"
              onClick={() => setTab(k)}
            >
              {text.tabs[k]}
            </button>
          ))}
        </div>
        {DETAIL_TABS.map((k) => (
          <div key={k} role="tabpanel" id={`${base}-p-${k}`} aria-labelledby={`${base}-t-${k}`} hidden={tab !== k} className="xp-panel" tabIndex={0}>
            {panels[k]}
          </div>
        ))}
      </div>
    </section>
  );
}
