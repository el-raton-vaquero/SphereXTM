'use client';

import { useState } from 'react';
import { resolveTargetName } from '../../lib/sesame';
import { formatDec, formatRa, parseRaDec } from '../../lib/prism/coords';
import { useLocale } from '../../lib/i18n';
import type { V2Target } from '../../lib/prism/types';

interface Props {
  targets: V2Target[];
  activeId?: string;
  fov: number;
  onPoint: (p: { ra: number; dec: number; target?: string; label?: string }) => void;
  onFov: (fov: number) => void;
}

const FOVS = [2, 4, 6, 10];

/** Search (name or coordinates, resolved locally or with CDS Sesame) plus one row of preset chips. */
export default function TargetBar({ targets, activeId, fov, onPoint, onFov }: Props) {
  const { t } = useLocale();
  const text = t.explore;
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (!q.trim()) { document.getElementById('prism-q')?.focus(); return; }
    const parsed = parseRaDec(q);
    if (parsed) { onPoint(parsed); return; }
    const preset = targets.find((x) => x.name.toLowerCase() === q.trim().toLowerCase() || x.id === q.trim().toLowerCase());
    if (preset) { onPoint({ ra: preset.ra, dec: preset.dec, target: preset.id }); return; }
    setBusy(true);
    try {
      const r = await resolveTargetName(q);
      if (r) {
        onPoint({ ra: r.ra, dec: r.dec, label: r.name });
        setMsg(`${r.name} → ${formatRa(r.ra, 1)} ${formatDec(r.dec, 0)} · ${text.resolvedVia[r.source] ?? r.source}`);
      } else setMsg(text.notResolved);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="xp-bar">
      <form className="xp-search" onSubmit={submit} role="search">
        <label htmlFor="prism-q" className="sr-only">{text.searchLabel}</label>
        <input
          id="prism-q"
          className="xp-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={text.searchPlaceholder}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="xp-go" disabled={busy}>{busy ? text.resolving : text.go}</button>
        <label className="xp-fov">
          <span className="sr-only">{text.fovLabel}</span>
          <select value={fov} onChange={(e) => onFov(Number(e.target.value))} aria-label={text.fovLabel}>
            {(FOVS.includes(fov) ? FOVS : [...FOVS, fov].sort((a, b) => a - b)).map((f) => <option key={f} value={f}>{text.fovOption(f)}</option>)}
          </select>
        </label>
      </form>
      {msg && <p className="xp-small xp-msg" role="status">{msg}</p>}
      <div className="xp-presets">
        <span className="xp-presets-l">{text.tryLabel}</span>
        <ul>
          {targets.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="xp-chip"
                aria-pressed={activeId === p.id}
                onClick={() => onPoint({ ra: p.ra, dec: p.dec, target: p.id })}
                title={t.targets[p.id]?.blurb ?? ''}
              >
                {t.targets[p.id]?.name ?? p.name}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
