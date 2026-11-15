'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale } from '../../lib/i18n';
import { formatDec, formatRa } from '../../lib/prism/coords';
import { PRESETS } from '../../lib/prism/presets';
import {
  basisFromAltAz, basisFromOrientation, cross, pitchBasis, unit, yawBasis, type CamBasis, type View,
} from '../../lib/look/camera';
import type { StarField } from '../../lib/look/hooks';
import { drawOverlay, type OverlayLayers } from '../../lib/look/overlay';
import type { SavedPlace } from '../../lib/look/places';
import { bodyStates, enuToAltAz, enuToRadec, eqjToEnuMatrix, type BodyState, type M3 } from '../../lib/look/sky';
import CaptureResult, { type Captured } from './CaptureResult';

type Perm = 'off' | 'waiting' | 'ok' | 'denied' | 'unavailable';
type Compass = 'waiting' | 'ok' | 'relative';

interface OriSample { alpha: number; beta: number; gamma: number; absolute: boolean; t: number }

const OFFSET_KEY = 'starchord.look.offset';
const FOV_KEY = 'starchord.look.vfov';
const TARGETS = PRESETS.map((p) => ({ id: p.id, name: p.name, ra: p.ra, dec: p.dec }));

function readJson<T>(key: string, fallback: T): T {
  try { const v = window.localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function writeJson(key: string, v: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage blocked */ }
}

function screenAngle(): number {
  if (typeof window === 'undefined') return 0;
  const a = window.screen?.orientation?.angle;
  if (typeof a === 'number') return a;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? (legacy + 360) % 360 : 0;
}

/** Low-pass filter on the camera basis, re-orthonormalised. */
function smooth(prev: CamBasis | null, next: CamBasis, k: number): CamBasis {
  if (!prev) return next;
  const mix = (a: number[], b: number[]) => unit([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);
  const f = mix(prev.f, next.f);
  const u0 = mix(prev.u, next.u);
  const r = unit(cross(f, u0));
  const u = unit(cross(r, f));
  return { f, u, r };
}

export default function CameraView({ place, field, locate, active }: {
  place: SavedPlace; field: StarField | null; locate: () => Promise<SavedPlace | null>; active: boolean;
}) {
  const { t } = useLocale();
  const L = t.look;
  const [phase, setPhase] = useState<'intro' | 'live' | 'captured'>('intro');
  const [cam, setCam] = useState<Perm>('off');
  const [ori, setOri] = useState<Perm>('off');
  const [compass, setCompass] = useState<Compass>('waiting');
  const [insecure] = useState(() => typeof window !== 'undefined' && !window.isSecureContext);
  const [layers, setLayers] = useState<OverlayLayers>({ stars: true, planets: true, targets: true, grid: true });
  const [vfov, setVfov] = useState<number>(() => (typeof window === 'undefined' ? 60 : readJson<number>(FOV_KEY, 0) || (window.innerHeight > window.innerWidth ? 60 : 40)));
  const [aligning, setAligning] = useState(false);
  const [offset, setOffset] = useState<{ az: number; alt: number }>(() => (typeof window === 'undefined' ? { az: 0, alt: 0 } : readJson(OFFSET_KEY, { az: 0, alt: 0 })));
  const [readout, setReadout] = useState<{ alt: number; az: number; ra: number; dec: number } | null>(null);
  const [captured, setCaptured] = useState<Captured | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const oriRef = useRef<OriSample | null>(null);
  const basisRef = useRef<CamBasis | null>(null);
  const effRef = useRef<CamBasis>(basisFromAltAz(35, 180));
  const manualRef = useRef({ alt: 35, az: 180 });
  const viewRef = useRef<View>({ w: 1, h: 1, vfov: 60 });
  const mRef = useRef<{ m: M3; at: number } | null>(null);
  const bodiesRef = useRef<{ list: BodyState[]; at: number }>({ list: [], at: 0 });
  const hitsRef = useRef<{ id: string; x: number; y: number }[]>([]);
  const dragRef = useRef<{ x: number; y: number; id: number; moved: number } | null>(null);
  const offsetRef = useRef(offset);
  const vfovRef = useRef(vfov);
  const layersRef = useRef(layers);
  const placeRef = useRef(place);
  const fieldRef = useRef(field);
  useEffect(() => { offsetRef.current = offset; writeJson(OFFSET_KEY, offset); }, [offset]);
  useEffect(() => { vfovRef.current = vfov; }, [vfov]);
  useEffect(() => { layersRef.current = layers; }, [layers]);
  useEffect(() => { placeRef.current = place; mRef.current = null; bodiesRef.current.at = 0; }, [place]);
  useEffect(() => { fieldRef.current = field; }, [field]);

  const sensorsLive = ori === 'ok';
  const videoLive = cam === 'ok';

  // ---------- sensors ----------
  const listenersRef = useRef<(() => void) | null>(null);
  const attachOrientation = useCallback(() => {
    if (listenersRef.current) return;
    let lastAbs = 0;
    const take = (alpha: number | null, beta: number | null, gamma: number | null, absolute: boolean) => {
      if (alpha === null || beta === null || gamma === null || !Number.isFinite(alpha) || !Number.isFinite(beta)) return;
      oriRef.current = { alpha, beta, gamma: gamma ?? 0, absolute, t: performance.now() };
      setOri((s) => (s === 'ok' ? s : 'ok'));
      setCompass((s) => { const n: Compass = absolute ? 'ok' : 'relative'; return s === n ? s : n; });
    };
    const onAbs = (e: DeviceOrientationEvent) => { lastAbs = performance.now(); take(e.alpha, e.beta, e.gamma, true); };
    const onRel = (e: DeviceOrientationEvent) => {
      const heading = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading;
      if (typeof heading === 'number' && Number.isFinite(heading)) return take(360 - heading, e.beta, e.gamma, true);
      if (e.absolute) return take(e.alpha, e.beta, e.gamma, true);
      if (performance.now() - lastAbs > 1500) take(e.alpha, e.beta, e.gamma, false);
    };
    const hasAbs = 'ondeviceorientationabsolute' in window;
    if (hasAbs) window.addEventListener('deviceorientationabsolute', onAbs as EventListener);
    window.addEventListener('deviceorientation', onRel);
    const timer = setTimeout(() => setOri((s) => (s === 'waiting' ? 'unavailable' : s)), 3000);
    listenersRef.current = () => {
      clearTimeout(timer);
      if (hasAbs) window.removeEventListener('deviceorientationabsolute', onAbs as EventListener);
      window.removeEventListener('deviceorientation', onRel);
    };
  }, []);

  const stopAll = useCallback(() => {
    listenersRef.current?.();
    listenersRef.current = null;
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
  }, []);
  useEffect(() => stopAll, [stopAll]);
  // Release the camera when the tab is hidden by the parent (switching to "Above me").
  useEffect(() => {
    if (!active && streamRef.current) {
      streamRef.current.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
      setCam((c) => (c === 'ok' ? 'off' : c));
    }
  }, [active]);
  const wantCameraRef = useRef(false);

  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) { setCam(insecure ? 'denied' : 'unavailable'); return; }
    setCam('waiting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
      });
      streamRef.current = stream;
      const v = videoRef.current;
      if (v) { v.srcObject = stream; await v.play().catch(() => {}); }
      setCam('ok');
    } catch (e) {
      const name = (e as DOMException)?.name;
      setCam(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable');
    }
  }, [insecure]);

  const start = useCallback(async (withCamera: boolean) => {
    // iOS: the permission prompt must be triggered synchronously inside the tap.
    const DOE = (typeof window !== 'undefined' ? (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent : undefined);
    const permP: Promise<string> = withCamera && DOE && typeof DOE.requestPermission === 'function'
      ? DOE.requestPermission().catch(() => 'denied')
      : Promise.resolve(withCamera ? 'granted' : 'skip');
    wantCameraRef.current = withCamera;
    const camP = withCamera ? startCamera() : Promise.resolve();
    if (withCamera && placeRef.current.source !== 'gps') void locate();
    setPhase('live');
    requestAnimationFrame(() => wrapRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    if (withCamera) {
      setOri('waiting');
      const perm = await permP;
      if (perm === 'granted') attachOrientation(); else setOri('denied');
    }
    await camP;
  }, [attachOrientation, locate, startCamera]);
  // Coming back to the Camera tab: re-open the stream released when the tab was hidden.
  useEffect(() => {
    if (!active || phase === 'intro' || cam !== 'off' || !wantCameraRef.current || streamRef.current) return;
    const id = setTimeout(() => { void startCamera(); }, 0);
    return () => clearTimeout(id);
  }, [active, phase, cam, startCamera]);

  // ---------- render loop ----------
  useEffect(() => {
    if (phase !== 'live' || !active) return;
    let raf = 0;
    let lastReadout = 0;
    const fonts = (() => {
      const cs = getComputedStyle(document.documentElement);
      return { data: cs.getPropertyValue('--p-font-data').trim() || 'monospace', body: cs.getPropertyValue('--p-font-body').trim() || 'sans-serif' };
    })();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const wrap = wrapRef.current, canvas = canvasRef.current;
      if (!wrap || !canvas) return;
      const w = wrap.clientWidth, h = wrap.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      }
      const view: View = { w, h, vfov: vfovRef.current };
      viewRef.current = view;
      const date = new Date();
      if (!mRef.current || now - mRef.current.at > 1000) mRef.current = { m: eqjToEnuMatrix(placeRef.current, date), at: now };
      if (now - bodiesRef.current.at > 15000 || !bodiesRef.current.list.length) bodiesRef.current = { list: bodyStates(date, placeRef.current, false), at: now };

      // pointing
      let basis: CamBasis;
      const o = oriRef.current;
      if (o) {
        const raw = basisFromOrientation(o.alpha, o.beta, o.gamma, screenAngle());
        basisRef.current = smooth(basisRef.current, raw, 0.22);
        basis = pitchBasis(yawBasis(basisRef.current, offsetRef.current.az), offsetRef.current.alt);
      } else {
        basis = basisFromAltAz(manualRef.current.alt, manualRef.current.az);
      }
      effRef.current = basis;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      hitsRef.current = drawOverlay({
        ctx, view, dpr, basis, m: mRef.current.m, field: fieldRef.current, bodies: bodiesRef.current.list, targets: TARGETS,
        layers: layersRef.current, labels: { cardinal: L.cardinal, bodies: L.bodies, horizon: L.horizon },
        background: !streamRef.current, fonts,
      });
      if (now - lastReadout > 250) {
        lastReadout = now;
        const { alt, az } = enuToAltAz(basis.f);
        const { ra, dec } = enuToRadec(mRef.current.m, basis.f);
        setReadout({ alt, az, ra, dec });
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [phase, active, L]);

  const onWheel = (e: React.WheelEvent) => {
    setVfov((v) => Math.max(10, Math.min(110, v * Math.exp(e.deltaY * 0.001))));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (sensorsLive) return;
    const mr = manualRef.current;
    const step = vfovRef.current / 12;
    if (e.key === 'ArrowLeft') mr.az = (mr.az - step + 360) % 360;
    else if (e.key === 'ArrowRight') mr.az = (mr.az + step) % 360;
    else if (e.key === 'ArrowUp') mr.alt = Math.min(89.5, mr.alt + step);
    else if (e.key === 'ArrowDown') mr.alt = Math.max(-20, mr.alt - step);
    else if (e.key === '+' || e.key === '=') setVfov((v) => Math.max(10, v / 1.15));
    else if (e.key === '-') setVfov((v) => Math.min(110, v * 1.15));
    else return;
    e.preventDefault();
  };

  // ---------- capture ----------
  const capture = useCallback((targetId?: string) => {
    const view = viewRef.current;
    const basis = effRef.current;
    const date = new Date();
    const m = eqjToEnuMatrix(placeRef.current, date);
    let photo: string | null = null;
    const v = videoRef.current;
    if (streamRef.current && v && v.videoWidth) {
      const scaleOut = Math.min(1, 1280 / view.w);
      const cw = Math.round(view.w * scaleOut), ch = Math.round(view.h * scaleOut);
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      const ctx = c.getContext('2d');
      if (ctx) {
        const s = Math.max(view.w / v.videoWidth, view.h / v.videoHeight);
        const sw = view.w / s, sh = view.h / s;
        ctx.drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, 0, 0, cw, ch);
        try { photo = c.toDataURL('image/jpeg', 0.85); } catch { photo = null; }
      }
    }
    let overlay: string | null = null;
    try { overlay = canvasRef.current?.toDataURL('image/png') ?? null; } catch { overlay = null; }
    const pointed = enuToRadec(m, basis.f);
    const { alt, az } = enuToAltAz(basis.f);
    const target = targetId ? TARGETS.find((x) => x.id === targetId) : undefined;
    setCaptured({
      photo, overlay, basis, view: { ...view }, m, date, place: placeRef.current,
      pointed: { ...pointed, alt, az }, sensors: Boolean(oriRef.current), targetId: target?.id,
    });
    setPhase('captured');
    videoRef.current?.pause();
  }, []);

  const back = useCallback(() => {
    setPhase('live');
    setCaptured(null);
    const v = videoRef.current;
    if (v && streamRef.current) void v.play().catch(() => {});
  }, []);

  // ---------- pointer: drag to look (manual) or to align (sensors); a short tap on a target captures it ----------
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: 0 };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    d.x = e.clientX; d.y = e.clientY;
    d.moved += Math.abs(dx) + Math.abs(dy);
    if (sensorsLive && !aligning) return;
    const k = vfovRef.current / Math.max(1, viewRef.current.h);
    if (sensorsLive) {
      setOffset((o) => ({ az: ((o.az - dx * k + 540) % 360) - 180, alt: Math.max(-30, Math.min(30, o.alt + dy * k)) }));
    } else {
      const mr = manualRef.current;
      mr.az = (mr.az - dx * k + 360) % 360;
      mr.alt = Math.max(-20, Math.min(89.5, mr.alt + dy * k));
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.moved > 8 || aligning) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const hit = hitsRef.current.find((h) => Math.hypot(h.x - x, h.y - y) < 24);
    if (hit) capture(hit.id);
  };

  const status = useMemo(() => {
    const items: { k: string; v: string; bad?: boolean }[] = [];
    items.push({ k: L.statusCamera, v: L.st[cam], bad: cam === 'denied' || cam === 'unavailable' });
    items.push({ k: L.statusSensors, v: L.st[ori], bad: ori === 'denied' || ori === 'unavailable' });
    if (ori === 'ok') items.push({ k: L.statusCompass, v: compass === 'ok' ? L.st.ok : compass === 'relative' ? L.st.relative : L.st.waiting, bad: compass === 'relative' });
    return items;
  }, [L, cam, ori, compass]);

  const messages: string[] = [];
  if (insecure) messages.push(L.errInsecure);
  if (cam === 'denied' && !insecure) messages.push(L.errCameraDenied);
  if (cam === 'unavailable') messages.push(L.errCameraMissing);
  if (ori === 'denied') messages.push(L.errSensorsDenied);
  if (ori === 'unavailable') messages.push(L.errSensorsMissing);
  if (ori === 'ok' && compass === 'relative') messages.push(L.errNoCompass);

  if (phase === 'captured' && captured) {
    return <CaptureResult captured={captured} onBack={back} />;
  }

  return (
    <div className="look-cam">
      {phase === 'intro' && (
        <div className="look-intro">
          <h2 className="look-h2 p-display">{L.camIntroTitle}</h2>
          <p className="look-lead">{L.camIntroBody}</p>
          <div className="look-actions">
            <button type="button" className="look-btn look-btn-primary look-btn-lg" onClick={() => void start(true)}>{L.camStart}</button>
            <button type="button" className="look-btn look-btn-lg" onClick={() => void start(false)}>{L.camManual}</button>
          </div>
          <p className="look-note">{L.privacy}</p>
          <p className="look-note">{L.httpsNote}{insecure ? ` ${L.errInsecure}` : ''}</p>
          <p className="look-note look-desktop-only">{L.camDesktopHint}</p>
        </div>
      )}
      <div className={`look-stage${phase === 'live' ? '' : ' look-hidden'}${aligning ? ' look-aligning' : ''}`} ref={wrapRef}>
        <video ref={videoRef} className={`look-video${videoLive ? '' : ' look-hidden'}`} playsInline muted autoPlay aria-hidden="true" />
        <canvas
          ref={canvasRef}
          className="look-overlay"
          role="img"
          aria-label={L.overlayLabel}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { dragRef.current = null; }}
          onWheel={onWheel}
          onKeyDown={onKey}
        />
        <div className="look-hud">
          <div className="look-readout p-data" aria-live="off">
            {readout && (
              <>
                <div><span className="look-dim">{L.ra}</span> {formatRa(readout.ra, 0)} <span className="look-dim">{L.dec}</span> {formatDec(readout.dec, 0)}</div>
                <div><span className="look-dim">{L.alt}</span> {readout.alt.toFixed(1)}° <span className="look-dim">{L.az}</span> {readout.az.toFixed(1)}° {L.cardinal[Math.round(readout.az / 45) % 8]}</div>
              </>
            )}
            <div className="look-tag look-tag-computed">{sensorsLive ? L.approxPointing : L.manualPointing}</div>
          </div>
          {(cam !== 'off' || ori !== 'off') && (
            <ul className="look-status">
              {status.map((s) => (
                <li key={s.k} className={s.bad ? 'is-bad' : undefined}><span className="look-dim">{s.k}</span> {s.v}</li>
              ))}
            </ul>
          )}
        </div>
        {messages.length > 0 && (
          <div className="look-msgs" role="status">
            {messages.map((m) => <p key={m}>{m}</p>)}
          </div>
        )}
        {aligning && <p className="look-align-hint" role="status">{L.alignOn}</p>}
      </div>
      {phase === 'live' && (
        <div className="look-controls">
          <fieldset className="look-layers">
            <legend className="sr-only">{L.layersLabel}</legend>
            {([['stars', L.layerStars], ['planets', L.layerPlanets], ['targets', L.layerTargets], ['grid', L.layerGrid]] as const).map(([k, lab]) => (
              <label key={k} className="look-chip">
                <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers((s) => ({ ...s, [k]: e.target.checked }))} />
                <span>{lab}</span>
              </label>
            ))}
          </fieldset>
          <button type="button" className="look-capture" onClick={() => capture()} title={L.captureHint}>
            <span className="look-capture-dot" aria-hidden="true" />
            <span>{L.capture}</span>
          </button>
          <div className="look-tune">
            <label className="look-field">
              <span className="p-label">{L.fovLabel} <span className="p-data">{vfov.toFixed(0)}°</span></span>
              <input type="range" min={10} max={110} step={1} value={vfov} title={L.fovHelp}
                onChange={(e) => { const v = Number(e.target.value); setVfov(v); writeJson(FOV_KEY, v); }} />
            </label>
            {sensorsLive && (
              <div className="look-align">
                <button type="button" className={`look-btn${aligning ? ' look-btn-primary' : ''}`} aria-pressed={aligning} onClick={() => setAligning((a) => !a)}>
                  {aligning ? L.alignDone : L.align}
                </button>
                {(offset.az !== 0 || offset.alt !== 0) && (
                  <>
                    <span className="p-data look-dim">{L.alignOffset(offset.az.toFixed(1), offset.alt.toFixed(1))}</span>
                    <button type="button" className="look-link" onClick={() => setOffset({ az: 0, alt: 0 })}>{L.alignReset}</button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

