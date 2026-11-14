"use client";
import {useEffect, useRef} from 'react';
import {CatalogPredictions} from '../lib/types';
import {predictionMarkers} from '../lib/catalogOverlay';
import {renderImage} from '../lib/renderEngine';
import {useSpherexStore} from '../store/useSpherexStore';

export function CatalogOverlay({predictions, epoch, width, height}: {
  predictions?: CatalogPredictions; epoch?: number; width: number; height: number;
}) {
  return <svg viewBox={`0 0 ${width} ${height}`} className="catalog-overlay"
    role="img" aria-label="Posiciones predichas de catálogo; no detecciones medidas">
    {predictionMarkers(predictions, epoch).map(p => <g key={p.obsId}
      stroke={p.epochIndex === 0 ? '#fbbf24' : '#22d3ee'} fill="none" strokeWidth=".12">
      <title>Predicción {p.date} UTC · {p.nativeValid && p.commonMaskValid ? 'identidad sin validar' : 'píxel excluido'}</title>
      <circle cx={p.svgX} cy={p.svgY} r=".8" strokeDasharray=".2 .15"/>
      <path d={`M${p.svgX-1.1},${p.svgY}h2.2 M${p.svgX},${p.svgY-1.1}v2.2`}/>
      <text x={p.svgX+1} y={p.svgY-1} fontSize=".65" stroke="none"
        fill={p.epochIndex === 0 ? '#fbbf24' : '#22d3ee'}>Predicción t{p.epochIndex+1}</text>
    </g>)}
  </svg>;
}

function EpochPreview({epoch}: {epoch: number}) {
  const {frames, detectors, stretch, colormap, catalogPredictions, showCatalogPredictions} = useSpherexStore();
  const ref = useRef<HTMLCanvasElement>(null);
  const frame = frames.find(f => f.epochIndex === epoch);
  useEffect(() => {
    const image = renderImage(frames, epoch, detectors, 'normal', 'first', stretch, colormap);
    if (ref.current && image) {
      ref.current.width = image.width; ref.current.height = image.height;
      ref.current.getContext('2d')?.putImageData(image, 0, 0);
    }
  }, [frames, epoch, detectors, stretch, colormap]);
  if (!frame) return null;
  return <figure><figcaption>{frame.date.slice(0,10)} UTC · D{frame.detector} · ≈{frame.band.lambda_um.toFixed(5)} µm</figcaption>
    <div className="epoch-preview"><canvas ref={ref} aria-label={`Observación real ${frame.date}`}/>
      {showCatalogPredictions && catalogPredictions && <CatalogOverlay predictions={catalogPredictions}
        epoch={epoch} width={frame.width} height={frame.height}/>}
    </div></figure>;
}

export function RealSideBySide() {
  const {frames, epochs, isLoading, error} = useSpherexStore();
  if (isLoading || error || !frames.length) return null;
  return <section className="real-side-by-side" aria-label="Comparación lado a lado">
    {epochs.map((epoch, index) => <EpochPreview key={epoch.mjd} epoch={index}/>)}
    <p>Misma cuadrícula y escala visual. Máscara azul: píxeles excluidos. Las cruces, si se muestran, son predicciones; no movimiento medido.</p>
  </section>;
}
