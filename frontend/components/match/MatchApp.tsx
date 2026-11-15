'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocale, withLang, type Messages } from '../../lib/i18n';
import SkyImageNote from '../site/SkyImageNote';
import { useMounted } from '../../lib/look/hooks';
import { FRAME_UM } from '../../lib/look/hipsRender';
import { analysisWindow, BAND_HZ, N_BANDS, type SongAnalysis } from '../../lib/match/bands';
import { analyseInWorker, coarseInWorker, deepSearch, isAbort, musicInWorker, type CoarseHit, type DeepProgress, type FineHit } from '../../lib/match/client';
import { nearestConstellation } from '../../lib/match/constellation';
import { exploreHref, songHref } from '../../lib/match/links';
import { startListening, type ListenHandle } from '../../lib/match/mic';
import { chordName, noteName, type MusicAnalysis } from '../../lib/match/musicAnalysis';
import { IndexMissingError, loadSkyIndex, type SkyIndex } from '../../lib/match/skyIndex';
import { formatDecDms, formatRaHms } from '../../lib/song/sky';
import { composeSong, playScore, type ComposeOptions, type SongChord } from '../../lib/symphony/export';
import SiteHeader from '../site/SiteHeader';
import ProfileChart from './ProfileChart';
import SkyMap from './SkyMap';
import SkyThumb from './SkyThumb';
import Visualiser from './Visualiser';

type MatchText = Messages['match'];
type Phase = 'idle' | 'listening' | 'analysing' | 'coarse' | 'deep' | 'done' | 'error';
type MusicState = { status: 'idle' | 'pending' | 'failed' } | { status: 'ready'; m: MusicAnalysis };
type IndexState = { status: 'loading' } | { status: 'ready'; idx: SkyIndex } | { status: 'missing' } | { status: 'error'; message: string };

const LISTEN_SECONDS = 12;
const MAX_FILE_SECONDS = 60;
const MAX_REGIONS = 30;
/** Longest stretch of the song played with the star (s). */
const MAX_TOGETHER = 30;

interface Song {
  title: string;
  source: 'file' | 'mic';
  analysis: SongAnalysis;
  buffer: AudioBuffer | null;
  recording: Blob | null;
  snippetStart: number;
  /** Start (s, in `buffer`) of the analysed segment: the music analysis' time 0. */
  segStart: number;
}

function useReducedMotion() {
  return useSyncExternalStore(
    (fn) => {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      mq.addEventListener('change', fn);
      return () => mq.removeEventListener('change', fn);
    },
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => false,
  );
}

let sharedCtx: AudioContext | null = null;
function audioCtx(): AudioContext {
  if (!sharedCtx || sharedCtx.state === 'closed') {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedCtx = new AC();
  }
  if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {});
  return sharedCtx;
}

/** Mono mix of up to `length` s of a buffer from `start`. */
function monoSlice(buf: AudioBuffer, start: number, length: number): Float32Array {
  const sr = buf.sampleRate, s0 = Math.floor(start * sr), n = Math.min(buf.length - s0, Math.floor(length * sr));
  const out = new Float32Array(Math.max(0, n));
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[s0 + i] / buf.numberOfChannels;
  }
  return out;
}

/** Play-along options from the song's music analysis, re-timed so that score time 0 = `from` s
 * after the analysed segment's start (chords before it dropped; composeSong loops the rest). */
function alongOptions(m: MusicAnalysis, from: number, accompaniment: boolean): ComposeOptions {
  let chords: SongChord[] = m.chords
    .filter((c) => c.t + c.dur > from + 0.05)
    .map((c) => ({ t: Math.max(0, c.t - from), dur: c.t + c.dur - Math.max(from, c.t), root: c.root, quality: c.quality }));
  if (!chords.length) chords = m.chords;
  return { tonic: m.tonic, mode: m.mode, scale: 'diatonic', bpm: m.bpm, beatOffset: m.beatOffset - from, chords, accompaniment };
}

const pct = (r: number) => Math.round(Math.max(0, Math.min(1, r)) * 100);

export default function MatchApp() {
  const { t } = useLocale();
  const mounted = useMounted();
  return (
    <div className="mt-page">
      <a className="mt-skip" href="#mt-main">{t.common.skipToContent}</a>
      <SiteHeader current="match" />
      {mounted ? <MatchStudio /> : <main id="mt-main" className="mt-main" aria-busy="true" />}
    </div>
  );
}

function MatchStudio() {
  const { locale, t: all } = useLocale();
  const t = all.match;
  const reduced = useReducedMotion();
  const nf = useMemo(() => new Intl.NumberFormat(locale === 'es' ? 'es-MX' : 'en-US'), [locale]);

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [index, setIndex] = useState<IndexState>({ status: 'loading' });
  const [song, setSong] = useState<Song | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [coarse, setCoarse] = useState<{ hits: CoarseHit[]; compared: number } | null>(null);
  const [deep, setDeep] = useState<DeepProgress | null>(null);
  const [stopped, setStopped] = useState(false);
  const [music, setMusic] = useState<MusicState>({ status: 'idle' });
  const musicFor = useRef<Song | null>(null);

  const liveLevels = useRef<Float32Array | null>(null);
  const listenRef = useRef<ListenHandle | null>(null);
  const searchCtrl = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLHeadingElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastEmit = useRef(0);

  useEffect(() => {
    let alive = true;
    loadSkyIndex().then(
      (idx) => { if (alive) setIndex({ status: 'ready', idx }); },
      (e) => { if (alive) setIndex(e instanceof IndexMissingError ? { status: 'missing' } : { status: 'error', message: String(e?.message ?? e) }); },
    );
    return () => { alive = false; };
  }, []);

  useEffect(() => () => { listenRef.current?.cancel(); searchCtrl.current?.abort(); }, []);

  // visualiser source: live mic levels, else the song's evolution (looping at 2 frames/s)
  const getLevels = useCallback((): ArrayLike<number> | null => {
    if (phase === 'listening') return liveLevels.current;
    const ev = song?.analysis.evolution;
    if (!ev?.length) return null;
    if (reduced) return ev[Math.floor(ev.length / 2)];
    const f = (performance.now() / 500) % ev.length, i = Math.floor(f), k = f - i;
    const a = ev[i], b = ev[(i + 1) % ev.length];
    return a.map((v, j) => v + (b[j] - v) * k);
  }, [phase, song, reduced]);

  const runSearch = useCallback(async (s: Song) => {
    if (index.status !== 'ready') { setPhase('done'); return; }
    const idx = index.idx;
    searchCtrl.current?.abort();
    const ctrl = new AbortController();
    searchCtrl.current = ctrl;
    setStopped(false);
    setDeep(null);
    setPhase('coarse');
    try {
      const c = await coarseInWorker(s.analysis.profile, idx, 50);
      if (ctrl.signal.aborted) return;
      setCoarse(c);
      setPhase('deep');
      const final = await deepSearch({
        song: s.analysis.profile, idx, hits: c.hits, maxRegions: MAX_REGIONS, signal: ctrl.signal,
        onProgress: (p) => {
          const now = performance.now();
          if (now - lastEmit.current < 120 && p.current) return;
          lastEmit.current = now;
          setDeep(p);
        },
      });
      setDeep(final);
      setPhase('done');
    } catch (e) {
      if (isAbort(e)) { setPhase('done'); return; }
      setError(t.errSearch(String((e as Error)?.message ?? e)));
      setPhase('done');
    }
  }, [index, t]);

  useEffect(() => {
    if (phase === 'done' && song) requestAnimationFrame(() => resultsRef.current?.focus({ preventScroll: false }));
  }, [phase, song]);

  /** Key / tempo / chords, in parallel with the sky search (never blocks it). */
  const startMusic = useCallback((s: Song, mono: Float32Array | null, sampleRate: number) => {
    musicFor.current = s;
    if (!mono || mono.length < sampleRate * 3) { setMusic({ status: 'failed' }); return; }
    setMusic({ status: 'pending' });
    musicInWorker(mono, sampleRate).then(
      (m) => { if (musicFor.current === s) setMusic({ status: 'ready', m }); },
      () => { if (musicFor.current === s) setMusic({ status: 'failed' }); },
    );
  }, []);

  const accept = useCallback((s: Song) => {
    setSong(s);
    setCoarse(null);
    setDeep(null);
    runSearch(s);
  }, [runSearch]);

  // ---- microphone
  const finishListening = useCallback(async () => {
    const h = listenRef.current;
    if (!h) return;
    listenRef.current = null;
    setPhase('analysing');
    try {
      const { analysis, recording } = await h.finish();
      let buffer: AudioBuffer | null = null;
      if (recording) {
        try { buffer = await audioCtx().decodeAudioData(await recording.arrayBuffer()); } catch { buffer = null; }
      }
      const s: Song = { title: t.micTitle, source: 'mic', analysis, buffer, recording, snippetStart: 0, segStart: 0 };
      accept(s);
      startMusic(s, buffer ? monoSlice(buffer, 0, Math.min(60, buffer.duration)) : null, buffer?.sampleRate ?? 44100);
    } catch (e) {
      setError((e as Error)?.message === 'silent' ? t.errSilent : t.errMic);
      setPhase('error');
    }
  }, [accept, startMusic, t]);

  const listen = useCallback(async () => {
    if (phase === 'listening') { finishListening(); return; }
    setError('');
    searchCtrl.current?.abort();
    try {
      setElapsed(0);
      setPhase('listening');
      listenRef.current = await startListening({
        seconds: LISTEN_SECONDS,
        onFrame: (lv, el) => { liveLevels.current = lv; setElapsed(el); },
        onAutoStop: () => { finishListening(); },
      });
    } catch (e) {
      const name = (e as DOMException)?.name;
      setError(name === 'NotAllowedError' || name === 'SecurityError' ? t.errMicDenied : t.errMic);
      setPhase('error');
    }
  }, [phase, finishListening, t]);

  // ---- file
  const onFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setError('');
    searchCtrl.current?.abort();
    listenRef.current?.cancel();
    listenRef.current = null;
    setPhase('analysing');
    try {
      const buf = await audioCtx().decodeAudioData(await file.arrayBuffer());
      const win = analysisWindow(buf.duration, MAX_FILE_SECONDS);
      const mono = monoSlice(buf, win.start, win.length);
      const musicMono = mono.slice(); // the analysis worker takes ownership of `mono`
      const analysis = await analyseInWorker(mono, buf.sampleRate);
      const title = file.name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_]+/g, ' ').trim().slice(0, 80) || t.fileTitle;
      const s: Song = { title, source: 'file', analysis, buffer: buf, recording: null, snippetStart: win.start + Math.min(10, win.length / 3), segStart: win.start };
      accept(s);
      startMusic(s, musicMono, buf.sampleRate);
    } catch (e) {
      setError((e as Error)?.message === 'silent' ? t.errSilent : t.errDecode);
      setPhase('error');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }, [accept, startMusic, t]);

  const stop = useCallback(() => { setStopped(true); searchCtrl.current?.abort(); }, []);

  const best = deep?.best ?? [];
  const compared = (coarse?.compared ?? 0) + (deep?.compared ?? 0);
  const listening = phase === 'listening';
  const busy = phase === 'analysing' || phase === 'coarse' || phase === 'deep';
  const idxReady = index.status === 'ready';
  const valid = idxReady ? index.idx.valid : Array.from({ length: N_BANDS }, () => true);

  return (
    <main id="mt-main" className="mt-main">
      <section className="mt-hero" aria-labelledby="mt-title">
        <p className="p-label mt-eyebrow">{t.eyebrow}</p>
        <h1 id="mt-title" className="p-display mt-h1">{t.title}</h1>
        <p className="mt-lede">{t.lede}</p>
      </section>

      <div className="mt-grid">
        <section className="mt-panel mt-input" aria-labelledby="mt-in-h">
          <h2 id="mt-in-h" className="mt-sr">{t.inputHeading}</h2>
          <div className="mt-listen-wrap">
            <button
              type="button"
              className="mt-listen"
              data-active={listening || undefined}
              data-reduced={reduced || undefined}
              onClick={listen}
              disabled={phase === 'analysing'}
              aria-pressed={listening}
              aria-describedby="mt-listen-hint"
            >
              <span className="mt-ring" aria-hidden="true" />
              <span className="mt-listen-label">{listening ? t.listenStop : t.listen}</span>
              <span className="mt-listen-sub p-data">
                {listening ? t.listenCountdown(Math.max(0, Math.ceil(LISTEN_SECONDS - elapsed))) : t.listenSub(LISTEN_SECONDS)}
              </span>
            </button>
            <p id="mt-listen-hint" className="mt-hint">{t.listenHint}</p>
          </div>

          <div className="mt-or"><span>{t.or}</span></div>

          <label className="mt-btn mt-file">
            <input ref={fileRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac" onChange={(e) => onFile(e.target.files?.[0])} disabled={listening || phase === 'analysing'} />
            <span>{t.upload}</span>
          </label>
          <p className="mt-micro">{t.uploadHint(MAX_FILE_SECONDS)}</p>
          <p className="mt-private">{t.privacy}</p>

          <div className="mt-vis-wrap">
            <Visualiser getLevels={getLevels} reduced={reduced} label={t.visLabel} />
            <div className="mt-vis-axis p-data" aria-hidden="true">
              <span>{t.axisHigh}</span>
              <span>{t.axisLow}</span>
            </div>
          </div>
          {song && (
            <p className="mt-now" aria-live="polite">
              <span className="p-label">{song.source === 'mic' ? t.nowMic : t.nowFile}</span>{' '}
              <span className="mt-now-t">{song.title}</span>
            </p>
          )}
          {error && <p className="mt-error" role="alert">{error}</p>}
        </section>

        <section className="mt-panel mt-search" aria-labelledby="mt-s-h">
          <h2 id="mt-s-h" className="mt-h2 p-display">{t.searchHeading}</h2>
          <MappingStrip t={t} />
          {index.status === 'missing' && <p className="mt-warn" role="status">{t.indexMissing}</p>}
          {index.status === 'error' && <p className="mt-warn" role="status">{t.indexError(index.message)}</p>}
          {index.status === 'loading' && <p className="mt-micro" role="status">{t.indexLoading}</p>}
          {idxReady && phase === 'idle' && <p className="mt-micro">{t.indexReady(nf.format(index.idx.npix))}</p>}

          <div className="mt-counter" aria-live="polite" aria-atomic="true">
            <p className="mt-count p-data">
              <span className="mt-count-n">{nf.format(compared)}</span>
              <span className="mt-count-l">{t.compared}</span>
            </p>
            <p className="mt-count p-data">
              <span className="mt-count-n mt-count-best">{best.length ? `${pct(best[0].r)}%` : '—'}</span>
              <span className="mt-count-l">{t.bestSoFar}</span>
            </p>
          </div>
          <p className="mt-status" role="status">
            {phase === 'analysing' && t.statusAnalysing}
            {phase === 'coarse' && t.statusCoarse}
            {phase === 'deep' && deep && t.statusDeep(Math.min(deep.regionsTotal, deep.regionsDone + 1), deep.regionsTotal, deep.current?.loaded ?? 0)}
            {phase === 'done' && song && idxReady && (stopped ? t.statusStopped(deep?.regionsDone ?? 0) : t.statusDone(deep?.regionsDone ?? 0))}
          </p>
          {busy && phase !== 'analysing' && (
            <div className="mt-prog" aria-hidden="true">
              <div className="mt-prog-bar" style={{ transform: `scaleX(${deep ? (deep.regionsDone + (deep.current?.loaded ?? 0) / 102) / Math.max(1, deep.regionsTotal) : 0.02})` }} />
            </div>
          )}
          {phase === 'deep' && <button type="button" className="mt-btn" onClick={stop}>{t.stop}</button>}
          {phase === 'done' && song && idxReady && stopped && (deep?.regionsDone ?? 0) < (deep?.regionsTotal ?? 0) && (
            <button type="button" className="mt-btn" onClick={() => runSearch(song)}>{t.restart}</button>
          )}
          {coarse && <SkyMap hits={coarse.hits} current={phase === 'deep' ? deep?.current ?? null : null} best={best} label={t.mapLabel} />}
          {coarse && <p className="mt-micro">{t.mapCaption}</p>}
        </section>
      </div>

      {song && best.length > 0 && (
        <section className="mt-results" aria-labelledby="mt-r-h">
          <h2 id="mt-r-h" ref={resultsRef} tabIndex={-1} className="mt-h2 p-display">{phase === 'done' ? t.resultsHeading : t.resultsLive}</h2>
          <MusicReadout music={music} t={t} locale={locale} />
          <ol className="mt-cards">
            {best.slice(0, 3).map((h, i) => (
              <ResultCard key={`${h.npix}-${h.col}-${h.row}`} hit={h} rank={i + 1} song={song} music={music.status === 'ready' ? music.m : null} valid={valid} t={t} locale={locale} final={phase === 'done'} />
            ))}
          </ol>
        </section>
      )}

      <section className="mt-integrity" aria-labelledby="mt-int-h">
        <h2 id="mt-int-h" className="p-label">{t.integrityHeading}</h2>
        <p>{t.integrity}</p>
        <p>{t.method}</p>
        <p className="mt-micro">{t.credit}</p>
      </section>
    </main>
  );
}

function MappingStrip({ t }: { t: MatchText }) {
  const stops = [0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => Math.round(f * (N_BANDS - 1)));
  return (
    <figure className="mt-mapping">
      <div className="mt-mapping-row p-data" aria-hidden="true">
        {stops.map((i) => <span key={i}>{BAND_HZ[i] >= 1000 ? `${(BAND_HZ[i] / 1000).toFixed(1)} kHz` : `${Math.round(BAND_HZ[i])} Hz`}</span>)}
      </div>
      <div className="mt-ramp" aria-hidden="true" />
      <div className="mt-mapping-row p-data" aria-hidden="true">
        {stops.map((i) => <span key={i}>{FRAME_UM[i].toFixed(2)} µm</span>)}
      </div>
      <figcaption className="mt-micro">{t.mapping}</figcaption>
    </figure>
  );
}

function MusicReadout({ music, t, locale }: { music: MusicState; t: MatchText; locale: 'en' | 'es' }) {
  if (music.status === 'idle') return null;
  if (music.status === 'pending') return <p className="mt-music mt-micro" role="status">{t.musicDetecting}</p>;
  if (music.status !== 'ready') return <p className="mt-music mt-micro" role="status">{t.musicFailed}</p>;
  const m = music.m;
  const key = { tonic: m.tonic, mode: m.mode };
  const seq: string[] = [];
  for (const c of m.chords) {
    const n = chordName(c, locale, key);
    if (seq[seq.length - 1] !== n) seq.push(n);
    if (seq.length >= 8) break;
  }
  return (
    <div className="mt-music" role="status">
      <p className="mt-music-key p-data">{t.musicReadout(t.keyLabel(noteName(m.tonic, locale, key), m.mode), Math.round(m.bpm))}</p>
      <p className="mt-micro">
        {t.musicConfidence(pct(m.keyConfidence), pct(m.tempoConfidence))}
        {seq.length > 0 && <> · {t.musicChords(seq.join(' → '))}</>}
      </p>
      <p className="mt-micro">{t.alongNote}</p>
    </div>
  );
}

function ResultCard({ hit, rank, song, music, valid, t, locale, final }: {
  hit: FineHit; rank: number; song: Song; music: MusicAnalysis | null; valid: boolean[]; t: MatchText; locale: 'en' | 'es'; final: boolean;
}) {
  const [constellation, setConstellation] = useState<string | null>(null);
  const [playing, setPlaying] = useState<'' | 'together' | 'song' | 'sky'>('');
  const [mix, setMix] = useState(0.5);
  const mixRef = useRef<{ song: GainNode; star: GainNode } | null>(null);
  const [toast, setToast] = useState('');
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let alive = true;
    nearestConstellation(hit.ra, hit.dec).then((c) => { if (alive && c) setConstellation(c.name); }, () => {});
    return () => { alive = false; };
  }, [hit.ra, hit.dec]);
  useEffect(() => () => stopRef.current?.(), []);

  const stopPlayback = () => { stopRef.current?.(); stopRef.current = null; mixRef.current = null; setPlaying(''); };
  const skyInput = () => ({
    lambda_um: FRAME_UM.slice(),
    intensity: hit.grey.map((g, i) => (g && valid[i] !== false ? g / 254 : null)),
    seed: `starmatch:${hit.ra.toFixed(4)},${hit.dec.toFixed(4)}`,
    label: 'Star Match',
  });

  /** Equal-ish power mix: 0 = song only, 0.5 = both full, 1 = star only. */
  const applyMix = (v: number) => {
    const g = mixRef.current;
    if (!g) return;
    const now = g.song.context.currentTime;
    g.song.gain.setTargetAtTime(0.8 * Math.min(1, 2 * (1 - v)), now, 0.03);
    g.star.gain.setTargetAtTime(Math.min(1, 2 * v), now, 0.03);
  };

  /** 8 s of the song, then the star picks up in the song's key, tempo and chords for 16 s. */
  const playAfter = () => {
    if (playing) { stopPlayback(); return; }
    const ctx = audioCtx();
    const timers: ReturnType<typeof setTimeout>[] = [];
    let src: AudioBufferSourceNode | null = null;
    let sky: { stop(): void } | null = null;
    const SNIP = 8, SKY = 16;
    const startSky = (at: number, from: number) => {
      const score = composeSong(skyInput(), SKY, music ? alongOptions(music, from, false) : undefined);
      sky = playScore(score, ctx, undefined, { startAt: at });
      timers.push(setTimeout(() => setPlaying('sky'), Math.max(0, (at - ctx.currentTime) * 1000)));
      timers.push(setTimeout(() => { sky?.stop(); stopRef.current = null; setPlaying(''); }, Math.max(0, (at - ctx.currentTime + SKY) * 1000)));
    };
    const t0 = ctx.currentTime + 0.05;
    if (song.buffer) {
      src = ctx.createBufferSource();
      src.buffer = song.buffer;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.9, t0 + 0.08);
      g.gain.setValueAtTime(0.9, t0 + SNIP - 0.6);
      g.gain.linearRampToValueAtTime(0, t0 + SNIP);
      src.connect(g).connect(ctx.destination);
      const off = Math.max(0, Math.min(song.snippetStart, song.buffer.duration - SNIP));
      src.start(t0, off, SNIP);
      setPlaying('song');
      // the star carries on the song's timeline: its beat grid and chords continue from the snippet
      startSky(t0 + SNIP, off - song.segStart + SNIP);
    } else {
      startSky(t0, 0);
    }
    stopRef.current = () => {
      timers.forEach(clearTimeout);
      try { src?.stop(); } catch { /* */ }
      sky?.stop();
    };
  };

  /** Song and star at the same time on one AudioContext clock, the star on the song's beat grid. */
  const playTogether = () => {
    if (playing) { stopPlayback(); return; }
    const buf = song.buffer;
    if (!buf) { playAfter(); return; }
    const ctx = audioCtx(); // created / resumed inside the click (iOS)
    const len = Math.min(MAX_TOGETHER, buf.duration - song.segStart);
    if (len < 2) { playAfter(); return; }
    const opts: ComposeOptions = music ? alongOptions(music, 0, true) : { accompaniment: true };
    const score = composeSong(skyInput(), len, { ...opts, seconds: len });
    const t0 = ctx.currentTime + 0.15;
    // song gain + star gain -> safety limiter -> speakers (the star's own chain has a limiter too)
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.15;
    limiter.connect(ctx.destination);
    const songGain = ctx.createGain(), starGain = ctx.createGain();
    songGain.connect(limiter); starGain.connect(limiter);
    mixRef.current = { song: songGain, star: starGain };
    songGain.gain.value = 0.8 * Math.min(1, 2 * (1 - mix));
    starGain.gain.value = Math.min(1, 2 * mix);
    const fade = ctx.createGain();
    fade.gain.setValueAtTime(0, t0);
    fade.gain.linearRampToValueAtTime(1, t0 + 0.03);
    fade.gain.setValueAtTime(1, t0 + len - 0.5);
    fade.gain.linearRampToValueAtTime(0, t0 + len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(fade).connect(songGain);
    src.start(t0, song.segStart, len);
    const sky = playScore(score, ctx, starGain, { startAt: t0 });
    const end = setTimeout(() => stopPlayback(), (t0 - ctx.currentTime + len + 0.3) * 1000);
    setPlaying('together');
    stopRef.current = () => {
      clearTimeout(end);
      try { src.stop(); } catch { /* */ }
      sky.stop();
      setTimeout(() => { try { limiter.disconnect(); } catch { /* */ } }, 400);
    };
  };

  const where = constellation ? t.near(constellation) : '';
  const share = async () => {
    const text = t.shareText(song.title, constellation ?? `${formatRaHms(hit.ra)} ${formatDecDms(hit.dec)}`, pct(hit.r));
    const url = new URL(withLang(exploreHref(hit.ra, hit.dec), locale), window.location.origin).toString();
    try {
      if (navigator.share) { await navigator.share({ title: t.title, text, url }); return; }
      await navigator.clipboard.writeText(`${text} ${url}`);
      setToast(t.copied);
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') setToast(t.shareFailed);
    }
  };
  const poster = songHref(hit.ra, hit.dec, t.posterDedication(song.title).slice(0, 80));

  return (
    <li className="mt-card" data-rank={rank}>
      <header className="mt-card-head">
        <span className="p-label">{t.rank(rank)}</span>
        <p className="mt-pct p-display"><span>{pct(hit.r)}</span><span className="mt-pct-u">%</span></p>
        <p className="mt-pct-l">{t.similar}</p>
        <p className="mt-where">{where || ' '}</p>
        <p className="p-data mt-coords">α {formatRaHms(hit.ra)} · δ {formatDecDms(hit.dec)}</p>
        <p className="p-data mt-micro">{t.coordsDeg(hit.ra.toFixed(4), hit.dec.toFixed(4))}</p>
      </header>
      {final ? (
        <div className="mt-thumbs">
          <SkyThumb ra={hit.ra} dec={hit.dec} fovDeg={1} label={t.imgLabel(1)} caption={t.imgWide} loadingText={t.imgLoading} failText={t.imgFail} />
          <SkyThumb ra={hit.ra} dec={hit.dec} fovDeg={10 / 60} label={t.imgLabel(10 / 60)} caption={t.imgZoom} loadingText={t.imgLoading} failText={t.imgFail} />
          <SkyImageNote className="mt-thumbs-note" />
        </div>
      ) : (
        <p className="mt-micro">{t.imgAfter}</p>
      )}
      <ProfileChart
        song={song.analysis.profile} sky={hit.z} valid={valid} title={t.chartLabel(pct(hit.r))}
        songLabel={t.legendSong} skyLabel={t.legendSky} hzAxis={t.axisHz} umAxis={t.axisUm}
      />
      <div className="mt-actions">
        {playing === 'together' ? (
          <div className="mt-mix">
            <button type="button" className="mt-btn mt-btn-primary" onClick={stopPlayback} aria-pressed="true">{t.playingTogether} {t.stopPlay}</button>
            <label className="mt-mix-row p-data">
              <span>{t.mixSong}</span>
              <input
                type="range" min={0} max={1} step={0.01} value={mix} aria-label={t.mixLabel}
                onChange={(e) => { const v = Number(e.target.value); setMix(v); applyMix(v); }}
              />
              <span>{t.mixStar}</span>
            </label>
          </div>
        ) : playing ? (
          <button type="button" className="mt-btn mt-btn-primary" onClick={stopPlayback} aria-pressed="true">
            {playing === 'song' ? t.playingSong : t.playingSky}
          </button>
        ) : (
          <>
            <button type="button" className="mt-btn mt-btn-primary" onClick={playTogether} disabled={!song.buffer}>{t.playTogether}</button>
            <button type="button" className="mt-btn mt-span" onClick={playAfter}>{t.playAfter}</button>
          </>
        )}
        <a className="mt-btn" href={withLang(exploreHref(hit.ra, hit.dec), locale)}>{t.openExplorer}</a>
        {poster && <a className="mt-btn" href={withLang(poster, locale)}>{t.poster}</a>}
        <button type="button" className="mt-btn" onClick={share}>{t.share}</button>
        <p className="mt-toast" role="status">{toast}</p>
      </div>
    </li>
  );
}
