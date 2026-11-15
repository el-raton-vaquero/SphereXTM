'use client';

import { useEffect } from 'react';
import { useLocale } from '../../lib/i18n';

/** Keeps <html lang> in sync with the active locale (the server renders lang="en"). */
export default function HtmlLang() {
  const { locale } = useLocale();
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return null;
}
