// Types mirroring the PRISM V2 API contract (FastAPI /v2/*, proxied as /api/v2/*).
// Wire types keep base64 buffers; decoded types carry typed arrays.

export type TargetCategory = string;

export interface V2Target {
  id: string;
  name: string;
  ra: number;
  dec: number;
  category: TargetCategory;
  blurb?: string;
  why?: string;
  epoch?: string | number;
  coord_source?: string;
  expected?: { pm_arcsec_yr?: number; saturated?: boolean; best_detectors?: number[] };
}

export interface V2TargetsResponse { targets: V2Target[] }

export interface GridWcs {
  crval: [number, number];
  crpix: [number, number];
  cd: [[number, number], [number, number]];
}

export interface Grid {
  n: number;
  pixscale_arcsec: number;
  wcs: GridWcs;
  north_up: boolean;
}

export interface WireFrame {
  id: string;
  collection: string;
  mjd: number;
  date: string;
  season: number;
  detector: number;
  lambda_um: number;
  bandwidth_um: number;
  pixels_b64: string;
  flags_b64: string;
  saturated_at_center: boolean;
  valid_fraction: number;
  center_flags?: string[];
  provenance: { url: string; obs_id: string; access_url?: string };
}

export interface Season { index: number; start_mjd: number; end_mjd: number; n_frames: number }
export interface DetectorSummary { detector: number; n_frames: number; lambda_min: number; lambda_max: number }

export interface SearchProvenance {
  citation: string;
  collections: string[];
  query_urls: string[];
  generated_utc: string;
  processing?: string;
  failures?: string[];
  [k: string]: unknown;
}

export interface WireSearch {
  query: { ra: number; dec: number; fov: number; max_frames?: number; collections?: string[] };
  grid: Grid;
  frames: WireFrame[];
  seasons: Season[];
  detectors: DetectorSummary[];
  flag_bits?: Record<string, number>;
  provenance: SearchProvenance;
  cache: 'live' | 'cached';
}

export interface Frame extends Omit<WireFrame, 'pixels_b64' | 'flags_b64'> {
  index: number;
  pixels: Float32Array;
  flags: Uint32Array;
}

export interface SearchResult extends Omit<WireSearch, 'frames'> {
  frames: Frame[];
}

export interface SkyPos { mjd: number; ra: number; dec: number }

export interface GaiaSource {
  source_id: string;
  ra: number;
  dec: number;
  ref_epoch: number;
  pmra: number | null;
  pmdec: number | null;
  parallax: number | null;
  phot_g_mean_mag: number | null;
  propagated?: boolean;
  positions: SkyPos[];
}
export interface GaiaResponse { sources: GaiaSource[]; provenance?: Record<string, unknown> }

export interface SkybotObject {
  name: string;
  number?: string | number | null;
  class?: string;
  ra: number;
  dec: number;
  mjd?: number;
  v_mag?: number | null;
  ra_rate_arcsec_h?: number;
  dec_rate_arcsec_h?: number;
  dist_arcsec?: number;
  [k: string]: unknown;
}
export interface SkybotResponse { objects?: SkybotObject[]; sources?: SkybotObject[]; mjd?: number; provenance?: Record<string, unknown> }

export interface SpectrumPoint {
  lambda_um: number;
  flux: number;
  err: number;
  unit: string;
  mjd: number;
  season: number;
  detector: number;
  frame_id: string;
  flags: string[];
  saturated: boolean;
}

export interface Classification {
  best: { class: string; template: string; teff?: number; chi2_red: number; curve?: { lambda_um: number; flux: number }[] };
  ranking: { class: string; template: string; prob: number }[];
  method: string;
  caveats: string[];
}

export interface SpectrumResponse {
  points: SpectrumPoint[];
  by_season?: Record<string, SpectrumPoint[]>;
  classification: Classification | null;
  method?: string;
  caveats?: string[];
  query?: { ra: number; dec: number; aperture_arcsec: number };
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'na';
export interface VerdictCheck { id: string; label: string; status: CheckStatus; detail: string; evidence_source: string }
export type VerdictKind = 'known_star' | 'known_asteroid' | 'artifact' | 'variable' | 'candidate' | 'inconclusive';
export interface VerdictResponse { checks: VerdictCheck[]; verdict: VerdictKind; confidence: number; summary: string; method?: string }

export interface CatalogTarget {
  id: string;
  name: string;
  identifier?: string;
  kind: 'catalog_predicted';
  references: string[];
  limitations: string[];
  pm_ra_cosdec_masyr?: number;
  pm_dec_masyr?: number;
  positions: SkyPos[];
}

export interface Snapshot {
  kind: 'prism-snapshot';
  version: number;
  id: string;
  name: string;
  generated_utc: string;
  search: WireSearch;
  gaia?: GaiaResponse;
  catalog_target?: CatalogTarget;
  spectrum?: SpectrumResponse;
  verdict?: VerdictResponse;
}

export type DataOrigin =
  | { kind: 'live' }
  | { kind: 'snapshot'; id: string; generated: string };

export type ViewMode = 'frame' | 'coadd' | 'diff' | 'goggles' | 'raw';

export interface Progress { stage: string; done?: number; total?: number; message?: string }
