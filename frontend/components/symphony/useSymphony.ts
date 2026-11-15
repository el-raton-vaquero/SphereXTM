'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isAudioSupported, SymphonyEngine, type SymphonySpectrum } from '../../lib/symphony/engine';

const noop = () => () => {};

/**
 * Owns one SymphonyEngine for a component: lazily created on the first play (a user gesture,
 * as autoplay rules and iOS Safari require) and fully disposed on unmount.
 */
export function useSymphony() {
  const engineRef = useRef<SymphonyEngine | null>(null);
  const pendingRef = useRef<SymphonySpectrum | null>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [volume, setVolumeState] = useState(0.8);
  const [muted, setMutedState] = useState(false);
  const supported = useSyncExternalStore(noop, isAudioSupported, () => true);

  useEffect(() => () => {
    engineRef.current?.dispose();
    engineRef.current = null;
  }, []);

  const getEngine = useCallback(() => engineRef.current, []);

  /** Feed the spectrum (kept until the engine exists, so the first play uses it). */
  const setSpectrum = useCallback((s: SymphonySpectrum | null) => {
    pendingRef.current = s;
    engineRef.current?.setSpectrum(s);
  }, []);

  const play = useCallback(async () => {
    try {
      if (!engineRef.current) {
        const e = new SymphonyEngine();
        e.setVolume(volume);
        e.setMuted(muted);
        e.setSpectrum(pendingRef.current);
        engineRef.current = e;
      }
      setFailed(false);
      setPlaying(true);
      await engineRef.current.start();
    } catch {
      setPlaying(false);
      setFailed(true);
    }
  }, [volume, muted]);

  const pause = useCallback(async () => {
    setPlaying(false);
    await engineRef.current?.pause();
  }, []);

  const toggle = useCallback(() => (playing ? pause() : play()), [playing, play, pause]);

  const setVolume = useCallback((v: number) => {
    setVolumeState(v);
    engineRef.current?.setVolume(v);
  }, []);

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m);
    engineRef.current?.setMuted(m);
  }, []);

  return { supported, playing, failed, volume, muted, play, pause, toggle, setVolume, setMuted, setSpectrum, getEngine };
}

export type SymphonyControls = ReturnType<typeof useSymphony>;

/** Download a Blob as a file (WAV export). */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
