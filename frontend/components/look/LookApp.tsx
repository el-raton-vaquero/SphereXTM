'use client';

import { useState } from 'react';
import { useLocale } from '../../lib/i18n';
import { useMounted, usePlace, useStarField } from '../../lib/look/hooks';
import SiteHeader from '../site/SiteHeader';
import AboveMe from './AboveMe';
import CameraView from './CameraView';

type Tab = 'camera' | 'above';

function initialTab(): Tab {
  if (typeof window === 'undefined') return 'above';
  const q = new URLSearchParams(window.location.search).get('mode');
  if (q === 'camera' || q === 'above') return q;
  return window.matchMedia?.('(pointer: coarse)').matches ? 'camera' : 'above';
}

/** /look: phone camera sky view ("Camera") and the desktop "Above me" panel. */
export default function LookApp() {
  const { t } = useLocale();
  const L = t.look;
  const mounted = useMounted();
  return (
    <div className="site-page look-root">
      <SiteHeader current="look" />
      <main className="look-main" id="main">
        <div className="look-head">
          <h1 className="site-h1 p-display">{L.title}</h1>
          <p className="site-lead">{L.lede}</p>
        </div>
        {mounted ? <LookBody /> : <div className="look-placeholder" aria-hidden="true" />}
      </main>
      <footer className="site-footer p-data">{t.common.credit}</footer>
    </div>
  );
}

function LookBody() {
  const { t } = useLocale();
  const L = t.look;
  const [tab, setTab] = useState<Tab>(initialTab);
  const { place, geo, set, locate, setCity } = usePlace();
  const field = useStarField(5.5);

  const choose = (next: Tab) => {
    setTab(next);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('mode', next);
      window.history.replaceState(window.history.state, '', u);
    } catch { /* ignore */ }
  };

  return (
    <>
      <div className="look-tabs" role="tablist" aria-label={L.tabsLabel}>
        {(['camera', 'above'] as const).map((k) => (
          <button key={k} type="button" role="tab" id={`look-tab-${k}`} aria-controls={`look-panel-${k}`} aria-selected={tab === k}
            className="look-tab" onClick={() => choose(k)}>
            {k === 'camera' ? L.tabCamera : L.tabAbove}
          </button>
        ))}
      </div>
      <div id="look-panel-camera" role="tabpanel" aria-labelledby="look-tab-camera" hidden={tab !== 'camera'}>
        <CameraView place={place} field={field} locate={locate} active={tab === 'camera'} />
      </div>
      <div id="look-panel-above" role="tabpanel" aria-labelledby="look-tab-above" hidden={tab !== 'above'}>
        {tab === 'above' && <AboveMe place={place} geo={geo} locate={locate} setPlace={set} setCity={setCity} field={field} />}
      </div>
    </>
  );
}
