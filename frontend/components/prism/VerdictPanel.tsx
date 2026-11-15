'use client';

import { useEffect, useState } from 'react';
import { pickLocalized, type ExploreText, type Locale } from '../../lib/i18n';
import type { VerdictResponse } from '../../lib/prism/types';
import Term from './Term';

interface Props {
  data: VerdictResponse | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  sourceLabel: string;
  lang: Locale;
  text: ExploreText;
}

// Shown greyed while /v2/verdict runs, so the panel states its method before the answer.
const PENDING = ['saturation', 'artifacts', 'detection', 'gaia', 'skybot', 'motion', 'variability', 'spectrum'];

function Elapsed({ text }: { text: ExploreText }) {
  const [s, setS] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setS(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <>
      <p className="xp-small p-data" role="status">{text.verdictLoading(s)}</p>
      <span className="meter" aria-hidden><i style={{ width: `${Math.min(100, (s / 45) * 100)}%` }} /></span>
    </>
  );
}

/** Data quality tab: the backend's automated checks, one plain row each, then the verdict. */
export default function VerdictPanel({ data, status, error, sourceLabel, lang, text }: Props) {
  const summary = data ? pickLocalized(data, 'summary', lang) : { text: '', lang: 'en' as Locale };
  // Older cached verdicts carry English-only details; mark those so screen readers switch voice.
  const untranslated = lang !== 'en' && !!data && data.checks.some((c) => pickLocalized(c, 'detail', lang).lang !== lang);
  return (
    <section className="xp-sec" aria-labelledby="verdict-h">
      <h3 id="verdict-h" className="xp-h3"><Term id="verdict">{text.qualityChecks}</Term></h3>
      {status === 'loading' && (
        <div>
          <Elapsed text={text} />
          <ol className="checks checks-pending">
            {PENDING.map((id) => (
              <li key={id} className="check check-na">
                <span className="check-status">{text.pending}</span>
                <span className="check-body"><span className="check-label">{text.checkLabels[id] ?? id}</span></span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {status === 'error' && <p className="xp-small spec-error p-data">{error ?? text.verdictNa}</p>}
      {status === 'ready' && !data && <p className="xp-small">{text.verdictNa}</p>}
      {data && (
        <>
          <ol className="checks">
            {data.checks.map((c) => {
              const d = pickLocalized(c, 'detail', lang);
              const e = pickLocalized(c, 'evidence_source', lang);
              return (
                <li key={c.id} className={`check check-${c.status}`}>
                  <span className="check-status">{text.status[c.status]}</span>
                  <span className="check-body">
                    <span className="check-label">{text.checkLabels[c.id] ?? pickLocalized(c, 'label', lang).text}</span>
                    <span className="check-detail" lang={d.lang}>{d.text}</span>
                    <span className="check-src">{text.evidence}: <span lang={e.lang}>{e.text}</span></span>
                  </span>
                </li>
              );
            })}
          </ol>
          {untranslated && <p className="xp-small">{text.detailNote}</p>}
          <p className="xp-small">
            <span lang={summary.lang}>{summary.text}</span>{' '}
            <span className="p-data">{text.confidence} {(data.confidence * 100).toFixed(0)}%{sourceLabel ? ` · ${sourceLabel}` : ''}</span>
          </p>
        </>
      )}
    </section>
  );
}
