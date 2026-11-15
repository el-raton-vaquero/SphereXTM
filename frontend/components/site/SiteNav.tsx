'use client';

import { useLocale, withLang, type Locale } from '../../lib/i18n';

/** The StarChord routes, in navigation order. */
export const SITE_ROUTES = [
  { id: 'home', href: '/' },
  { id: 'explore', href: '/explore' },
  { id: 'sky', href: '/sky' },
  { id: 'symphony', href: '/symphony' },
  { id: 'look', href: '/look' },
  { id: 'song', href: '/song' },
  { id: 'match', href: '/match' },
] as const;

export type SiteRouteId = (typeof SITE_ROUTES)[number]['id'];

/** EN | ES switch. Persists the choice (localStorage + ?lang=) through the shared i18n module. */
export function LangToggle({ className }: { className?: string }) {
  const { locale, setLocale, t } = useLocale();
  const opts: Locale[] = ['en', 'es'];
  return (
    <div className={`site-lang${className ? ` ${className}` : ''}`} role="group" aria-label={t.common.langToggleLabel}>
      {opts.map((l) => (
        <button key={l} type="button" className="site-lang-b" lang={l} aria-pressed={locale === l} onClick={() => setLocale(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export interface SiteNavProps {
  /** The route this page is (gets aria-current). */
  current?: SiteRouteId;
  /** Show the EN | ES switch at the end of the nav (default true). */
  showLang?: boolean;
  className?: string;
}

/** Shared top-level navigation; every page header renders it next to <BrandMark />. */
export default function SiteNav({ current, showLang = true, className }: SiteNavProps) {
  const { locale, t } = useLocale();
  return (
    <nav className={`site-nav${className ? ` ${className}` : ''}`} aria-label={t.nav.label}>
      <ul>
        {SITE_ROUTES.map((r) => (
          <li key={r.id}>
            <a className="site-nav-a" href={withLang(r.href, locale)} aria-current={current === r.id ? 'page' : undefined}>
              {t.nav[r.id]}
            </a>
          </li>
        ))}
      </ul>
      {showLang && <LangToggle />}
    </nav>
  );
}
