/**
 * Listar i18n: one shared module for every route.
 *
 *   const { locale, t, setLocale, toggleLocale } = useLocale();
 *   <h1>{t.sky.title}</h1>
 *
 * Locale resolution (client): URL ?lang=en|es  >  localStorage 'starchord.lang'  >  'en'.
 * The server always renders English; the client switches after hydration if needed
 * (useSyncExternalStore handles the hand-over without hydration mismatches).
 * setLocale() persists the choice in localStorage and in the URL (?lang=es; English is the
 * default and leaves the URL clean), updates <html lang> and notifies every subscriber.
 *
 * Server components (metadata) import `en` directly: English is the default locale.
 */
import { useSyncExternalStore } from 'react';
import { en, type Messages } from './en';
import { es } from './es';

export type Locale = 'en' | 'es';
export type { Messages };
/** Dictionary slice of one namespace, e.g. `ExploreText` for components that take `text` props. */
export type ExploreText = Messages['explore'];
export const LOCALES: Locale[] = ['en', 'es'];
export const DEFAULT_LOCALE: Locale = 'en';
export const MESSAGES: Record<Locale, Messages> = { en, es };
export { en, es };

const STORAGE_KEY = 'starchord.lang';
const EVENT = 'starchord-locale';

export function isLocale(v: unknown): v is Locale {
  return v === 'en' || v === 'es';
}

/** Current locale on the client (URL, then stored choice, then English). */
export function readLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  const fromUrl = new URLSearchParams(window.location.search).get('lang');
  if (isLocale(fromUrl)) return fromUrl;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    /* storage blocked (private mode, sandboxed iframe): fall back to the default */
  }
  return DEFAULT_LOCALE;
}

/** Persist and broadcast a locale choice. */
export function setLocale(locale: Locale): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* storage blocked: the URL still carries the choice */
  }
  const url = new URL(window.location.href);
  if (locale === DEFAULT_LOCALE) url.searchParams.delete('lang');
  else url.searchParams.set('lang', locale);
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
  document.documentElement.lang = locale;
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(fn: () => void) {
  window.addEventListener(EVENT, fn);
  window.addEventListener('popstate', fn);
  window.addEventListener('storage', fn);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener('popstate', fn);
    window.removeEventListener('storage', fn);
  };
}

/** Append ?lang= to an internal href when the locale is not the default. */
export function withLang(href: string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) return href;
  const [path, hash = ''] = href.split('#');
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}lang=${locale}${hash ? `#${hash}` : ''}`;
}

/** React hook: the active locale, its dictionary and setters. Use only in client components. */
export function useLocale() {
  const locale = useSyncExternalStore(subscribe, readLocale, () => DEFAULT_LOCALE);
  return {
    locale,
    t: MESSAGES[locale],
    setLocale,
    toggleLocale: () => setLocale(locale === 'en' ? 'es' : 'en'),
  };
}

/**
 * Pick a localized field from backend/snapshot data: `obj[field + '_es']` when the locale is
 * Spanish and that field exists, otherwise `obj[field]`. Returns the language actually used so
 * the UI can mark untranslated text with lang="en".
 */
export function pickLocalized<T extends object>(obj: T | null | undefined, field: string, locale: Locale): { text: string; lang: Locale } {
  const rec = (obj ?? {}) as Record<string, unknown>;
  if (locale !== 'en') {
    const v = rec[`${field}_${locale}`];
    if (typeof v === 'string' && v) return { text: v, lang: locale };
  }
  const base = rec[`${field}_en`] ?? rec[field];
  return { text: typeof base === 'string' ? base : '', lang: 'en' };
}
