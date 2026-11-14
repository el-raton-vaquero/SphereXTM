"use client";

import {useEffect, useState} from 'react';
import {ScientificDataset} from '../lib/types';
import {spherexStore, useSpherexStore} from '../store/useSpherexStore';
import {useDataMode} from './useDataMode';

export function ScientificCases() {
  const real = useDataMode();
  const {datasetId, catalogPredictions, showCatalogPredictions, isLoading} = useSpherexStore();
  const [datasets, setDatasets] = useState<ScientificDataset[]>([]);
  const [error, setError] = useState('');
  const [revision, refresh] = useState(0);
  useEffect(() => {
    if (!real) return;
    const controller = new AbortController();
    fetch('/api/datasets', {signal: controller.signal})
      .then(async response => {
        if (!response.ok) throw new Error(`Catálogo no disponible (HTTP ${response.status})`);
        const items = await response.json();
        if (!Array.isArray(items) || !items.every(item => typeof item.id === 'string' && Array.isArray(item.warnings))) {
          throw new Error('Registro científico incompatible');
        }
        if (!controller.signal.aborted) {
          setDatasets(items); setError('');
          const selected = items.find(item => item.id === spherexStore.getState().datasetId);
          if (selected) spherexStore.describeDataset(selected);
        }
      })
      .catch(error => {if (!controller.signal.aborted) setError(String(error.message));});
    return () => controller.abort();
  }, [real, revision]);
  if (!real) return null;
  const selected = datasets.find(dataset => dataset.id === (datasetId || 'm101'));
  return <section className="scientific-cases" aria-label="Casos científicos reales">
    <label htmlFor="scientific-case">Caso científico real</label>
    <select id="scientific-case" value={datasetId || 'm101'}
      onChange={event => {
        const dataset = datasets.find(item => item.id === event.target.value);
        if (dataset) void spherexStore.selectDataset(dataset);
      }}>
      {!selected && <option value={datasetId || 'm101'}>{datasetId || 'M101'} — consultando registro</option>}
      {datasets.map(dataset => <option key={dataset.id} value={dataset.id}>
        {dataset.name}{dataset.available ? '' : ' — no preparado'}
      </option>)}
    </select>
    {error && <p role="alert">{error} <button onClick={() => refresh(value => value + 1)}>Actualizar registro</button></p>}
    {selected && <>
      <strong>{selected.classificationLabel}</strong>
      <p>{selected.description}</p>
      <ul>{selected.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
      {!selected.available && <p role="status">Dataset no preparado: {selected.reason}. No se sustituye por simulación.</p>}
    </>}
    {isLoading && <p role="status">Cargando únicamente las observaciones del caso seleccionado…</p>}
    {catalogPredictions && <div className="catalog-predictions">
      <label><input type="checkbox" checked={showCatalogPredictions} onChange={spherexStore.toggleCatalogPredictions}/>
        Mostrar posiciones predichas de catálogo (no detecciones)
      </label>
      <p>Desplazamiento catalográfico predicho: {catalogPredictions.displacementArcsec.toFixed(3)}″. No medido en SPHEREx.</p>
      <small>{catalogPredictions.reference}</small>
      <ul>{catalogPredictions.positions.map(position => <li key={position.obsId}>
        {position.date.slice(0, 10)} UTC: posición predicha;
        {position.nativeValid && position.commonMaskValid ? ' píxel válido, identidad no validada' : ' píxel excluido; fuente no evaluable'}.
        {' '}{position.nativeFlagNames.join(', ')}
      </li>)}</ul>
      <details><summary>Fuentes y límites de la predicción</summary>
        <ul>{catalogPredictions.limitations.map(item => <li key={item}>{item}</li>)}</ul>
        {catalogPredictions.references.map(url => <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}
      </details>
    </div>}
  </section>;
}
