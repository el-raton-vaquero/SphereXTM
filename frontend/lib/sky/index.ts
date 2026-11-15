/**
 * lib/sky — the /sky time machine (computed sky: ephemeris + proper-motion model).
 *
 * For the star symphony (lib/symphony): import the visible-sky hook from here.
 *
 *   import { getVisibleSkyBands, subscribeVisibleSky } from '../sky';
 *   const off = subscribeVisibleSky((bands, info) => play(bands)); // ≤ 4 Hz while /sky is open
 *
 * Bands are a COLOUR-BASED APPROXIMATION (blackbodies from the visible stars' B−V), not SPHEREx
 * data; label them with t.sky.bandsLabel. The /sky UI leaves a mount point for the symphony
 * controls: <div data-symphony-slot /> inside its side panel (components/sky/SkyApp.tsx).
 * Note: the import of this index does not pull three.js; the engine lives in ./engine.
 */
export {
  getVisibleSkyBands,
  getVisibleSkyInfo,
  subscribeVisibleSky,
  SKY_BAND_CENTERS_UM,
  SPHEREX_DETECTOR_EDGES_UM,
  bvToTemperature,
  blackbodyBands,
  type SkyBand,
  type VisibleSkyInfo,
} from './bands';
export { SKY_TARGETS, targetVectorAt, type SkyTarget } from './targets';
export { EPOCHS, PLACES, SPEEDS, DEFAULT_PLACE, type SkyEpoch, type SkyPlace, type SpeedId } from './time';
