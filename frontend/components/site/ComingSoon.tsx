'use client';

import { useLocale, withLang } from '../../lib/i18n';
import SiteHeader from './SiteHeader';

type Section = 'sky' | 'symphony' | 'look';

/** Placeholder shell for a route whose feature is still being built. */
export default function ComingSoon({ section }: { section: Section }) {
  const { locale, t } = useLocale();
  const s = t[section];
  return (
    <div className="site-page">
      <SiteHeader current={section} />
      <main className="site-main" id="main">
        <h1 className="site-h1 p-display">{s.title}</h1>
        <p className="site-lead">{s.lede}</p>
        <p className="site-note">{t.common.comingSoon} {t.common.comingSoonBody}</p>
        <p><a className="site-btn" href={withLang('/explore', locale)}>{t.common.openExplorer}</a></p>
      </main>
      <footer className="site-footer p-data">{t.common.credit}</footer>
    </div>
  );
}
