'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * SpectralCube3D — SPHEREx frames as stacked textured slices.
 *
 * Every SPHEREx frame sees a given sky position at ONE wavelength (linear
 * variable filters), so a stack of reprojected cutouts is a sparse cube in
 * (x, y, λ) — or, with axis="time", in (x, y, t). Slice positions are true to
 * scale along the chosen axis; nothing is interpolated between frames.
 *
 * Import lazily (three.js is large):
 *   const SpectralCube3D = dynamic(() => import('@/components/cosmos/SpectralCube3D'), { ssr: false })
 */

export interface CubeFrame {
  /** n*n float32, row 0 = North, NaN = invalid (as in /v2/search pixels_b64). */
  pixels: Float32Array;
  n: number;
  lambda_um: number;
  mjd: number;
  season?: number;
  detector?: number;
  id?: string;
  /** Must be true for any non-observational frame; the cube shows a SYNTHETIC badge. */
  synthetic?: boolean;
}

export type CubeAxis = 'lambda' | 'time';

export interface SpectralCube3DProps {
  frames: CubeFrame[];
  /** Index into `frames` of the highlighted slice. */
  current?: number;
  onSelect?: (index: number) => void;
  axis?: CubeAxis;
  onAxisChange?: (axis: CubeAxis) => void;
  /** Show the built-in λ/time toggle. Default true. */
  showAxisToggle?: boolean;
  height?: number | string;
  locale?: 'es' | 'en';
  className?: string;
}

const RAMP: Array<[number, [number, number, number]]> = [
  // 6-stop wavelength ramp from prism-tokens.css (detector centres, µm)
  [0.92, [0x5b, 0x6c, 0xff]],
  [1.36, [0x3f, 0xb6, 0xe8]],
  [2.02, [0x59, 0xd1, 0xa0]],
  [3.12, [0xd9, 0xd4, 0x5b]],
  [4.12, [0xf2, 0x9a, 0x3e]],
  [4.71, [0xe5, 0x53, 0x3d]],
];

export function lambdaColor(um: number): THREE.Color {
  if (um <= RAMP[0][0]) return new THREE.Color(...RAMP[0][1].map((v) => v / 255) as [number, number, number]);
  for (let i = 1; i < RAMP.length; i++) {
    if (um <= RAMP[i][0]) {
      const [l0, c0] = RAMP[i - 1];
      const [l1, c1] = RAMP[i];
      const k = (um - l0) / (l1 - l0);
      return new THREE.Color(...c0.map((v, j) => (v + (c1[j] - v) * k) / 255) as [number, number, number]);
    }
  }
  return new THREE.Color(...RAMP[RAMP.length - 1][1].map((v) => v / 255) as [number, number, number]);
}

/** Per-frame display stretch: asinh between the 1st and 99.5th percentile of finite pixels. */
function frameToRGBA(f: CubeFrame): Uint8Array {
  const { n, pixels } = f;
  const finite: number[] = [];
  const stride = Math.max(1, Math.floor((n * n) / 4000));
  for (let i = 0; i < n * n; i += stride) if (Number.isFinite(pixels[i])) finite.push(pixels[i]);
  finite.sort((a, b) => a - b);
  const lo = finite.length ? finite[Math.floor(finite.length * 0.01)] : 0;
  const hi = finite.length ? finite[Math.min(finite.length - 1, Math.floor(finite.length * 0.995))] : 1;
  const span = hi - lo || 1;
  const soft = 0.08;
  const norm = Math.asinh(1 / soft);
  const out = new Uint8Array(n * n * 4);
  for (let row = 0; row < n; row++) {
    // Texture row 0 is the bottom; data row 0 is North → write flipped so North is up.
    const dst = (n - 1 - row) * n;
    for (let col = 0; col < n; col++) {
      const v = pixels[row * n + col];
      const o = (dst + col) * 4;
      if (!Number.isFinite(v)) {
        out[o] = 0x2b;
        out[o + 1] = 0x3d;
        out[o + 2] = 0x5b;
        out[o + 3] = 255;
        continue;
      }
      const x = Math.min(1, Math.max(0, (v - lo) / span));
      const g = Math.round((Math.asinh(x / soft) / norm) * 255);
      out[o] = g;
      out[o + 1] = Math.round(g * 0.97);
      out[o + 2] = Math.round(g * 0.93);
      out[o + 3] = 255;
    }
  }
  return out;
}

const TXT = {
  es: { lambda: 'λ', time: 'tiempo', axis: 'Eje', synthetic: 'SINTÉTICO — no son observaciones', frames: 'cortes', hint: 'arrastra para girar · clic elige un corte · ← → recorre' },
  en: { lambda: 'λ', time: 'time', axis: 'Axis', synthetic: 'SYNTHETIC — not observations', frames: 'slices', hint: 'drag to orbit · click picks a slice · ← → steps' },
};

const AXIS_LEN = 3.2;

export default function SpectralCube3D({
  frames,
  current = 0,
  onSelect,
  axis: axisProp,
  onAxisChange,
  showAxisToggle = true,
  height = 420,
  locale = 'es',
  className,
}: SpectralCube3DProps) {
  const t = TXT[locale];
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const [axisState, setAxisState] = useState<CubeAxis>('lambda');
  const axis = axisProp ?? axisState;
  const setAxis = (a: CubeAxis) => {
    if (onAxisChange) onAxisChange(a);
    if (axisProp === undefined) setAxisState(a);
  };
  const synthetic = frames.some((f) => f.synthetic);

  const ctx = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    stack: THREE.Group;
    slices: { mesh: THREE.Mesh; edge: THREE.LineLoop; tex: THREE.DataTexture }[];
    labels: { el: HTMLDivElement; pos: THREE.Vector3 }[];
    render: () => void;
  } | null>(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // Axis mapping (true scale).
  const mapping = useMemo(() => {
    const vals = frames.map((f) => (axis === 'lambda' ? f.lambda_um : f.mjd));
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    if (!Number.isFinite(min)) { min = 0; max = 1; }
    if (max - min < 1e-9) { min -= 0.5; max += 0.5; }
    const pos = (v: number) => ((v - min) / (max - min) - 0.5) * AXIS_LEN;
    return { min, max, pos, vals };
  }, [frames, axis]);

  // ---------- init renderer once ----------
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setClearColor(0x0b0a09, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
    camera.position.set(2.6, 1.5, 4.2);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    controls.enablePan = false;
    controls.minDistance = 2;
    controls.maxDistance = 12;
    const stack = new THREE.Group();
    scene.add(stack);

    let raf = 0;
    const render = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        renderer.render(scene, camera);
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        const v = new THREE.Vector3();
        for (const l of ctx.current?.labels ?? []) {
          v.copy(l.pos).project(camera);
          const vis = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
          l.el.style.opacity = vis ? '1' : '0';
          l.el.style.transform = `translate3d(${((v.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * h).toFixed(1)}px, 0)`;
        }
      });
    };
    controls.addEventListener('change', render);

    const resize = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const ray = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const r = canvas.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hits = ray.intersectObjects(ctx.current?.slices.map((s) => s.mesh) ?? []);
      if (hits[0]) onSelectRef.current?.(hits[0].object.userData.index as number);
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);

    ctx.current = { renderer, scene, camera, controls, stack, slices: [], labels: [], render };
    resize();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.MeshBasicMaterial | undefined;
        mat?.map?.dispose();
        mat?.dispose?.();
      });
      renderer.dispose();
      ctx.current = null;
    };
  }, []);

  // ---------- (re)build slices when frames change ----------
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    for (const s of c.slices) {
      c.stack.remove(s.mesh, s.edge);
      s.mesh.geometry.dispose();
      (s.mesh.material as THREE.Material).dispose();
      s.tex.dispose();
      s.edge.geometry.dispose();
      (s.edge.material as THREE.Material).dispose();
    }
    c.slices = frames.map((f, i) => {
      const tex = new THREE.DataTexture(frameToRGBA(f), f.n, f.n, THREE.RGBAFormat);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
      );
      mesh.rotation.y = Math.PI / 2; // face along the X (λ / time) axis
      mesh.userData.index = i;
      const pts = [new THREE.Vector3(0, -0.5, -0.5), new THREE.Vector3(0, 0.5, -0.5), new THREE.Vector3(0, 0.5, 0.5), new THREE.Vector3(0, -0.5, 0.5)];
      const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: lambdaColor(f.lambda_um), transparent: true }));
      c.stack.add(mesh, edge);
      return { mesh, edge, tex };
    });
    c.render();
  }, [frames]);

  // ---------- layout along axis + highlight + axis labels ----------
  useEffect(() => {
    const c = ctx.current;
    const layer = labelsRef.current;
    if (!c || !layer) return;
    c.slices.forEach((s, i) => {
      const x = mapping.pos(mapping.vals[i]);
      const isCur = i === current;
      s.mesh.position.x = x;
      s.edge.position.x = x + (isCur ? 0.001 : 0);
      const m = s.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = isCur ? 1 : 0.16;
      s.mesh.renderOrder = isCur ? 2 : 1;
      const em = s.edge.material as THREE.LineBasicMaterial;
      em.color = isCur ? new THREE.Color(0xff5a1f) : lambdaColor(frames[i]?.lambda_um ?? 1);
      em.opacity = isCur ? 1 : 0.55;
    });

    // Axis line + ticks
    const old = c.scene.getObjectByName('cube-axis');
    if (old) {
      c.scene.remove(old);
      (old as THREE.LineSegments).geometry.dispose();
    }
    const segs: number[] = [-AXIS_LEN / 2 - 0.1, -0.62, 0.62, AXIS_LEN / 2 + 0.1, -0.62, 0.62];
    for (const l of c.labels) l.el.remove();
    c.labels = [];
    const addLabel = (text: string, pos: THREE.Vector3, cls = '') => {
      const el = document.createElement('div');
      el.className = `sc-lbl ${cls}`;
      el.textContent = text;
      layer.appendChild(el);
      c.labels.push({ el, pos });
    };
    const span = mapping.max - mapping.min;
    let step: number;
    let fmt: (v: number) => string;
    if (axis === 'lambda') {
      step = span > 2 ? 0.5 : span > 0.8 ? 0.2 : span > 0.3 ? 0.1 : 0.05;
      fmt = (v) => v.toFixed(step < 0.1 ? 2 : step < 0.5 ? 1 : 1);
    } else {
      step = span > 400 ? 90 : span > 120 ? 30 : span > 30 ? 10 : span > 8 ? 2 : 0.5;
      fmt = (v) => new Date((v - 40587) * 86400000).toISOString().slice(0, 10);
    }
    for (let v = Math.ceil(mapping.min / step) * step; v <= mapping.max + 1e-9; v += step) {
      const x = mapping.pos(v);
      segs.push(x, -0.62, 0.62, x, -0.68, 0.62);
      if (axis === 'lambda' || c.labels.length < 6) addLabel(fmt(v), new THREE.Vector3(x, -0.74, 0.62));
    }
    addLabel(axis === 'lambda' ? 'λ [µm]' : 'MJD → UTC', new THREE.Vector3(AXIS_LEN / 2 + 0.2, -0.62, 0.62), 'sc-unit');
    addLabel('N', new THREE.Vector3(mapping.pos(mapping.vals[current] ?? mapping.min), 0.6, 0), 'sc-n');
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    const axisLine = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x6d6961 }));
    axisLine.name = 'cube-axis';
    c.scene.add(axisLine);
    c.render();
  }, [mapping, current, axis, frames]);

  const cur = frames[current];
  const onKey = (e: React.KeyboardEvent) => {
    if (!onSelect || !frames.length) return;
    // Step in axis order, not array order.
    const order = frames.map((_, i) => i).sort((a, b) => mapping.vals[a] - mapping.vals[b]);
    const k = order.indexOf(current);
    if (e.key === 'ArrowRight' && k < order.length - 1) onSelect(order[k + 1]);
    else if (e.key === 'ArrowLeft' && k > 0) onSelect(order[k - 1]);
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={wrapRef}
      className={`sc-root${className ? ' ' + className : ''}`}
      style={{ height }}
      tabIndex={0}
      onKeyDown={onKey}
      role="group"
      aria-label={`SpectralCube3D · ${frames.length} ${t.frames}`}
    >
      <canvas ref={canvasRef} className="sc-canvas" />
      <div ref={labelsRef} className="sc-labels" aria-hidden="true" />
      <div className="sc-hud">
        {showAxisToggle && (
          <div className="sc-seg" role="group" aria-label={t.axis}>
            <button type="button" aria-pressed={axis === 'lambda'} onClick={() => setAxis('lambda')}>{t.lambda}</button>
            <button type="button" aria-pressed={axis === 'time'} onClick={() => setAxis('time')}>{t.time}</button>
          </div>
        )}
        {cur && (
          <div className="sc-cur" aria-live="polite">
            <span style={{ color: `#${lambdaColor(cur.lambda_um).getHexString()}` }}>■</span> {cur.lambda_um.toFixed(3)} µm
            {cur.detector ? ` · D${cur.detector}` : ''} · MJD {cur.mjd.toFixed(2)}
            {cur.season !== undefined ? ` · S${cur.season}` : ''}
          </div>
        )}
      </div>
      {synthetic && <div className="sc-synth">{t.synthetic}</div>}
      <div className="sc-hint">{t.hint}</div>
      <style>{CUBE_CSS}</style>
    </div>
  );
}

const CUBE_CSS = `
.sc-root{position:relative;background:var(--p-bg,#0b0a09);border:1px solid var(--p-rule,#2a2825);border-radius:var(--p-r,2px);overflow:hidden;color:var(--p-ink,#ece8e1);font-family:var(--p-font-data,ui-monospace,monospace);}
.sc-root:focus-visible{outline:1px solid var(--p-signal,#ff5a1f);outline-offset:2px;}
.sc-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab;}
.sc-labels{position:absolute;inset:0;pointer-events:none;}
.sc-lbl{position:absolute;left:0;top:0;opacity:0;font-size:10px;color:var(--p-ink-3,#6d6961);white-space:nowrap;margin:0 0 0 -14px;}
.sc-lbl.sc-unit{color:var(--p-ink-2,#a8a39a);margin:-6px 0 0 4px;}
.sc-lbl.sc-n{color:var(--p-ink-2,#a8a39a);margin:-14px 0 0 -3px;}
.sc-hud{position:absolute;left:10px;top:10px;right:10px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:11px;pointer-events:none;}
.sc-hud>*{pointer-events:auto;}
.sc-seg{display:flex;border:1px solid var(--p-rule-2,#3a3733);}
.sc-root .sc-seg button{font:inherit;font-size:11px;padding:3px 10px;background:none;color:var(--p-ink-2,#a8a39a);border:0;border-radius:0;cursor:pointer;min-height:0;}
.sc-root .sc-seg button+button{border-left:1px solid var(--p-rule-2,#3a3733);}
.sc-root .sc-seg button[aria-pressed=true]{background:var(--p-ink,#ece8e1);color:var(--p-bg,#0b0a09);border-color:var(--p-rule-2,#3a3733);}
.sc-cur{color:var(--p-ink,#ece8e1);font-feature-settings:"tnum" 1;}
.sc-synth{position:absolute;right:0;top:0;background:var(--p-warn,#e2b54a);color:#120c00;font-size:10.5px;letter-spacing:.08em;padding:4px 8px;}
.sc-hint{position:absolute;left:10px;bottom:8px;font-size:10px;color:var(--p-ink-3,#6d6961);}
`;
