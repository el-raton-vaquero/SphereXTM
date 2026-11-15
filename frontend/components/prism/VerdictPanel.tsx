'use client';

import { useEffect, useState } from 'react';
import type { PrismText } from '../../lib/prism/i18n';
import type { VerdictResponse } from '../../lib/prism/types';

interface Props {
  data: VerdictResponse | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  sourceLabel: string;
  lang: 'es' | 'en';
  text: PrismText;
}

const STEP_MS = 140;
// Shown greyed while /v2/verdict runs, so the panel states its method before the answer.
const PENDING = ['saturation', 'artifacts', 'detection', 'gaia', 'skybot', 'motion', 'variability', 'spectrum'];

function Elapsed({ text }: { text: PrismText }) {
  const [s, setS] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setS(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <>
      <p className="panel-note p-data verdict-wait" role="status">{text.verdictLoading(s)}</p>
      <span className="meter" aria-hidden><i style={{ width: `${Math.min(100, (s / 45) * 100)}%` }} /></span>
    </>
  );
}

export default function VerdictPanel({ data, status, error, sourceLabel, lang, text }: Props) {
  const key = data ? data.checks.map((c) => c.id + c.status).join('|') + data.verdict : 'none';
  const summary = data ? (lang === 'es' && data.summary_es ? data.summary_es : data.summary) : '';
  return (
    <section className="panel" aria-labelledby="verdict-h">
      <header className="panel-h">
        <h2 id="verdict-h" className="p-display">{text.verdict}</h2>
        <span className="p-data panel-sub">{sourceLabel}</span>
      </header>
      {status === 'loading' && (
        <div>
          <Elapsed text={text} />
          <ol className="checks checks-pending">
            {PENDING.map((id) => (
              <li key={id} className="check check-pending">
                <span className="check-status p-data">{text.pending}</span>
                <span className="check-body"><span className="check-label">{text.checkLabels[id] ?? id}</span></span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {status === 'error' && <p className="panel-note spec-error p-data">{error ?? text.verdictNa}</p>}
      {status === 'ready' && !data && <p className="panel-note">{text.verdictNa}</p>}
      {data && (
        <div key={key}>
          <ol className="checks">
            {data.checks.map((c, i) => (
              <li key={c.id} className={`check check-${c.status}`} style={{ animationDelay: `${i * STEP_MS}ms` }}>
                <span className="check-status p-data">{text.status[c.status]}</span>
                <span className="check-body">
                  <span className="check-label">{text.checkLabels[c.id] ?? c.label}</span>
                  <span className="check-detail p-data" lang="en">{c.detail}</span>
                  <span className="check-src p-data">{text.evidence}: {c.evidence_source}</span>
                </span>
              </li>
            ))}
          </ol>
          {text.detailNote && <p className="panel-note p-data">{text.detailNote}</p>}
          <div className={`verdict verdict-${data.verdict}`} style={{ animationDelay: `${data.checks.length * STEP_MS + 80}ms` }}>
            <span className="verdict-name p-display">
              {text.verdicts[data.verdict] ?? data.verdict}
              {data.tentative ? <span className="verdict-tent p-data"> ({text.tentative})</span> : null}
            </span>
            <span className="verdict-conf p-data">
              {text.confidence} {(data.confidence * 100).toFixed(0)}%
              <span className="verdict-bar"><i style={{ width: `${Math.round(data.confidence * 100)}%` }} /></span>
            </span>
          </div>
          <p className="panel-note">{summary}{data.method ? ` (${data.method})` : ''}</p>
        </div>
      )}
    </section>
  );
}
