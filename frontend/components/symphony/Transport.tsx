'use client';

import { useLocale } from '../../lib/i18n';
import type { SymphonyControls } from './useSymphony';

/** Play/pause, volume and mute. Shared by the /symphony page and the dock. */
export default function Transport({ s, compact }: { s: SymphonyControls; compact?: boolean }) {
  const { t } = useLocale();
  const ts = t.symphony;
  return (
    <div className={`sym-transport${compact ? ' sym-transport-compact' : ''}`}>
      <button
        type="button"
        className="sym-play"
        aria-pressed={s.playing}
        aria-label={s.playing ? ts.pauseMusic : ts.playMusic}
        onClick={() => void s.toggle()}
        disabled={!s.supported}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          {s.playing ? (
            <g fill="currentColor"><rect x="2.5" y="2" width="3" height="10" /><rect x="8.5" y="2" width="3" height="10" /></g>
          ) : (
            <path d="M3 1.8 L12 7 L3 12.2 Z" fill="currentColor" />
          )}
        </svg>
        <span>{s.playing ? ts.pause : ts.play}</span>
      </button>
      <label className="sym-vol">
        <span className={compact ? 'sym-sr' : 'p-label'}>{ts.volume}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={s.volume}
          onChange={(e) => s.setVolume(Number(e.target.value))}
          disabled={!s.supported}
        />
      </label>
      <button
        type="button"
        className="sym-mute"
        aria-pressed={s.muted}
        onClick={() => s.setMuted(!s.muted)}
        disabled={!s.supported}
      >
        {s.muted ? ts.unmute : ts.mute}
      </button>
      {!s.supported && <p className="sym-warn" role="status">{ts.noAudio}</p>}
      {s.failed && <p className="sym-warn" role="status">{ts.audioError}</p>}
    </div>
  );
}
