// PRISM V2 API client. All calls are same-origin /api/v2/* (Next rewrites to FastAPI).
import { decodeSearch } from './decode';
import type {
  GaiaResponse, Progress, SearchResult, SkybotResponse, SpectrumResponse, V2TargetsResponse,
  VerdictResponse, WireSearch,
} from './types';

export const API_BASE = (process.env.NEXT_PUBLIC_PRISM_API_BASE || '/api/v2').replace(/\/$/, '');
/**
 * Live API available? Set at build time by next.config.ts: true when NEXT_PUBLIC_PRISM_API_BASE or
 * SPHEREX_API_INTERNAL_URL is configured, or outside Vercel (local dev proxies /api to :8000).
 * A static Vercel build without a backend serves only the labelled real snapshots.
 */
export const LIVE_ENABLED = process.env.NEXT_PUBLIC_PRISM_LIVE !== '0';

export class ApiError extends Error {
  constructor(message: string, readonly status: number | null, readonly kind: 'network' | 'http' | 'contract' | 'timeout' | 'aborted' | 'disabled', readonly errorType?: string) {
    super(message);
  }
  /** True when the service itself is unreachable/broken (snapshot fallback is acceptable, with a label). */
  get unavailable() {
    if (this.errorType === 'no_coverage' || this.errorType === 'invalid_parameter') return false;
    return this.kind === 'disabled' || this.kind === 'network' || this.kind === 'timeout' || (this.status !== null && (this.status >= 500 || this.status === 404));
  }
}

function qs(params: Record<string, string | number | undefined | null>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  return u.toString();
}

async function getJson<T>(path: string, params: Record<string, string | number | undefined | null>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  if (!LIVE_ENABLED) throw new ApiError(`${path}: live API not configured in this deployment`, null, 'disabled');
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort('timeout'), opts.timeoutMs ?? 45000);
  const onAbort = () => ctrl.abort('aborted');
  opts.signal?.addEventListener('abort', onAbort);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}?${qs(params)}`, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
  } catch {
    if (opts.signal?.aborted) throw new ApiError('aborted', null, 'aborted');
    if (ctrl.signal.aborted) throw new ApiError(`${path}: timed out`, null, 'timeout');
    throw new ApiError(`${path}: service unreachable`, null, 'network');
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  if (!res.ok) {
    let detail = res.statusText;
    let errorType: string | undefined;
    try {
      const body = await res.json();
      errorType = typeof body?.error_type === 'string' ? body.error_type : undefined;
      detail = typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? body).slice(0, 240);
    } catch { /* not JSON (e.g. proxy error page) */ }
    throw new ApiError(`${path}: HTTP ${res.status} — ${detail}`, res.status, 'http', errorType);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(`${path}: response is not JSON`, res.status, 'contract');
  }
}

export interface SearchParams { ra: number; dec: number; fov: number; max_frames?: number; collections?: string }

/**
 * Live search. Tries the SSE stream first (real progress), falls back to the plain endpoint.
 * The stream is expected to emit `progress` events ({stage, done, total, message}) and a final
 * `result` event carrying the /v2/search payload, or `error` ({detail}).
 */
export async function searchLive(p: SearchParams, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<SearchResult> {
  if (!LIVE_ENABLED) throw new ApiError('/search: live API not configured in this deployment', null, 'disabled');
  const params = { ra: p.ra.toFixed(6), dec: p.dec.toFixed(6), fov: p.fov, max_frames: p.max_frames ?? 60, collections: p.collections };
  if (typeof EventSource !== 'undefined') {
    try {
      const wire = await streamSearch(params, onProgress, signal);
      if (wire) return decodeSearch(wire);
    } catch (e) {
      if (e instanceof ApiError && (e.kind === 'aborted' || e.kind === 'http')) throw e;
      // stream unsupported/unreachable: try the plain endpoint below
    }
  }
  onProgress({ stage: 'query', message: 'GET /v2/search' });
  const wire = await getJson<WireSearch>('/search', params, { signal, timeoutMs: 90000 });
  try {
    return decodeSearch(wire);
  } catch (e) {
    throw new ApiError(`/search: ${(e as Error).message}`, 200, 'contract');
  }
}

function streamSearch(params: Record<string, string | number | undefined>, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<WireSearch | null> {
  return new Promise((resolve, reject) => {
    const es = new EventSource(`${API_BASE}/search/stream?${qs(params)}`);
    let gotAny = false;
    const close = () => { es.close(); signal.removeEventListener('abort', onAbort); clearTimeout(silence); };
    const onAbort = () => { close(); reject(new ApiError('aborted', null, 'aborted')); };
    signal.addEventListener('abort', onAbort);
    let silence = setTimeout(() => { close(); reject(new ApiError('stream silent', null, 'timeout')); }, 10000);
    const handle = (raw: string, type: string) => {
      gotAny = true;
      clearTimeout(silence);
      silence = setTimeout(() => { close(); reject(new ApiError('stream stalled', null, 'timeout')); }, 60000);
      let data: unknown;
      try { data = JSON.parse(raw); } catch { return; }
      const d = data as Record<string, unknown>;
      if (type === 'error' || (d && typeof d.detail === 'string' && !d.frames)) {
        close();
        const status = typeof d.status_code === 'number' ? d.status_code : 500;
        reject(new ApiError(`/search/stream: ${String(d.detail ?? 'error')}`, status, 'http', typeof d.error_type === 'string' ? d.error_type : undefined));
      } else if (d && Array.isArray(d.frames)) {
        close();
        resolve(d as unknown as WireSearch);
      } else if (d && (d.result as Record<string, unknown>)?.frames) {
        close();
        resolve(d.result as WireSearch);
      } else if (d) {
        onProgress({ stage: String(d.stage ?? type), done: d.done as number, total: d.total as number, message: d.message as string });
      }
    };
    es.addEventListener('progress', (ev) => handle((ev as MessageEvent).data, 'progress'));
    es.addEventListener('result', (ev) => handle((ev as MessageEvent).data, 'result'));
    es.addEventListener('error', (ev) => {
      const data = (ev as MessageEvent).data;
      if (typeof data === 'string' && data) return handle(data, 'error');
      close();
      if (gotAny) reject(new ApiError('stream interrupted', null, 'network'));
      else reject(new ApiError('stream unavailable', null, 'network'));
    });
    es.onmessage = (ev) => handle(ev.data, 'message');
  });
}

export const fetchTargets = (signal?: AbortSignal) => getJson<V2TargetsResponse>('/targets', {}, { signal, timeoutMs: 8000 });

export const fetchGaia = (ra: number, dec: number, radiusArcmin: number, mjds: number[], signal?: AbortSignal) =>
  getJson<GaiaResponse>('/gaia', { ra: ra.toFixed(6), dec: dec.toFixed(6), radius_arcmin: radiusArcmin.toFixed(2), mjd: mjds.map((m) => m.toFixed(5)).join(',') }, { signal, timeoutMs: 30000 });

export const fetchSkybot = (ra: number, dec: number, radiusArcmin: number, mjd: number, signal?: AbortSignal) =>
  getJson<SkybotResponse>('/skybot', { ra: ra.toFixed(6), dec: dec.toFixed(6), radius_arcmin: radiusArcmin.toFixed(2), mjd: mjd.toFixed(5) }, { signal, timeoutMs: 30000 });

export const fetchSpectrum = (ra: number, dec: number, aperture = 9, signal?: AbortSignal) =>
  getJson<SpectrumResponse>('/spectrum', { ra: ra.toFixed(6), dec: dec.toFixed(6), aperture_arcsec: aperture }, { signal, timeoutMs: 90000 });

export const fetchVerdict = (ra: number, dec: number, fov: number, signal?: AbortSignal) =>
  getJson<VerdictResponse>('/verdict', { ra: ra.toFixed(6), dec: dec.toFixed(6), fov }, { signal, timeoutMs: 90000 });
