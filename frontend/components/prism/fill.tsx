import { Fragment, type ReactNode } from 'react';

/**
 * Fill a dictionary sentence such as 'Moved {m} between seasons' with React nodes, so numbers
 * can be styled while word order stays in the translation.
 */
export function fill(template: string, values: Record<string, ReactNode>): ReactNode {
  const parts = template.split(/\{(\w+)\}/);
  return parts.map((p, i) => (i % 2 ? <Fragment key={i}>{values[p] ?? `{${p}}`}</Fragment> : <Fragment key={i}>{p}</Fragment>));
}

/** Locale-aware number for running text (1 decimal by default). Data panels keep fixed notation. */
export function num(v: number, locale: string, digits = 1): string {
  return v.toLocaleString(locale === 'es' ? 'es' : 'en', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
