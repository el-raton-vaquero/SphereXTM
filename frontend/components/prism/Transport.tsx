'use client';

import { useMemo } from 'react';
import { useLocale } from '../../lib/i18n';
import { lambdaColor } from '../../lib/prism/ramp';
import type { Frame } from '../../lib/prism/types';

export const SPEEDS = [1, 2, 4, 8];

interface Props {
  /** Frames the timeline steps through, already in playback order. */
  pool: Frame[];
  current: Frame;
  playing: boolean;
  speed: number;
  axis: 'time' | 'lambda';
  /** Hide the time/colour switch (raw sequence always plays in time). */
  axisLocked: boolean;
  onPlay: () => void;
  onSpeed: (s: number) => void;
  onAxis: (a: 'time' | 'lambda') => void;
  onSelect: (index: number) => void;
}

/**
 * Bottom transport bar of the sky player: play/pause, a frame timeline (native range input, so
 * it is keyboard and screen-reader friendly) with one tick per frame coloured by its
 * wavelength and labelled season starts, and a speed menu.
 */
export default function Transport({ pool, current, playing, speed, axis, axisLocked, onPlay, onSpeed, onAxis, onSelect }: Props) {
  const { t } = useLocale();
  const text = t.explore;
  const pos = Math.max(0, pool.findIndex((f) => f.index === current.index));
  const n = pool.length;

  // Season starts (time axis) or detector changes (colour axis) become timeline labels.
  const marks = useMemo(() => {
    const out: { i: number; label: string }[] = [];
    pool.forEach((f, i) => {
      const prev = pool[i - 1];
      if (axis === 'time' || axisLocked) {
        if (!prev || prev.season !== f.season) out.push({ i, label: f.date.slice(0, 7) });
      } else if (!prev || prev.detector !== f.detector) out.push({ i, label: `${f.lambda_um.toFixed(1)} µm` });
    });
    return out;
  }, [pool, axis, axisLocked]);

  const pct = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);

  return (
    <div className="xp-transport" role="group" aria-label={text.transportAria} data-coach="transport">
      <button type="button" className="xp-play" onClick={onPlay} aria-pressed={playing} aria-label={playing ? text.pause : text.play}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          {playing ? <path d="M3 2h3v10H3zM8 2h3v10H8z" fill="currentColor" /> : <path d="M3 1.5v11l9-5.5z" fill="currentColor" />}
        </svg>
        <span className="xp-play-l">{playing ? text.pause : text.play}</span>
      </button>

      <div className="xp-timeline">
        <div className="xp-ticks" aria-hidden>
          {pool.map((f, i) => (
            <i key={f.index} style={{ left: `${pct(i)}%`, background: lambdaColor(f.lambda_um), opacity: f.valid_fraction > 0 ? 1 : 0.3 }} className={f.index === current.index ? 'on' : ''} />
          ))}
        </div>
        <input
          type="range"
          className="xp-range"
          min={0}
          max={Math.max(0, n - 1)}
          step={1}
          value={pos}
          disabled={n < 2}
          onChange={(e) => { const f = pool[Number(e.target.value)]; if (f) onSelect(f.index); }}
          aria-label={text.timelineLabel}
          aria-valuetext={`${text.frameOf(pos + 1, n)} · ${current.date.slice(0, 10)} · ${current.lambda_um.toFixed(3)} µm`}
        />
        <div className="xp-marks p-data" aria-hidden>
          {marks.map((m, k) => (
            <span key={m.i} style={{ left: `${pct(m.i)}%` }} className={k === marks.length - 1 && marks.length > 1 && pct(m.i) > 80 ? 'end' : ''}>{m.label}</span>
          ))}
        </div>
      </div>

      <div className="xp-transport-r">
        {!axisLocked && (
          <div className="xp-seg" role="radiogroup" aria-label={text.playThrough}>
            <button type="button" role="radio" aria-checked={axis === 'time'} onClick={() => onAxis('time')}>{text.throughTime}</button>
            <button type="button" role="radio" aria-checked={axis === 'lambda'} onClick={() => onAxis('lambda')}>{text.throughColour}</button>
          </div>
        )}
        <label className="xp-speed">
          <span className="sr-only">{text.speed}</span>
          <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))} aria-label={text.speed}>
            {SPEEDS.map((s) => <option key={s} value={s}>{text.speedNames[s] ?? `${s}`}</option>)}
          </select>
        </label>
      </div>

      <p className="xp-now">
        <span className="p-data">{current.date.slice(0, 16).replace('T', ' ')} UTC</span>
        <span className="xp-now-lam"><i style={{ background: lambdaColor(current.lambda_um) }} aria-hidden /><span className="p-data">{current.lambda_um.toFixed(3)} µm</span></span>
        <span className="xp-now-n">{text.frameOf(pos + 1, n)}</span>
      </p>
    </div>
  );
}
