import {CatalogPredictions} from './types';

// Backend pixels are zero-based centers. SVG viewBox boundaries run from 0 to
// width/height, so add half a pixel to hit the CENTER of the corresponding cell.
export function predictionMarkers(predictions: CatalogPredictions | undefined, epoch?: number) {
  return predictions?.kind === 'catalog_predicted'
    ? predictions.positions.filter(p => p.inBounds && (epoch === undefined || p.epochIndex === epoch))
      .map(p => ({...p, svgX: p.x + .5, svgY: p.y + .5}))
    : [];
}
