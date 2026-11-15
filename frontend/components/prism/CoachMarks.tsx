'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocale } from '../../lib/i18n';

const KEY = 'starchord.explore.tour';
const TARGETS = ['player', 'transport', 'details'];

export function tourDone(): boolean {
  try { return window.localStorage.getItem(KEY) === 'done'; } catch { return false; }
}
function markDone() {
  try { window.localStorage.setItem(KEY, 'done'); } catch { /* storage blocked: the tour shows again next visit */ }
}

type Box = { top: number; left: number; width: number; height: number };

/**
 * Three-step first-visit tour. Non-modal: a small card next to the element marked
 * data-coach="player|transport|details" plus a hairline highlight around it.
 * Dismissal is remembered in localStorage ('starchord.explore.tour'); `open` re-runs it.
 */
export default function CoachMarks({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useLocale();
  const c = t.explore.coach;
  const [step, setStep] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [card, setCard] = useState<{ top: number; left: number; width: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  const finish = useCallback(() => { markDone(); setStep(0); onClose(); }, [onClose]);

  const place = useCallback(() => {
    const el = document.querySelector(`[data-coach="${TARGETS[step]}"]`);
    if (!el) { setBox(null); setCard(null); return; }
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
    const width = Math.min(340, vw - 32);
    const h = cardRef.current?.offsetHeight ?? 170;
    let top: number;
    let left = Math.min(Math.max(16, r.left + Math.min(24, r.width / 4)), vw - width - 16);
    if (r.height > vh * 0.45) {
      // Large targets (the sky player): sit inside their top-left corner, over the image.
      top = Math.min(Math.max(12, r.top + 16), vh - h - 16);
      left = Math.min(Math.max(16, r.left + 16), vw - width - 16);
    } else {
      top = r.bottom + 12;
      if (top + h > vh - 12) top = r.top - h - 12;
      if (top < 12) top = Math.max(12, vh - h - 16);
    }
    setCard({ top, left, width });
  }, [step]);

  useEffect(() => {
    if (!open) return;
    const el = document.querySelector(`[data-coach="${TARGETS[step]}"]`);
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) {
        el.scrollIntoView({ block: r.height > window.innerHeight * 0.6 ? 'start' : 'center', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
    }
    const id = window.setTimeout(place, 380);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { passive: true });
    return () => { window.clearTimeout(id); window.removeEventListener('resize', place); window.removeEventListener('scroll', place); };
  }, [open, step, place]);

  useLayoutEffect(() => { if (open && card) nextRef.current?.focus({ preventScroll: true }); }, [open, step, card]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, finish]);

  if (!open) return null;
  const s = c.steps[step];
  const last = step === c.steps.length - 1;
  return (
    <>
      {box && <div className="coach-ring" style={{ top: box.top - 6, left: box.left - 6, width: box.width + 12, height: box.height + 12 }} aria-hidden />}
      <div
        ref={cardRef}
        className="coach"
        role="dialog"
        aria-modal="false"
        aria-label={c.aria}
        style={card ? { top: card.top, left: card.left, width: card.width } : { visibility: 'hidden' }}
      >
        <p className="coach-n p-data">{c.counter(step + 1, c.steps.length)}</p>
        <h2 className="coach-t">{s.title}</h2>
        <p className="coach-b">{s.body}</p>
        <div className="coach-actions">
          <button type="button" className="coach-skip" onClick={finish}>{c.skip}</button>
          <button ref={nextRef} type="button" className="coach-next" onClick={() => (last ? finish() : setStep((v) => v + 1))}>{last ? c.done : c.next}</button>
        </div>
      </div>
    </>
  );
}
