import { Fragment, type ReactNode } from 'react';

/**
 * Uppercased labels (`text-transform: uppercase`) turn α→Α, δ→Δ, λ→Λ, which read as Latin
 * letters or lose their meaning. Wrap Greek runs in a span that keeps their case.
 */
export function keepGreek(s: string): ReactNode {
  const parts = s.split(/([\u0370-\u03ff]+)/);
  if (parts.length === 1) return s;
  return parts.map((p, i) => (i % 2 ? <span key={i} style={{ textTransform: 'none' }}>{p}</span> : <Fragment key={i}>{p}</Fragment>));
}
