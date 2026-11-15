'use client';

/* eslint-disable @next/next/no-img-element -- in-memory data: URLs and external cut-outs */

import { useMemo, useState } from 'react';
import { useLocale } from '../../lib/i18n';
import { formatDec, formatRa } from '../../lib/prism/coords';
import { PRESETS } from '../../lib/prism/presets';
import { project, type CamBasis, type View } from '../../lib/look/camera';
import { cameraWcs, northOnScreen, type HipsLayer } from '../../lib/look/hips';
import type { SavedPlace } from '../../lib/look/places';
import type { RegionImage } from '../../lib/look/region';
import { eqjToEnu, type M3 } from '../../lib/look/sky';
import { HipsControls, HipsImage, RegionCanvas, RegionPanel, type HipsStatus } from './SpherexViews';

export interface Captured {
  photo: string | null; // JPEG data URL of what the screen showed (never uploaded)
  overlay: string | null; // PNG data URL of the label overlay
  basis: CamBasis;
  view: View;
  m: M3;
  date: Date;
  place: SavedPlace;
  pointed: { ra: number; dec: number; alt: number; az: number };
  sensors: boolean;
  targetId?: string;
}

export default function CaptureResult({ captured, onBack }: { captured: Captured; onBack: () => void }) {
  const { t } = useLocale();
  const L = t.look;
  const { view, basis, m } = captured;
  const [mode, setMode] = useState<'side' | 'blend'>('side');
  const [opacity, setOpacity] = useState(0.6);
  const [labels, setLabels] = useState(true);
  const [layer, setLayer] = useState<HipsLayer>('color');
  const [hips, setHips] = useState<HipsStatus>('loading');
  const [region, setRegion] = useState<RegionImage | null>(null);
  const [pick, setPick] = useState<string | undefined>(captured.targetId);

  const aspect = view.w / view.h;
  const wcs = useMemo(() => {
    const outW = Math.min(1024, Math.round(view.w * Math.min(2, window.devicePixelRatio || 1)));
    const outH = Math.round(outW / aspect);
    return cameraWcs(basis, view, m, outW, outH);
  }, [basis, view, m, aspect]);
  const north = useMemo(() => northOnScreen(basis, m), [basis, m]);
  const rot = Math.atan2(north.x, -north.y) * (180 / Math.PI);

  const target = pick ? PRESETS.find((p) => p.id === pick) : undefined;
  const focus = target ? { ra: target.ra, dec: target.dec } : { ra: captured.pointed.ra, dec: captured.pointed.dec };

  // Inset size: true angular size when it is visible, otherwise magnified to at least 22% of the height.
  const insetPct = region ? Math.max(22, Math.min(60, ((region.fovArcmin / 60) / view.vfov) * 100)) : 22;
  // Inset centre: where the region's centre falls in the captured view (the reticle unless a target was picked).
  const insetAt = useMemo(() => {
    if (!region) return { left: 50, top: 50 };
    const p = project(basis, view, eqjToEnu(m, region.centre.ra, region.centre.dec));
    if (!p || p.x < 0 || p.x > view.w || p.y < 0 || p.y > view.h) return { left: 50, top: 50 };
    return { left: (p.x / view.w) * 100, top: (p.y / view.h) * 100 };
  }, [region, basis, view, m]);
  const insetStyle = (extra?: React.CSSProperties): React.CSSProperties => ({
    ...extra, width: `${insetPct}%`, left: `${insetAt.left}%`, top: `${insetAt.top}%`, transform: `translate(-50%,-50%) rotate(${rot}deg)`,
  });

  const pointedText = `${L.ra} ${formatRa(captured.pointed.ra, 0)} · ${L.dec} ${formatDec(captured.pointed.dec, 0)} · ${L.alt} ${captured.pointed.alt.toFixed(1)}° · ${L.az} ${captured.pointed.az.toFixed(1)}°`;
  const left = captured.photo ?? captured.overlay;
  const leftLabel = captured.photo ? L.yourPhoto : L.yourView;

  return (
    <div className="look-result">
      <div className="look-result-head">
        <div>
          <h2 className="look-h2 p-display">{L.resultTitle}</h2>
          <p className="p-data look-dim">{L.resultPointing(pointedText)}</p>
          <p><span className="look-tag look-tag-computed">{captured.sensors ? L.approxPointing : L.manualPointing}</span></p>
        </div>
        <button type="button" className="look-btn" onClick={onBack}>{L.backToCamera}</button>
      </div>

      <div className="look-result-bar">
        <div className="look-seg" role="group" aria-label={L.viewSide + ' / ' + L.viewBlend}>
          <button type="button" aria-pressed={mode === 'side'} onClick={() => setMode('side')}>{L.viewSide}</button>
          <button type="button" aria-pressed={mode === 'blend'} onClick={() => setMode('blend')}>{L.viewBlend}</button>
        </div>
        {captured.photo && captured.overlay && (
          <label className="look-chip">
            <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} />
            <span>{L.layerStars} · {L.layerPlanets}</span>
          </label>
        )}
        {mode === 'blend' && (
          <label className="look-field look-field-inline">
            <span className="p-label">{L.blend}</span>
            <input type="range" min={0} max={1} step={0.01} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
            <span className="p-data">{Math.round(opacity * 100)}%</span>
          </label>
        )}
      </div>

      {mode === 'side' ? (
        <div className="look-pair">
          <figure className="look-fig">
            <div className="look-frame" style={{ aspectRatio: `${aspect}` }}>
              {left && <img src={left} alt={leftLabel} className="look-fill" />}
              {captured.photo && captured.overlay && labels && <img src={captured.overlay} alt="" className="look-fill" />}
            </div>
            <figcaption className="p-label">{leftLabel}</figcaption>
          </figure>
          <figure className="look-fig">
            <div className="look-frame" style={{ aspectRatio: `${aspect}` }}>
              <HipsImage wcs={wcs} layer={layer} className="look-fill" alt={L.hipsTitle} onStatus={setHips} />
              {hips === 'loading' && <div className="look-frame-msg"><span className="look-spinner" aria-hidden="true" />{L.hipsLoading}</div>}
              {hips === 'failed' && region && (
                <RegionCanvas region={region} className="look-inset" style={insetStyle()} />
              )}
              {hips === 'failed' && !region && <div className="look-frame-msg">{L.hipsFailed}</div>}
              {hips === 'ok' && <span className="look-frame-reticle" aria-hidden="true" />}
            </div>
            <figcaption className="p-label">{L.hipsTitle}</figcaption>
          </figure>
        </div>
      ) : (
        <figure className="look-fig look-fig-wide">
          <div className="look-frame" style={{ aspectRatio: `${aspect}` }}>
            {left && <img src={left} alt={leftLabel} className="look-fill" />}
            <HipsImage wcs={wcs} layer={layer} className="look-fill" style={{ opacity }} alt={L.hipsTitle} onStatus={setHips} />
            {region && (hips === 'failed' || target) && (
              <RegionCanvas region={region} className="look-inset" style={insetStyle({ opacity })} />
            )}
            {captured.photo && captured.overlay && labels && <img src={captured.overlay} alt="" className="look-fill" />}
          </div>
          <figcaption className="p-label">{leftLabel} + {L.spherexLabel}</figcaption>
        </figure>
      )}
      {(hips === 'failed' || target) && region && <p className="look-note">{L.cutoutInset}</p>}

      <HipsControls layer={layer} setLayer={setLayer} status={hips} wcs={wcs} />

      <RegionPanel ra={focus.ra} dec={focus.dec} onRegion={setRegion} onPickTarget={setPick} />
    </div>
  );
}
