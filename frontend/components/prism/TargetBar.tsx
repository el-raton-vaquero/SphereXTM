'use client';

import { useState } from 'react';
import { resolveTargetName } from '../../lib/sesame';
import { formatDec, formatRa, parseRaDec } from '../../lib/prism/coords';
import type { PrismText } from '../../lib/prism/i18n';
import type { V2Target } from '../../lib/prism/types';

interface Props {
  targets: V2Target[];
  activeId?: string;
  ra?: number;
  dec?: number;
  fov: number;
  locale: 'es' | 'en';
  text: PrismText;
  embedUrl: string;
  onPoint: (p: { ra: number; dec: number; target?: string; label?: string }) => void;
  onFov: (fov: number) => void;
}

const FOVS = [2, 4, 6, 10];

export default function TargetBar({ targets, activeId, ra, dec, fov, locale, text, embedUrl, onPoint, onFov }: Props) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [embedOpen, setEmbedOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const parsed = parseRaDec(q);
    if (parsed) { onPoint(parsed); return; }
    const preset = targets.find((t) => t.name.toLowerCase() === q.trim().toLowerCase() || t.id === q.trim().toLowerCase());
    if (preset) { onPoint({ ra: preset.ra, dec: preset.dec, target: preset.id }); return; }
    setBusy(true);
    try {
      const r = await resolveTargetName(q);
      if (r) {
        onPoint({ ra: r.ra, dec: r.dec, label: r.name });
        setMsg(`${r.name} → ${formatRa(r.ra, 1)} ${formatDec(r.dec, 0)} · ${r.source}`);
      } else setMsg(text.notResolved);
    } finally {
      setBusy(false);
    }
  };

  const snippet = `<iframe src="${embedUrl}" width="960" height="720" style="border:0" title="PRISM · SPHEREx"></iframe>`;

  return (
    <div className="tbar">
      <form className="tbar-form" onSubmit={submit} role="search">
        <label htmlFor="prism-q" className="p-label">{text.inputLabel}</label>
        <div className="tbar-row">
          <input
            id="prism-q"
            className="tbar-input p-data"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={text.inputPlaceholder}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !q.trim()}>{busy ? text.resolving : text.go}</button>
        </div>
        <div className="tbar-now p-data" aria-live="polite">
          {msg ?? (ra !== undefined && dec !== undefined ? `${formatRa(ra)}  ${formatDec(dec)}  ·  ICRS` : '')}
        </div>
      </form>
      <div className="tbar-presets">
        <span className="p-label">{text.presets}</span>
        <ul>
          {targets.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className="preset"
                aria-pressed={activeId === t.id}
                onClick={() => onPoint({ ra: t.ra, dec: t.dec, target: t.id })}
                title={(locale === 'en' && (t as { why_en?: string }).why_en) || t.why || ''}
              >
                <span className="preset-name">{t.name}</span>
                <span className="preset-cat p-data">{t.category.replace(/_/g, ' ')}{t.expected?.pm_arcsec_yr ? ` · ${t.expected.pm_arcsec_yr.toFixed(1)}″/yr` : ''}{t.expected?.saturated ? ' · SAT' : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="tbar-side">
        <label className="p-label" htmlFor="prism-fov">{text.fov}</label>
        <select id="prism-fov" className="select p-data" value={fov} onChange={(e) => onFov(Number(e.target.value))}>
          {(FOVS.includes(fov) ? FOVS : [...FOVS, fov].sort((a, b) => a - b)).map((f) => <option key={f} value={f}>{f}′ × {f}′</option>)}
        </select>
        <button type="button" className="btn" aria-expanded={embedOpen} onClick={() => setEmbedOpen((v) => !v)}>{text.embed}</button>
      </div>
      {embedOpen && (
        <div className="embed">
          <p className="panel-note">{text.embedHelp}</p>
          <code className="p-data embed-code">{snippet}</code>
          <button
            type="button"
            className="btn"
            onClick={() => { navigator.clipboard?.writeText(snippet).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
          >
            {copied ? text.copied : text.copy}
          </button>
        </div>
      )}
    </div>
  );
}
