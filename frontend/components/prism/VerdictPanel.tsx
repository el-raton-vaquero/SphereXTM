'use client';

import type { PrismText } from '../../lib/prism/i18n';
import type { VerdictResponse } from '../../lib/prism/types';

interface Props {
  data: VerdictResponse | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  sourceLabel: string;
  text: PrismText;
}

const STEP_MS = 140;

export default function VerdictPanel({ data, status, error, sourceLabel, text }: Props) {
  const key = data ? data.checks.map((c) => c.id + c.status).join('|') + data.verdict : 'none';
  return (
    <section className="panel" aria-labelledby="verdict-h">
      <header className="panel-h">
        <h2 id="verdict-h" className="p-display">{text.verdict}</h2>
        <span className="p-data panel-sub">{sourceLabel}</span>
      </header>
      {status === 'loading' && <p className="panel-note p-data">…</p>}
      {status === 'error' && <p className="panel-note spec-error p-data">{error ?? text.verdictNa}</p>}
      {status === 'ready' && !data && <p className="panel-note">{text.verdictNa}</p>}
      {data && (
        <div key={key}>
          <ol className="checks">
            {data.checks.map((c, i) => (
              <li key={c.id} className={`check check-${c.status}`} style={{ animationDelay: `${i * STEP_MS}ms` }}>
                <span className="check-status p-data">{text.status[c.status]}</span>
                <span className="check-body">
                  <span className="check-label">{c.label}</span>
                  <span className="check-detail p-data">{c.detail}</span>
                  <span className="check-src p-data">{text.evidence}: {c.evidence_source}</span>
                </span>
              </li>
            ))}
          </ol>
          <div className={`verdict verdict-${data.verdict}`} style={{ animationDelay: `${data.checks.length * STEP_MS + 80}ms` }}>
            <span className="verdict-name p-display">{text.verdicts[data.verdict] ?? data.verdict}</span>
            <span className="verdict-conf p-data">
              {text.confidence} {(data.confidence * 100).toFixed(0)}%
              <span className="verdict-bar"><i style={{ width: `${Math.round(data.confidence * 100)}%` }} /></span>
            </span>
          </div>
          <p className="panel-note">{data.summary}{data.method ? ` (${data.method})` : ''}</p>
        </div>
      )}
    </section>
  );
}
