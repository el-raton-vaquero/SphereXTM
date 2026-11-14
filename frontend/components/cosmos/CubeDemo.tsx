'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '../useLocale';
import { COSMOS_PRESETS } from './presets';
import type { CubeFrame } from './SpectralCube3D';

const SpectralCube3D = dynamic(() => import('./SpectralCube3D'), {
  ssr: false,
  loading: () => <div className="cz-cube-loading p-data">three.js…</div>,
});

function b64ToFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(buf); // little-endian on every browser platform we target
}

/** Test pattern ONLY for exercising the component; always flagged synthetic. */
function syntheticFrames(): CubeFrame[] {
  const n = 48;
  const out: CubeFrame[] = [];
  for (let i = 0; i < 24; i++) {
    const lambda = 0.75 + (4.25 * i) / 23;
    const px = new Float32Array(n * n);
    const cx = 24 + Math.sin(i / 3) * 2;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const r2 = (x - cx) ** 2 + (y - 20) ** 2;
        px[y * n + x] = Math.exp(-r2 / 6) * (1 + lambda / 2) + 0.05 * Math.exp(-((x - 10) ** 2 + (y - 34) ** 2) / 3);
        if (x > 40 && y < 6) px[y * n + x] = NaN;
      }
    out.push({ pixels: px, n, lambda_um: lambda, mjd: 60800 + i * 7.5, season: i < 12 ? 0 : 1, detector: Math.min(6, 1 + Math.floor(i / 4)), synthetic: true, id: `synthetic-${i}` });
  }
  return out;
}

interface SearchFrame {
  id: string;
  mjd: number;
  season: number;
  detector: number;
  lambda_um: number;
  pixels_b64: string;
}

export default function CubeDemo() {
  const { locale } = useLocale();
  const es = locale === 'es';
  const [target, setTarget] = useState(COSMOS_PRESETS[2]);
  const [frames, setFrames] = useState<CubeFrame[]>([]);
  const [current, setCurrent] = useState(0);
  const [state, setState] = useState<'idle' | 'loading' | 'real' | 'error' | 'synthetic'>('idle');
  const [msg, setMsg] = useState('');

  const load = useCallback(async (ra: number, dec: number) => {
    setState('loading');
    setMsg('');
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 60000);
      const res = await fetch(`/api/v2/search?ra=${ra}&dec=${dec}&fov=4&max_frames=40`, { signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`/api/v2/search HTTP ${res.status}`);
      const body = (await res.json()) as { grid: { n: number }; frames: SearchFrame[] };
      const n = body.grid.n;
      const fr = body.frames.map((f) => ({ pixels: b64ToFloat32(f.pixels_b64), n, lambda_um: f.lambda_um, mjd: f.mjd, season: f.season, detector: f.detector, id: f.id }));
      if (!fr.length) throw new Error(es ? 'sin cuadros para esta posición' : 'no frames at this position');
      setFrames(fr);
      setCurrent(0);
      setState('real');
    } catch (e) {
      setFrames([]);
      setState('error');
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }, [es]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    void load(target.ra, target.dec);
  }, [load, target]);

  return (
    <div className="cz-cube-bg">
    <main className="cz-cube-page">
      <header>
        <p className="p-label">PRISM · SpectralCube3D</p>
        <h1 className="p-display">{es ? 'Cubo espectral' : 'Spectral cube'}</h1>
        <p className="cz-cube-lede">
          {es
            ? 'Cada corte es un cuadro SPHEREx reproyectado; su posición en el eje es su λ (o su fecha). No se interpola entre cuadros.'
            : 'Each slice is one reprojected SPHEREx frame; its position on the axis is its λ (or date). Nothing is interpolated between frames.'}
        </p>
        <div className="cz-cube-controls p-data">
          <label>
            {es ? 'objetivo' : 'target'}{' '}
            <select value={target.id} onChange={(e) => setTarget(COSMOS_PRESETS.find((p) => p.id === e.target.value) ?? COSMOS_PRESETS[0])}>
              {COSMOS_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <span>
            {state === 'loading' && (es ? 'consultando /api/v2/search…' : 'querying /api/v2/search…')}
            {state === 'real' && `${frames.length} ${es ? 'cuadros reales · IRSA SPHEREx' : 'real frames · IRSA SPHEREx'}`}
            {state === 'synthetic' && (es ? 'patrón sintético de prueba' : 'synthetic test pattern')}
          </span>
        </div>
      </header>

      {state === 'error' && (
        <div className="cz-cube-error p-data" role="alert">
          <p>{es ? 'No hay datos reales disponibles:' : 'No real data available:'} {msg}</p>
          <button
            type="button"
            className="cz-ghost"
            onClick={() => {
              setFrames(syntheticFrames());
              setCurrent(0);
              setState('synthetic');
            }}
          >
            {es ? 'Mostrar patrón SINTÉTICO de prueba' : 'Show SYNTHETIC test pattern'}
          </button>
        </div>
      )}

      {frames.length > 0 && (
        <SpectralCube3D frames={frames} current={current} onSelect={setCurrent} height="min(70vh, 640px)" locale={locale} />
      )}
    </main>
    </div>
  );
}
