'use client';

import { useEffect, useRef, useState } from 'react';
import { northUpWcs } from '../../lib/look/hips';
import { isAbort, renderHips } from '../../lib/look/hipsRender';

/** Real SPHEREx DR1 colour image (north up) of a spot, rendered in the browser from IRSA tiles. */
export default function SkyThumb({ ra, dec, fovDeg, px = 300, label, caption, loadingText, failText }: {
  ra: number; dec: number; fovDeg: number; px?: number; label: string; caption: string; loadingText: string; failText: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'fail'>('loading');
  useEffect(() => {
    const ctrl = new AbortController();
    renderHips(northUpWcs(ra, dec, fovDeg, px, px), 'color', { signal: ctrl.signal, maxRequests: 60 })
      .then((r) => {
        const cv = ref.current;
        const ctx = cv?.getContext('2d');
        if (!cv || !ctx) return;
        cv.width = r.width; cv.height = r.height;
        ctx.putImageData(new ImageData(new Uint8ClampedArray(r.rgba), r.width, r.height), 0, 0);
        setState('ok');
      })
      .catch((e) => { if (!isAbort(e)) setState('fail'); });
    return () => ctrl.abort();
  }, [ra, dec, fovDeg, px]);
  return (
    <figure className="mt-thumb">
      <div className="mt-thumb-frame" data-state={state}>
        <canvas ref={ref} role="img" aria-label={label} />
        <span className="mt-reticle" aria-hidden="true" />
        {state !== 'ok' && <span className="mt-thumb-msg">{state === 'loading' ? loadingText : failText}</span>}
      </div>
      <figcaption className="p-data mt-thumb-cap">{caption}</figcaption>
    </figure>
  );
}
