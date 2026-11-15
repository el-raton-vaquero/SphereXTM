'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useLocale } from '../../lib/i18n';

type Messages = ReturnType<typeof useLocale>['t'];

/** Tab title for a route, from the i18n layer (the static metadata is English only). */
function titleFor(path: string, t: Messages): string {
  if (path === '/' || path === '') return t.cosmos.metaTitle;
  if (path.startsWith('/explore')) return t.explore.metaTitle;
  if (path.startsWith('/sky')) return t.sky.metaTitle;
  if (path.startsWith('/symphony')) return t.symphony.metaTitle;
  if (path.startsWith('/look')) return t.look.metaTitle;
  return t.common.metaTitle;
}

/**
 * Keeps <html lang> and the tab title in sync with the active locale (the server renders
 * lang="en" and English metadata).
 */
export default function HtmlLang() {
  const { locale, t } = useLocale();
  const pathname = usePathname() || '/';
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    const want = titleFor(pathname, t);
    const apply = () => {
      if (document.title !== want) document.title = want;
    };
    apply();
    // Next may write the route's static (English) title after this effect; put ours back.
    const obs = new MutationObserver(apply);
    obs.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => obs.disconnect();
  }, [pathname, t]);
  return null;
}
