'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useLocale } from '../../lib/i18n';

/**
 * Plain-language explainer for a piece of jargon: a small "?" button that opens a short note.
 * The text comes from explore.glossary in the i18n dictionaries.
 * Opens on click/Enter, closes on Escape, outside click or a second click.
 */
export default function Term({ id, children, className }: { id: string; children?: React.ReactNode; className?: string }) {
  const { t } = useLocale();
  const entry = t.explore.glossary[id];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const popId = useId();
  const popRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);

  // Keep the note inside the viewport (phones): shift it left when it would overflow.
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!open || !el) return;
    el.style.transform = '';
    const r = el.getBoundingClientRect();
    const over = r.right - (window.innerWidth - 12);
    const under = 12 - r.left;
    setShift(over > 0 ? -over : under > 0 ? under : 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!entry) return <>{children}</>;
  return (
    <span className={`term${className ? ` ${className}` : ''}`} ref={ref}>
      {children}
      <button
        type="button"
        className="term-q"
        aria-label={t.explore.termAria(entry.term)}
        aria-expanded={open}
        aria-controls={popId}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open && (
        <span className="term-pop" id={popId} role="note" ref={popRef} style={shift ? { transform: `translateX(${shift}px)` } : undefined}>
          <strong>{entry.term}</strong>
          <span>{entry.body}</span>
        </span>
      )}
    </span>
  );
}
