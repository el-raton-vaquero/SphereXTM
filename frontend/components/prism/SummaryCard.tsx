'use client';

import type { ReactNode } from 'react';
import { pickLocalized, useLocale } from '../../lib/i18n';
import { formatDec, formatRa } from '../../lib/prism/coords';
import type { VerdictResponse } from '../../lib/prism/types';
import { fill, num } from './fill';
import Term from './Term';

export interface Hero { meas: number; err: number; pred: number; ok: boolean; det: number; sA: number; sB: number }

interface Props {
  name: string;
  kind?: string;
  blurb?: string;
  ra?: number;
  dec?: number;
  category?: string;
  hero: Hero | null;
  satCount: number;
  nFrames: number;
  verdict: VerdictResponse | null;
  verdictStatus: 'idle' | 'loading' | 'ready' | 'error';
  originLabel: string;
  originKind: 'live' | 'snapshot' | null;
  /** "Query live" button, shown for snapshots when the science server is configured. */
  liveAction?: ReactNode;
  notices?: ReactNode;
  loading: boolean;
  /** No frames to show (failure or no coverage). */
  unavailable?: boolean;
}

const VERDICT_TONE: Record<string, string> = {
  known_star: 'ok', known_asteroid: 'ok', variable: 'warn', inconclusive: 'warn', artifact: 'bad', candidate: 'signal',
};

/** The plain-language "What you're seeing" card: who, what kind, the one-sentence result, verdict. */
export default function SummaryCard(p: Props) {
  const { locale, t } = useLocale();
  const text = t.explore;
  const saturated = p.nFrames > 0 && p.satCount / p.nFrames >= 0.3;

  let result: ReactNode;
  let how: ReactNode = null;
  if (p.loading) result = text.resultLoading;
  else if (p.unavailable) result = text.resultUnavailable;
  else if (p.hero) {
    const m = <span className={`xp-num${p.hero.ok ? ' xp-num-signal' : ''}`}>{num(p.hero.meas, locale)}″ ± {num(p.hero.err, locale)}″</span>;
    const pr = <span className="xp-num">{num(p.hero.pred, locale)}″</span>;
    result = fill(p.hero.ok ? text.resultMovedOk : text.resultMovedOff, { m, p: pr });
    how = fill(text.resultMovedHow, { det: p.hero.det, a: p.hero.sA, b: p.hero.sB });
  } else if (saturated) result = fill(text.resultSaturated, { k: p.satCount, n: p.nFrames });
  else if (p.category === 'reference_field') result = text.resultControl;
  else if (p.verdict) {
    const s = pickLocalized(p.verdict, 'summary', locale);
    result = s.text ? <span lang={s.lang}>{s.text}</span> : text.resultGeneric;
  } else result = text.resultGeneric;

  const tone = p.verdict ? VERDICT_TONE[p.verdict.verdict] ?? 'warn' : 'none';
  const verdictWord = p.verdict
    ? `${text.verdicts[p.verdict.verdict] ?? p.verdict.verdict}${p.verdict.tentative ? ` (${text.tentative})` : ''}`
    : p.verdictStatus === 'loading' || p.loading ? text.verdictChecking : text.verdictNone;

  return (
    <section className="xp-card" aria-labelledby="xp-what">
      <p className="xp-eyebrow" id="xp-what">{text.whatTitle}</p>
      <h1 className="xp-name p-display">{p.name}</h1>
      <p className="xp-kind">
        {p.kind && <span>{p.kind}</span>}
        {p.ra !== undefined && p.dec !== undefined && <span className="p-data xp-coords">{formatRa(p.ra, 1)} {formatDec(p.dec, 0)}</span>}
      </p>
      {p.blurb && <p className="xp-blurb">{p.blurb}</p>}
      <p className="xp-result" aria-live="polite">{result}</p>
      {how && <p className="xp-how">{how}</p>}
      {p.hero && saturated && <p className="xp-how">{fill(text.resultSaturated, { k: p.satCount, n: p.nFrames })}</p>}
      <div className="xp-verdict">
        <Term id="verdict"><span className="xp-verdict-l">{text.verdictLabel}</span></Term>
        <span className={`xp-badge xp-badge-${tone}`} role="status">{verdictWord}</span>
      </div>
      {p.notices}
      {p.originKind && (
        <p className="xp-origin">
          <i className={`xp-dot xp-dot-${p.originKind}`} aria-hidden />
          <span>{p.originLabel}</span>
          {p.liveAction}
        </p>
      )}
    </section>
  );
}
