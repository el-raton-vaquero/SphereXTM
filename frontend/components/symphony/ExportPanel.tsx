'use client';

import { useState } from 'react';
import { useLocale } from '../../lib/i18n';
import type { SymphonySpectrum } from '../../lib/symphony/engine';
import {
  composeSong, downloadBlob, renderScoreToWav, scoreToMidi, songSlug, SONG_VOICES, type SongScore,
} from '../../lib/symphony/export';
import { makeZip } from '../../lib/symphony/zip';

const SECONDS = 45;

type Job = 'midi' | 'wav' | 'stems';

/** "Export" group: the current region's spectrum composed as a fixed piece (MIDI / WAV / stems). */
export default function ExportPanel({ spectrum, slug }: { spectrum: SymphonySpectrum | null; slug: string }) {
  const { t } = useLocale();
  const ts = t.symphony;
  const [busy, setBusy] = useState<Job | null>(null);
  const [failed, setFailed] = useState(false);

  const score = (): SongScore | null =>
    spectrum ? composeSong({ lambda_um: spectrum.lambda_um, intensity: spectrum.intensity, label: spectrum.label }, SECONDS) : null;

  const run = async (job: Job) => {
    const s = score();
    if (!s || busy) return;
    setBusy(job);
    setFailed(false);
    const name = songSlug(slug);
    try {
      if (job === 'midi') {
        downloadBlob(new Blob([scoreToMidi(s) as BlobPart], { type: 'audio/midi' }), `${name}.mid`);
      } else if (job === 'wav') {
        downloadBlob(await renderScoreToWav(s), `${name}.wav`);
      } else {
        const files: { name: string; data: Uint8Array }[] = [];
        for (const v of SONG_VOICES) {
          if (!s.notes.some((n) => n.voice === v)) continue;
          const blob = await renderScoreToWav(s, 44100, [v]);
          files.push({ name: `${name}-${v}.wav`, data: new Uint8Array(await blob.arrayBuffer()) });
        }
        files.push({ name: `${name}.mid`, data: scoreToMidi(s) });
        downloadBlob(new Blob([makeZip(files) as BlobPart], { type: 'application/zip' }), `${name}-stems.zip`);
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  const off = !spectrum || busy !== null;
  return (
    <section className="sym-export" aria-labelledby="sym-export-title">
      <h2 id="sym-export-title" className="p-label">{ts.exportTitle}</h2>
      <p className="sym-help">{ts.exportHint}</p>
      <div className="sym-export-btns">
        <button type="button" className="sym-btn" disabled={off} onClick={() => void run('midi')}>
          {busy === 'midi' ? ts.exportBusy : ts.exportMidi}
        </button>
        <button type="button" className="sym-btn" disabled={off} onClick={() => void run('wav')}>
          {busy === 'wav' ? ts.exportBusy : ts.exportWav(SECONDS)}
        </button>
        <button type="button" className="sym-btn" disabled={off} onClick={() => void run('stems')}>
          {busy === 'stems' ? ts.exportBusy : ts.exportStems}
        </button>
      </div>
      <p className="sym-help">{ts.exportStemsHint}</p>
      {failed && <p className="sym-help" role="alert">{ts.exportError}</p>}
      <p className="sym-export-note p-data">{ts.exportNote}</p>
      <p className="sym-sr" aria-live="polite">{busy ? ts.exportBusy : ''}</p>
    </section>
  );
}
