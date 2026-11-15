'use client';

/**
 * Star symphony for /sky: feeds the dock with the visible-sky bands published by the /sky engine
 * (lib/sky). Those bands are a COLOUR-BASED APPROXIMATION computed from the visible stars, so the
 * dock is labelled provenance 'computed'. Updates arrive at <= 4 Hz; the dock is retuned at most
 * about once a second so the melody glides instead of jittering while the sky moves.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocale } from '../../lib/i18n';
import { getVisibleSkyBands, getVisibleSkyInfo, subscribeVisibleSky } from '../../lib/sky';
import { formatLocalDate } from '../../lib/sky/time';
import SymphonyDock, { type SymphonySpectrum } from './SymphonyDock';

const RETUNE_MS = 900;

export default function SkySymphony() {
  const { t } = useLocale();
  const [tick, setTick] = useState(0);
  const lastRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const off = subscribeVisibleSky(() => {
      const now = Date.now();
      const wait = RETUNE_MS - (now - lastRef.current);
      if (wait <= 0) {
        lastRef.current = now;
        setTick((n) => n + 1);
      } else if (timerRef.current === null) {
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          lastRef.current = Date.now();
          setTick((n) => n + 1);
        }, wait);
      }
    });
    return () => {
      off();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, []);

  const getSpectrum = (): SymphonySpectrum | null => {
    const bands = getVisibleSkyBands();
    const info = getVisibleSkyInfo();
    if (!bands.length || !info) return null;
    return {
      lambda_um: bands.map((b) => b.lambda_um),
      intensity: bands.map((b) => b.intensity),
      label: t.sky.symphonyDockLabel(formatLocalDate(info.timeMs, 0), info.starCount),
      provenance: 'computed',
    };
  };

  return <SymphonyDock getSpectrum={getSpectrum} refreshKey={`${tick}:${t.common.langName}`} />;
}
