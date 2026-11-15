/**
 * SkyEngine: the three.js planetarium behind /sky.
 *
 * Frames
 *   EQJ   astronomy-engine's J2000 mean equator (x → RA 0h, z → north pole). Stars, planets,
 *         trails, constellations and targets live in `skyGroup` in EQJ coordinates.
 *   HOR   astronomy-engine's horizontal frame (x north, y west, z zenith).
 *   scene three.js world: +Y zenith, −Z north, +X east (camera at the origin).
 * Every frame `skyGroup.matrix` = (HOR → scene) · Rotation_EQJ_HOR(time, observer), which carries
 * precession, nutation and Earth rotation. Proper motion is applied to star vectors on the CPU.
 *
 * Everything drawn here is COMPUTED (ephemeris + proper-motion model), never SPHEREx data.
 */
import * as THREE from 'three';
import * as Astro from 'astronomy-engine';
import { StereoEffect } from 'three/examples/jsm/effects/StereoEffect.js';
import type { SkyCatalog } from './catalog';
import { starName, starVectorAt } from './catalog';
import { STAR_NAMES } from './names';
import { FAST_STAR_HR, SKY_TARGETS, targetVectorAt, type SkyTarget } from './targets';
import { HISTORIC_MARKS, MAX_MS, MIN_MS, MS_DAY, MS_YEAR, clampTime, formatTick, julianYear, yearsSinceJ2000 } from './time';
import {
  SKY_BAND_CENTERS_UM,
  bvToTemperature,
  cachedBlackbody,
  hasVisibleSkyListeners,
  publishVisibleSky,
  registerVisibleSkyProvider,
  type SkyBand,
  type VisibleSkyInfo,
} from './bands';
import { OrientationLook } from './orientation';

export const BODY_IDS = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'] as const;
export type BodyId = (typeof BODY_IDS)[number];

export interface SkyLayers {
  ground: boolean;
  atmosphere: boolean;
  grid: boolean;
  cardinals: boolean;
  constellations: boolean;
  labels: boolean;
  trails: boolean;
  targets: boolean;
}

export const DEFAULT_LAYERS: SkyLayers = {
  ground: true,
  atmosphere: true,
  grid: false,
  cardinals: true,
  constellations: true,
  labels: true,
  trails: false,
  targets: true,
};

export interface SkyNames {
  bodies: Record<BodyId, string>;
  cardinals: { N: string; E: string; S: string; W: string };
  ncp: string;
  scp: string;
  marks: Record<string, string>;
}

export interface SelectionInfo {
  key: string;
  kind: 'star' | 'body' | 'target' | 'mark';
  id: string;
  name: string;
  vmag: number | null;
  /** RA/Dec of date (precessed + proper motion), degrees. */
  raDate: number;
  decDate: number;
  /** J2000 (ICRS) frame, position propagated to 2025.5 (SPHEREx survey epoch); used for the explorer link. */
  raLink: number;
  decLink: number;
  alt: number;
  az: number;
  /** Total proper motion, arcsec/yr (stars, targets). */
  pm: number | null;
  hr: number | null;
  /** Bodies only. */
  distAu: number | null;
  phase: number | null; // illuminated fraction 0..1
  moonPhaseIndex: number | null; // 0 new … 4 full … 7 waning crescent
  /** Explorer target id when the object is a challenge target. */
  targetId: string | null;
}

export interface EngineCallbacks {
  onTime?: (ms: number, playing: boolean) => void;
  onSelect?: (info: SelectionInfo | null) => void;
  onLook?: (az: number, alt: number, fov: number) => void;
  onModeChange?: (mode: 'normal' | 'motion' | 'cardboard' | 'xr') => void;
}

const R = 100;
const D = Math.PI / 180;
const TRAIL_SAMPLES = 241;
const TICKS = [0, 60, 120, 180, 240];
const LINK_YEAR = 2025.5;
const SIDEREAL_DAY_MS = 86_164_090.5;
/** Simulated seconds per real second from which the sidereal lock applies (1 day/s). */
export const SIDEREAL_LOCK_RATE = 86_400;

const BODY_STYLE: Record<BodyId, { color: number; base: number }> = {
  Sun: { color: 0xfff1d6, base: 26 },
  Moon: { color: 0xe8e2d6, base: 0 },
  Mercury: { color: 0xc9c2b6, base: 5 },
  Venus: { color: 0xfff3dc, base: 8 },
  Mars: { color: 0xe8805c, base: 6 },
  Jupiter: { color: 0xf0e2c4, base: 8 },
  Saturn: { color: 0xe6d29c, base: 7 },
  Uranus: { color: 0xa9d6d8, base: 4.5 },
  Neptune: { color: 0x8fa8e6, base: 4.5 },
};

const TRAIL_COLOR: Record<string, number> = {
  Sun: 0xe2b54a,
  Moon: 0xece8e1,
  Mercury: 0xa8a39a,
  Venus: 0xf2e6c8,
  Mars: 0xe0644f,
  Jupiter: 0xd9c9a3,
  Saturn: 0xcdb77a,
  Uranus: 0x8fc4c6,
  Neptune: 0x7f97d6,
};

const STAR_VERT = /* glsl */ `
  attribute float size;
  attribute vec3 color;
  uniform float uScale;
  uniform float uDim;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float s = size * uScale;
    vAlpha = clamp(0.5 + s * 0.1, 0.5, 1.0) * uDim;
    gl_PointSize = max(s, 2.2) * uPixelRatio;
    vColor = color;
  }
`;
const STAR_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    if (d > 1.0) discard;
    float core = smoothstep(0.8, 0.0, d);
    float halo = smoothstep(1.0, 0.3, d) * 0.45;
    gl_FragColor = vec4(vColor, (core + halo) * vAlpha);
  }
`;
const RING_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float ring = smoothstep(0.78, 0.86, d) * (1.0 - smoothstep(0.92, 1.0, d));
    if (ring < 0.02) discard;
    gl_FragColor = vec4(uColor, ring * uAlpha);
  }
`;
const RING_VERT = /* glsl */ `
  uniform float uSize;
  uniform float uPixelRatio;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uSize * uPixelRatio;
  }
`;

const magToSize = (v: number) => 1.0 + 8.0 * Math.pow(10, -0.4 * v * 0.33);

type LabelItem = { key: string; text: string; x: number; y: number; z: number; frame: 'sky' | 'hor'; cls: string };

interface Trail {
  key: string;
  line: THREE.Line;
  ticks: THREE.Points;
  tickTimes: number[];
  tickVecs: number[][];
  span: number;
}

export class SkyEngine {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private skyGroup = new THREE.Group();
  private horGroup = new THREE.Group();
  private stereo: StereoEffect | null = null;
  private orient = new OrientationLook();
  private mode: 'normal' | 'motion' | 'cardboard' | 'xr' = 'normal';

  private cat: SkyCatalog;
  private starGeom = new THREE.BufferGeometry();
  private starMat: THREE.ShaderMaterial;
  private starPos: Float32Array;
  private starVecNow: Float64Array; // propagated EQJ unit vectors
  private pmYear = NaN;

  private constGeom: THREE.BufferGeometry | null = null;
  private constLines: THREE.LineSegments | null = null;
  private constPairs: Uint16Array | null = null;

  private bodyGeom = new THREE.BufferGeometry();
  private bodyMat: THREE.ShaderMaterial;
  private bodyPoints: THREE.Points;
  private bodyVec: Record<string, number[]> = {};
  private bodyMag: Record<string, number> = {};
  private bodyDist: Record<string, number> = {};
  private magStamp = -Infinity;
  private moon: THREE.Mesh;
  private sunLight = new THREE.DirectionalLight(0xffffff, 2.6);

  private targetGeom = new THREE.BufferGeometry();
  private targetPoints: THREE.Points;
  private targetVec: Record<string, number[]> = {};
  private markVec: Record<string, number[]> = {};

  private selGeom = new THREE.BufferGeometry();
  private selPoints: THREE.Points;
  private selection: string | null = null;
  private pendingLook: string | null = null;

  private ground: THREE.Mesh;
  private horizonLine: THREE.LineLoop;
  private grid: THREE.LineSegments;

  private trails: Trail[] = [];
  private trailCenter = NaN;
  private trailSpan = 0;
  private trailGroup = new THREE.Group();

  private labelsEl: HTMLElement;
  private labelEls = new Map<string, HTMLSpanElement>();
  private names: SkyNames;

  private observer = new Astro.Observer(19.4326, -99.1332, 2240);
  private lat = 19.4326;
  private lon = -99.1332;
  private time = Date.now();
  private rate = 1;
  private playing = false;
  private lastRotTime = NaN;
  /** Anchor of the sidereal lock used at >= 1 day/s (see rotTime). */
  private rotAnchor = Date.now();
  private lastBodyTime = NaN;
  private rotDirty = true;
  private sunAlt = -90;

  private az = 180;
  private alt = 25;
  private fov = 70;
  private tween: { from: [number, number]; to: [number, number]; t0: number; dur: number } | null = null;
  private layers: SkyLayers = { ...DEFAULT_LAYERS };
  private insets = { top: 0, bottom: 0, left: 0, right: 0 };

  private cb: EngineCallbacks;
  private lastTick = 0;
  private lastInfoEmit = 0;
  private lastBandEmit = 0;
  private lastLookEmit = 0;
  private prevFrame = performance.now();
  private disposed = false;
  /** Something changed since the last render (idle frames are skipped to save CPU). */
  private dirty = true;
  private lastRender = 0;
  private infoPending = false;
  private bandsPending = false;
  private lastLook = [-999, -999, -999];
  private unregisterBands: () => void;
  private ro: ResizeObserver;
  private tmpV = new THREE.Vector3();
  private tmpM = new THREE.Matrix4();

  constructor(canvas: HTMLCanvasElement, labelsEl: HTMLElement, cat: SkyCatalog, names: SkyNames, cb: EngineCallbacks) {
    this.cat = cat;
    this.names = names;
    this.cb = cb;
    this.labelsEl = labelsEl;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local');
    this.renderer.setClearColor(0x0b0a09, 1);

    this.camera = new THREE.PerspectiveCamera(this.fov, 1, 0.1, 1000);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.skyGroup.matrixAutoUpdate = false;
    this.scene.add(this.skyGroup);
    this.scene.add(this.horGroup);
    this.skyGroup.add(this.trailGroup);

    // ---- stars
    const n = cat.n;
    this.starPos = new Float32Array(n * 3);
    this.starVecNow = new Float64Array(n * 3);
    const sizes = new Float32Array(n);
    for (let i = 0; i < n; i++) sizes[i] = magToSize(cat.vmag[i]);
    this.starGeom.setAttribute('position', new THREE.BufferAttribute(this.starPos, 3));
    this.starGeom.setAttribute('color', new THREE.BufferAttribute(cat.rgb, 3));
    this.starGeom.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    this.starGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R * 1.01);
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: { uScale: { value: 1 }, uDim: { value: 1 }, uPixelRatio: { value: this.renderer.getPixelRatio() } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const stars = new THREE.Points(this.starGeom, this.starMat);
    stars.frustumCulled = false;
    stars.renderOrder = 2;
    this.skyGroup.add(stars);

    // ---- bodies (Sun + planets as points; Moon as a lit sphere so the phase is physical)
    const nb = BODY_IDS.length;
    this.bodyGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nb * 3), 3));
    const bc = new Float32Array(nb * 3);
    BODY_IDS.forEach((b, i) => {
      const c = new THREE.Color(BODY_STYLE[b].color);
      bc.set([c.r, c.g, c.b], i * 3);
    });
    this.bodyGeom.setAttribute('color', new THREE.BufferAttribute(bc, 3));
    this.bodyGeom.setAttribute('size', new THREE.BufferAttribute(new Float32Array(nb), 1));
    this.bodyMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: { uScale: { value: 1 }, uDim: { value: 1 }, uPixelRatio: { value: this.renderer.getPixelRatio() } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.bodyPoints = new THREE.Points(this.bodyGeom, this.bodyMat);
    this.bodyPoints.frustumCulled = false;
    this.bodyPoints.renderOrder = 4;
    this.skyGroup.add(this.bodyPoints);

    // Moon: angular diameter drawn at 2° (≈4× real) so the phase reads; labelled "enlarged".
    const moonR = R * 0.95 * Math.tan(1.0 * D);
    this.moon = new THREE.Mesh(
      new THREE.SphereGeometry(moonR, 48, 32),
      new THREE.MeshLambertMaterial({ color: 0xd9d3c7, emissive: 0x0b0a09 }),
    );
    this.moon.renderOrder = 5;
    this.skyGroup.add(this.moon);
    this.skyGroup.add(this.sunLight);
    this.skyGroup.add(this.sunLight.target);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.035)); // earthshine, barely

    // ---- targets (challenge stars) and selection ring
    this.targetGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SKY_TARGETS.length + HISTORIC_MARKS.length) * 3), 3));
    this.targetPoints = new THREE.Points(
      this.targetGeom,
      new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        uniforms: { uColor: { value: new THREE.Color(0xff5a1f) }, uAlpha: { value: 0.95 }, uSize: { value: 18 }, uPixelRatio: { value: this.renderer.getPixelRatio() } },
        transparent: true,
        depthWrite: false,
      }),
    );
    this.targetPoints.frustumCulled = false;
    this.targetPoints.renderOrder = 6;
    this.skyGroup.add(this.targetPoints);

    this.selGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.selPoints = new THREE.Points(
      this.selGeom,
      new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        uniforms: { uColor: { value: new THREE.Color(0xece8e1) }, uAlpha: { value: 1 }, uSize: { value: 30 }, uPixelRatio: { value: this.renderer.getPixelRatio() } },
        transparent: true,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.selPoints.frustumCulled = false;
    this.selPoints.visible = false;
    this.selPoints.renderOrder = 9;
    this.skyGroup.add(this.selPoints);

    // ---- horizon-fixed: ground, horizon line, alt-az grid
    this.ground = new THREE.Mesh(
      new THREE.SphereGeometry(R * 0.9, 64, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x100e0c, side: THREE.BackSide }),
    );
    this.ground.renderOrder = 1;
    this.horGroup.add(this.ground);

    const hz: number[] = [];
    for (let k = 0; k < 256; k++) {
      const a = (k / 256) * Math.PI * 2;
      hz.push(Math.sin(a) * R * 0.89, 0, -Math.cos(a) * R * 0.89);
    }
    const hzGeom = new THREE.BufferGeometry();
    hzGeom.setAttribute('position', new THREE.Float32BufferAttribute(hz, 3));
    this.horizonLine = new THREE.LineLoop(hzGeom, new THREE.LineBasicMaterial({ color: 0x6d6961, transparent: true, opacity: 0.9 }));
    this.horGroup.add(this.horizonLine);

    const gridPts: number[] = [];
    const dirOf = (azD: number, altD: number, r: number) => [
      Math.sin(azD * D) * Math.cos(altD * D) * r,
      Math.sin(altD * D) * r,
      -Math.cos(azD * D) * Math.cos(altD * D) * r,
    ];
    for (let altD = 15; altD < 90; altD += 15) {
      for (let a = 0; a < 360; a += 3) gridPts.push(...dirOf(a, altD, R * 0.95), ...dirOf(a + 3, altD, R * 0.95));
    }
    for (let a = 0; a < 360; a += 30) {
      for (let altD = 0; altD < 84; altD += 3) gridPts.push(...dirOf(a, altD, R * 0.95), ...dirOf(a, altD + 3, R * 0.95));
    }
    const gGeom = new THREE.BufferGeometry();
    gGeom.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
    this.grid = new THREE.LineSegments(gGeom, new THREE.LineBasicMaterial({ color: 0x3a5a66, transparent: true, opacity: 0.55 }));
    this.grid.visible = false;
    this.horGroup.add(this.grid);

    this.unregisterBands = registerVisibleSkyProvider(() => this.computeVisibleBands());

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement ?? canvas);
    this.resize();

    this.renderer.xr.addEventListener('sessionstart', () => this.setMode('xr'));
    this.renderer.xr.addEventListener('sessionend', () => this.setMode('normal'));
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ------------------------------------------------------------------ public API

  setConstellations(pairs: Uint16Array): void {
    this.dirty = true;
    this.constPairs = pairs;
    this.constGeom = new THREE.BufferGeometry();
    this.constGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pairs.length * 3), 3));
    this.constLines = new THREE.LineSegments(
      this.constGeom,
      new THREE.LineBasicMaterial({ color: 0x8f8a81, transparent: true, opacity: 0.24, depthWrite: false }),
    );
    this.constLines.frustumCulled = false;
    this.constLines.renderOrder = 1.5;
    this.constLines.visible = this.layers.constellations;
    this.skyGroup.add(this.constLines);
    this.pmYear = NaN; // refill positions
  }

  setNames(names: SkyNames): void {
    this.dirty = true;
    this.names = names;
    this.labelEls.forEach((el) => el.remove());
    this.labelEls.clear();
  }

  /** Local offset (hours) used for trail tick labels; null = longitude rule. */
  private tzOffset: number | null = null;
  setTzOffset(hours: number): void {
    this.tzOffset = hours;
  }

  setLocation(lat: number, lon: number): void {
    this.dirty = true;
    this.lat = lat;
    this.lon = lon;
    this.observer = new Astro.Observer(lat, lon, 0);
    this.rotDirty = true;
    this.lastBodyTime = NaN;
  }

  setTime(ms: number): void {
    this.dirty = true;
    this.time = clampTime(ms);
    this.rotAnchor = this.time;
    this.rotDirty = true;
    this.cb.onTime?.(this.time, this.playing);
  }

  getTime(): number {
    return this.time;
  }

  setRate(rate: number): void {
    const wasLocked = this.locked;
    const shown = this.rotTime();
    this.rate = rate;
    if (wasLocked && !this.locked) this.time = shown;
    this.rotAnchor = wasLocked ? shown : this.time;
  }

  setPlaying(p: boolean): void {
    this.dirty = true;
    if (!p && this.locked) this.time = this.rotTime(); // pause on the instant that is on screen
    this.rotAnchor = this.time;
    this.playing = p;
    this.prevFrame = performance.now();
    this.cb.onTime?.(this.time, this.playing);
  }

  setLayers(l: SkyLayers): void {
    this.dirty = true;
    const trailsChanged = l.trails !== this.layers.trails;
    this.layers = { ...l };
    this.ground.visible = l.ground;
    this.grid.visible = l.grid;
    if (this.constLines) this.constLines.visible = l.constellations;
    this.targetPoints.visible = l.targets;
    this.trailGroup.visible = l.trails;
    if (trailsChanged) this.trailCenter = NaN;
  }

  /** Point the view at an azimuth/altitude (degrees), animated unless `instant`. */
  look(az: number, alt: number, instant = false): void {
    this.dirty = true;
    const to: [number, number] = [az, Math.max(-85, Math.min(89, alt))];
    if (instant) {
      this.tween = null;
      [this.az, this.alt] = to;
      return;
    }
    let daz = ((to[0] - this.az + 540) % 360) - 180;
    if (Math.abs(daz) < 1e-6) daz = 0;
    this.tween = { from: [this.az, this.alt], to: [this.az + daz, to[1]], t0: performance.now(), dur: 900 };
  }

  pan(dAz: number, dAlt: number): void {
    this.dirty = true;
    this.tween = null;
    this.az = (((this.az + dAz) % 360) + 360) % 360;
    this.alt = Math.max(-85, Math.min(89, this.alt + dAlt));
  }

  zoom(factor: number): void {
    this.dirty = true;
    this.fov = Math.max(12, Math.min(110, this.fov * factor));
  }

  getView(): { az: number; alt: number; fov: number } {
    return { az: this.az, alt: this.alt, fov: this.fov };
  }

  /** Drag-to-look in screen pixels (moves the sky with the pointer). */
  dragBy(dx: number, dy: number): void {
    const h = this.renderer.domElement.clientHeight || 1;
    const k = this.fov / h;
    this.pan(-dx * k, dy * k);
  }

  /** Select by key ("star:Thuban", "star#123", "body:Mars", "target:barnard", "mark:sn1054"). */
  select(key: string | null, lookAt = false): void {
    this.dirty = true;
    if (key && key.startsWith('star:')) {
      const name = key.slice(5);
      const hr = Number(Object.keys(STAR_NAMES).find((h) => STAR_NAMES[Number(h)].name === name));
      const idx = hr ? this.cat.hr.indexOf(hr) : -1;
      key = idx >= 0 ? `star#${idx}` : null;
    }
    this.selection = key;
    this.updateSelectionMarker();
    // Look on the next frame, after time/place changes made in the same tick are applied.
    this.pendingLook = key && lookAt ? key : null;
    this.emitInfo(true);
  }

  /** Pick the nearest object to a canvas pixel. */
  pick(px: number, py: number): void {
    const el = this.renderer.domElement;
    const w = el.clientWidth, h = el.clientHeight;
    this.skyGroup.updateMatrixWorld();
    const m = this.skyGroup.matrixWorld;
    let best: string | null = null;
    let bestScore = Infinity;
    const consider = (key: string, v: ArrayLike<number>, radiusPx: number, bonus: number) => {
      this.tmpV.set(v[0], v[1], v[2]).multiplyScalar(R).applyMatrix4(m);
      if (this.layers.ground && this.tmpV.y < -0.5) return;
      this.tmpV.project(this.camera);
      if (this.tmpV.z > 1 || this.tmpV.z < -1) return;
      const sx = (this.tmpV.x * 0.5 + 0.5) * w;
      const sy = (-this.tmpV.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - px, sy - py);
      if (d > radiusPx) return;
      const score = d - bonus;
      if (score < bestScore) {
        bestScore = score;
        best = key;
      }
    };
    for (const b of BODY_IDS) if (this.bodyVec[b]) consider(`body:${b}`, this.bodyVec[b], 26, 14);
    if (this.layers.targets) {
      for (const t of SKY_TARGETS) if (this.targetVec[t.id]) consider(`target:${t.id}`, this.targetVec[t.id], 22, 12);
      for (const k of Object.keys(this.markVec)) consider(`mark:${k}`, this.markVec[k], 22, 12);
    }
    const v3 = [0, 0, 0];
    for (let i = 0; i < this.cat.n; i++) {
      v3[0] = this.starVecNow[i * 3];
      v3[1] = this.starVecNow[i * 3 + 1];
      v3[2] = this.starVecNow[i * 3 + 2];
      consider(`star#${i}`, v3, 18, Math.max(0, 6 - this.cat.vmag[i]) * 1.5);
    }
    this.select(best);
  }

  /** Magic-window look-around with the phone's motion sensors. */
  setMotion(on: boolean): void {
    if (on) {
      this.orient.start();
      this.setMode('motion');
    } else {
      this.orient.stop();
      this.setMode('normal');
    }
  }

  get headingAbsolute(): boolean {
    return this.orient.absolute;
  }

  /** Cardboard: side-by-side stereo + motion sensors. */
  setCardboard(on: boolean): void {
    if (on) {
      if (!this.stereo) this.stereo = new StereoEffect(this.renderer);
      this.orient.start();
      this.setMode('cardboard');
    } else {
      this.orient.stop();
      this.setMode('normal');
    }
    this.resize();
    // Fullscreen and orientation changes settle a few frames later on phones.
    for (const ms of [120, 400, 900]) setTimeout(() => { if (!this.disposed) this.resize(); }, ms);
  }

  /** WebXR immersive-vr session (Quest browser, etc.). Same session flow as three's VRButton. */
  async enterXR(): Promise<boolean> {
    const xr = (navigator as Navigator & { xr?: { requestSession: (m: string, o: object) => Promise<XRSession> } }).xr;
    if (!xr) return false;
    try {
      const session = await xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'layers'] });
      await this.renderer.xr.setSession(session);
      return true;
    } catch {
      return false;
    }
  }

  exitXR(): void {
    this.renderer.xr.getSession()?.end();
  }

  get currentMode() {
    return this.mode;
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.orient.stop();
    this.ro.disconnect();
    this.unregisterBands();
    this.labelEls.forEach((el) => el.remove());
    this.labelEls.clear();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.renderer.dispose();
  }

  // ------------------------------------------------------------------ internals

  private setMode(m: 'normal' | 'motion' | 'cardboard' | 'xr') {
    this.dirty = true;
    this.mode = m;
    this.labelsEl.style.display = m === 'cardboard' || m === 'xr' ? 'none' : '';
    this.cb.onModeChange?.(m);
  }

  private resize() {
    this.dirty = true;
    const el = this.renderer.domElement;
    const parent = el.parentElement;
    const w = parent?.clientWidth || window.innerWidth;
    const h = parent?.clientHeight || window.innerHeight;
    if (this.renderer.xr.isPresenting) return;
    this.renderer.setSize(w, h, false);
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    if (this.stereo) this.stereo.setSize(w, h);
    const ins = this.insets;
    if (this.mode === 'cardboard' || (!ins.top && !ins.bottom && !ins.left && !ins.right)) {
      this.camera.clearViewOffset();
      this.camera.aspect = this.mode === 'cardboard' ? w / 2 / h : w / h;
    } else {
      // Put the optical centre in the middle of the unobstructed area (between the header,
      // the time dock and the side panel) by rendering a shifted window of a larger frustum.
      const dx = Math.abs(ins.right - ins.left);
      const dy = Math.abs(ins.bottom - ins.top);
      const W = w + dx, H = h + dy;
      this.camera.aspect = W / H;
      this.camera.setViewOffset(W, H, ins.right > ins.left ? dx : 0, ins.bottom > ins.top ? dy : 0, w, h);
    }
    this.camera.updateProjectionMatrix();
  }

  /** Pixels of the canvas covered by UI on each side (header, dock, panel). */
  setViewInsets(top: number, bottom: number, left = 0, right = 0): void {
    const r = (v: number) => Math.max(0, Math.round(v));
    this.insets = { top: r(top), bottom: r(bottom), left: r(left), right: r(right) };
    this.resize();
  }

  private horOf(v: ArrayLike<number>): { alt: number; az: number } {
    this.tmpV.set(v[0], v[1], v[2]).applyMatrix4(this.skyGroup.matrix);
    const n = this.tmpV.length() || 1;
    const alt = Math.asin(Math.max(-1, Math.min(1, this.tmpV.y / n))) / D;
    let az = Math.atan2(this.tmpV.x, -this.tmpV.z) / D;
    if (az < 0) az += 360;
    return { alt, az };
  }

  /**
   * At >= 1 day/s the Earth would spin the sky several turns per second. While playing that
   * fast, the horizon frame is drawn at whole sidereal days from the anchor (same star time
   * every day), so the stars stay put and the Sun, Moon and planets visibly move against them.
   */
  private get locked(): boolean {
    return this.playing && Math.abs(this.rate) >= SIDEREAL_LOCK_RATE;
  }

  private rotTime(): number {
    if (!this.locked) return this.time;
    return clampTime(this.rotAnchor + Math.round((this.time - this.rotAnchor) / SIDEREAL_DAY_MS) * SIDEREAL_DAY_MS);
  }

  private updateRotation(rt: number) {
    const date = new Date(rt);
    const rot = Astro.Rotation_EQJ_HOR(date, this.observer).rot;
    // astronomy-engine applies v'_i = Σ_j rot[j][i] v_j. Scene = (−y_h, z_h, −x_h).
    const a = (i: number, j: number) => rot[j][i];
    this.tmpM.set(
      -a(1, 0), -a(1, 1), -a(1, 2), 0,
      a(2, 0), a(2, 1), a(2, 2), 0,
      -a(0, 0), -a(0, 1), -a(0, 2), 0,
      0, 0, 0, 1,
    );
    this.skyGroup.matrix.copy(this.tmpM);
    this.skyGroup.matrixWorldNeedsUpdate = true;
    this.lastRotTime = rt;
    this.rotDirty = false;
  }

  private updateProperMotion() {
    const years = yearsSinceJ2000(this.time);
    if (Math.abs(years - this.pmYear) < 0.25) return;
    this.pmYear = years;
    const n = this.cat.n;
    for (let i = 0; i < n; i++) {
      starVectorAt(this.cat, i, years, this.starVecNow, i * 3);
      this.starPos[i * 3] = this.starVecNow[i * 3] * R;
      this.starPos[i * 3 + 1] = this.starVecNow[i * 3 + 1] * R;
      this.starPos[i * 3 + 2] = this.starVecNow[i * 3 + 2] * R;
    }
    (this.starGeom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    if (this.constGeom && this.constPairs) {
      const p = this.constGeom.getAttribute('position') as THREE.BufferAttribute;
      const arr = p.array as Float32Array;
      for (let k = 0; k < this.constPairs.length; k++) {
        const i = this.constPairs[k];
        arr[k * 3] = this.starPos[i * 3] * 0.995;
        arr[k * 3 + 1] = this.starPos[i * 3 + 1] * 0.995;
        arr[k * 3 + 2] = this.starPos[i * 3 + 2] * 0.995;
      }
      p.needsUpdate = true;
    }
    const jy = julianYear(this.time);
    const tp = this.targetGeom.getAttribute('position') as THREE.BufferAttribute;
    SKY_TARGETS.forEach((t, k) => {
      const v = targetVectorAt(t, jy);
      this.targetVec[t.id] = v;
      tp.setXYZ(k, v[0] * R * 0.99, v[1] * R * 0.99, v[2] * R * 0.99);
    });
    this.markVec = {};
    HISTORIC_MARKS.forEach((mk, k) => {
      const on = jy >= mk.fromYear && jy <= mk.toYear;
      const a = mk.ra * D, d = mk.dec * D;
      const v = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
      if (on) this.markVec[mk.id] = v;
      const s = on ? R * 0.99 : 0;
      tp.setXYZ(SKY_TARGETS.length + k, v[0] * s, v[1] * s, v[2] * s);
    });
    tp.needsUpdate = true;
    this.updateSelectionMarker();
  }

  private updateBodies(nowReal: number) {
    if (this.time === this.lastBodyTime) return;
    this.lastBodyTime = this.time;
    const date = new Date(this.time);
    const pos = this.bodyGeom.getAttribute('position') as THREE.BufferAttribute;
    const size = this.bodyGeom.getAttribute('size') as THREE.BufferAttribute;
    const refreshMag = nowReal - this.magStamp > 500;
    if (refreshMag) this.magStamp = nowReal;
    BODY_IDS.forEach((b, i) => {
      const eq = Astro.Equator(b as Astro.Body, date, this.observer, false, true);
      const ra = eq.ra * 15 * D, dec = eq.dec * D;
      const v = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
      this.bodyVec[b] = v;
      this.bodyDist[b] = eq.dist;
      if (refreshMag && b !== 'Sun') {
        try {
          this.bodyMag[b] = Astro.Illumination(b as Astro.Body, date).mag;
        } catch {
          /* out-of-range epoch for the magnitude model: keep the last value */
        }
      }
      if (b === 'Moon') {
        pos.setXYZ(i, 0, 0, 0);
        size.setX(i, 0);
        this.moon.position.set(v[0] * R * 0.95, v[1] * R * 0.95, v[2] * R * 0.95);
      } else {
        pos.setXYZ(i, v[0] * R * 0.97, v[1] * R * 0.97, v[2] * R * 0.97);
        const mag = this.bodyMag[b];
        const s = b === 'Sun' ? BODY_STYLE.Sun.base : Math.max(BODY_STYLE[b].base, mag !== undefined ? magToSize(mag) * 1.15 : BODY_STYLE[b].base);
        size.setX(i, s);
      }
    });
    pos.needsUpdate = true;
    size.needsUpdate = true;
    const s = this.bodyVec.Sun;
    this.sunLight.position.set(s[0] * 1000, s[1] * 1000, s[2] * 1000);
    this.sunLight.target.position.copy(this.moon.position);
  }

  private updateAtmosphere() {
    const sun = this.bodyVec.Sun;
    if (!sun) return;
    this.sunAlt = this.horOf(sun).alt;
    let dim = 1;
    const night = new THREE.Color(0x0b0a09);
    if (this.layers.atmosphere) {
      // 0 at astronomical night (≤ −18°), 1 in full daylight (≥ +4°)
      const k = Math.max(0, Math.min(1, (this.sunAlt + 18) / 22));
      const day = new THREE.Color(0x26303a);
      const twilight = new THREE.Color(0x1a1a22);
      const c = k < 0.6 ? night.clone().lerp(twilight, k / 0.6) : twilight.clone().lerp(day, (k - 0.6) / 0.4);
      this.renderer.setClearColor(c, 1);
      dim = 1 - 0.8 * k;
      (this.ground.material as THREE.MeshBasicMaterial).color.setHex(k > 0.6 ? 0x16171a : 0x100e0c);
    } else {
      this.renderer.setClearColor(night, 1);
    }
    this.starMat.uniforms.uDim.value = dim;
  }

  private updateSelectionMarker() {
    const v = this.selection ? this.vectorOf(this.selection) : null;
    if (!v) {
      this.selPoints.visible = false;
      return;
    }
    const p = this.selGeom.getAttribute('position') as THREE.BufferAttribute;
    p.setXYZ(0, v[0] * R * 0.985, v[1] * R * 0.985, v[2] * R * 0.985);
    p.needsUpdate = true;
    this.selPoints.visible = true;
    (this.selPoints.material as THREE.ShaderMaterial).uniforms.uSize.value = this.selection?.startsWith('body:Moon') ? 64 : 30;
  }

  private vectorOf(key: string): number[] | null {
    if (key.startsWith('star#')) {
      const i = Number(key.slice(5));
      if (!(i >= 0 && i < this.cat.n)) return null;
      return [this.starVecNow[i * 3], this.starVecNow[i * 3 + 1], this.starVecNow[i * 3 + 2]];
    }
    if (key.startsWith('body:')) return this.bodyVec[key.slice(5)] ?? null;
    if (key.startsWith('target:')) return this.targetVec[key.slice(7)] ?? null;
    if (key.startsWith('mark:')) return this.markVec[key.slice(5)] ?? null;
    if (key.startsWith('radec:')) {
      const [ra, dec] = key.slice(6).split(',').map(Number);
      if (!Number.isFinite(ra) || !Number.isFinite(dec)) return null;
      const a = ra * D, d = dec * D;
      return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
    }
    return null;
  }

  /** Turn the view towards an ICRS position (deg) on the next frame. */
  lookAtRaDec(ra: number, dec: number): void {
    this.dirty = true;
    this.pendingLook = `radec:${ra},${dec}`;
  }

  // ------------------------------------------------------------------ trails

  private trailSpanFor(): number {
    return Math.min(6000 * MS_YEAR, Math.max(2 * MS_DAY, Math.abs(this.rate) * 24 * 1000));
  }

  private updateTrails() {
    if (!this.layers.trails) return;
    const span = this.trailSpanFor();
    const needs =
      !Number.isFinite(this.trailCenter) ||
      Math.abs(this.time - this.trailCenter) > span / 4 ||
      span / this.trailSpan > 1.5 ||
      this.trailSpan / span > 1.5;
    if (!needs) return;
    this.trailCenter = this.time;
    this.trailSpan = span;
    for (const t of this.trails) {
      this.trailGroup.remove(t.line, t.ticks);
      t.line.geometry.dispose();
      (t.line.material as THREE.Material).dispose();
      t.ticks.geometry.dispose();
      (t.ticks.material as THREE.Material).dispose();
    }
    this.trails = [];

    const build = (key: string, color: number, sampler: (ms: number) => number[] | null, spanMs: number, opacity: number) => {
      const t0 = Math.max(MIN_MS, this.time - spanMs / 2);
      const t1 = Math.min(MAX_MS, this.time + spanMs / 2);
      const pts = new Float32Array(TRAIL_SAMPLES * 3);
      const tickTimes: number[] = [];
      const tickVecs: number[][] = [];
      const tickPts: number[] = [];
      for (let k = 0; k < TRAIL_SAMPLES; k++) {
        const ms = t0 + ((t1 - t0) * k) / (TRAIL_SAMPLES - 1);
        const v = sampler(ms);
        if (!v) return;
        pts.set([v[0] * R * 0.96, v[1] * R * 0.96, v[2] * R * 0.96], k * 3);
        if (TICKS.includes(k)) {
          tickTimes.push(ms);
          tickVecs.push(v);
          tickPts.push(v[0] * R * 0.96, v[1] * R * 0.96, v[2] * R * 0.96);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
      line.frustumCulled = false;
      line.renderOrder = 3;
      const tg = new THREE.BufferGeometry();
      tg.setAttribute('position', new THREE.Float32BufferAttribute(tickPts, 3));
      const ticks = new THREE.Points(tg, new THREE.PointsMaterial({ color, size: 5, sizeAttenuation: false, transparent: true, opacity: Math.min(1, opacity + 0.25), depthWrite: false }));
      ticks.frustumCulled = false;
      ticks.renderOrder = 3;
      this.trailGroup.add(line, ticks);
      this.trails.push({ key, line, ticks, tickTimes, tickVecs, span: t1 - t0 });
    };

    const geo = (b: BodyId) => (ms: number) => {
      try {
        const v = Astro.GeoVector(b as Astro.Body, new Date(ms), true);
        const r = Math.hypot(v.x, v.y, v.z) || 1;
        return [v.x / r, v.y / r, v.z / r];
      } catch {
        return null;
      }
    };
    for (const b of BODY_IDS) {
      if (b === 'Moon' && span > 40 * MS_DAY) continue;
      if (b !== 'Moon' && span > 80 * MS_YEAR) continue;
      build(`body:${b}`, TRAIL_COLOR[b], geo(b), span, b === 'Sun' ? 0.45 : 0.6);
    }
    const starSpan = Math.min(6000 * MS_YEAR, Math.max(400 * MS_YEAR, span));
    for (const t of SKY_TARGETS) {
      build(`target:${t.id}`, 0xff5a1f, (ms) => targetVectorAt(t as SkyTarget, julianYear(ms)), starSpan, 0.75);
    }
    for (const hr of FAST_STAR_HR) {
      const i = this.cat.hr.indexOf(hr);
      if (i < 0) continue;
      build(`star#${i}`, 0xa8a39a, (ms) => {
        const out = [0, 0, 0];
        starVectorAt(this.cat, i, yearsSinceJ2000(ms), out);
        return out;
      }, starSpan, 0.55);
    }
  }

  // ------------------------------------------------------------------ labels

  private collectLabels(): LabelItem[] {
    const out: LabelItem[] = [];
    const L = this.layers;
    const nm = this.names;
    if (L.cardinals) {
      const c = nm.cardinals;
      out.push({ key: 'c:N', text: c.N, x: 0, y: 0.6, z: -R * 0.88, frame: 'hor', cls: 'sky-lbl-card' });
      out.push({ key: 'c:E', text: c.E, x: R * 0.88, y: 0.6, z: 0, frame: 'hor', cls: 'sky-lbl-card' });
      out.push({ key: 'c:S', text: c.S, x: 0, y: 0.6, z: R * 0.88, frame: 'hor', cls: 'sky-lbl-card' });
      out.push({ key: 'c:W', text: c.W, x: -R * 0.88, y: 0.6, z: 0, frame: 'hor', cls: 'sky-lbl-card' });
    }
    if (L.labels) {
      for (const b of BODY_IDS) {
        const v = this.bodyVec[b];
        if (v) out.push({ key: `b:${b}`, text: nm.bodies[b], x: v[0] * R, y: v[1] * R, z: v[2] * R, frame: 'sky', cls: b === 'Sun' || b === 'Moon' ? 'sky-lbl-body sky-lbl-big' : 'sky-lbl-body' });
      }
      for (let i = 0; i < Math.min(this.cat.n, 400); i++) {
        const hr = this.cat.hr[i];
        const e = hr ? STAR_NAMES[hr] : undefined;
        if (!e?.label) continue;
        out.push({ key: `s:${i}`, text: e.name, x: this.starPos[i * 3], y: this.starPos[i * 3 + 1], z: this.starPos[i * 3 + 2], frame: 'sky', cls: 'sky-lbl-star' });
      }
      // Celestial poles of date: EQD pole → EQJ.
      const toJ = Astro.InverseRotation(Astro.Rotation_EQJ_EQD(new Date(this.time)));
      const np = Astro.RotateVector(toJ, new Astro.Vector(0, 0, 1, Astro.MakeTime(new Date(this.time))));
      out.push({ key: 'p:n', text: `+ ${nm.ncp}`, x: np.x * R, y: np.y * R, z: np.z * R, frame: 'sky', cls: 'sky-lbl-pole' });
      out.push({ key: 'p:s', text: `+ ${nm.scp}`, x: -np.x * R, y: -np.y * R, z: -np.z * R, frame: 'sky', cls: 'sky-lbl-pole' });
    }
    if (L.targets) {
      for (const t of SKY_TARGETS) {
        const v = this.targetVec[t.id];
        if (v) out.push({ key: `t:${t.id}`, text: t.name, x: v[0] * R, y: v[1] * R, z: v[2] * R, frame: 'sky', cls: 'sky-lbl-target' });
      }
      for (const k of Object.keys(this.markVec)) {
        const v = this.markVec[k];
        out.push({ key: `m:${k}`, text: nm.marks[k] ?? k, x: v[0] * R, y: v[1] * R, z: v[2] * R, frame: 'sky', cls: 'sky-lbl-target' });
      }
    }
    if (L.trails && this.selection) {
      const tr = this.trails.find((t) => t.key === this.selection);
      if (tr) {
        tr.tickVecs.forEach((v, k) => {
          if (k === 2) return; // the middle tick is "now", where the body already is
          out.push({ key: `k:${k}`, text: formatTick(tr.tickTimes[k], this.tzOffset ?? Math.round(this.lon / 15), tr.span), x: v[0] * R * 0.96, y: v[1] * R * 0.96, z: v[2] * R * 0.96, frame: 'sky', cls: 'sky-lbl-tick' });
        });
      }
    }
    if (this.selection) {
      const v = this.vectorOf(this.selection);
      if (v && this.selection.startsWith('star#')) {
        const i = Number(this.selection.slice(5));
        const hr = this.cat.hr[i];
        if (!(hr && STAR_NAMES[hr]?.label)) out.push({ key: 'sel', text: starName(this.cat, i), x: v[0] * R, y: v[1] * R, z: v[2] * R, frame: 'sky', cls: 'sky-lbl-star sky-lbl-sel' });
      }
    }
    return out;
  }

  private updateLabels() {
    if (this.mode === 'cardboard' || this.mode === 'xr') return;
    const el = this.renderer.domElement;
    const w = el.clientWidth, h = el.clientHeight;
    const items = this.collectLabels();
    const seen = new Set<string>();
    this.skyGroup.updateMatrixWorld();
    for (const it of items) {
      this.tmpV.set(it.x, it.y, it.z);
      if (it.frame === 'sky') this.tmpV.applyMatrix4(this.skyGroup.matrixWorld);
      const above = this.tmpV.y > -0.3;
      if (this.layers.ground && !above && !it.key.startsWith('c:')) continue;
      this.tmpV.project(this.camera);
      if (this.tmpV.z > 1 || this.tmpV.z < -1) continue;
      const sx = (this.tmpV.x * 0.5 + 0.5) * w;
      const sy = (-this.tmpV.y * 0.5 + 0.5) * h;
      if (sx < -80 || sx > w + 80 || sy < -30 || sy > h + 30) continue;
      seen.add(it.key);
      let span = this.labelEls.get(it.key);
      if (!span) {
        span = document.createElement('span');
        span.className = `sky-lbl ${it.cls}`;
        this.labelsEl.appendChild(span);
        this.labelEls.set(it.key, span);
      }
      if (span.textContent !== it.text) span.textContent = it.text;
      span.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`;
    }
    this.labelEls.forEach((span, key) => {
      if (!seen.has(key)) {
        span.remove();
        this.labelEls.delete(key);
      }
    });
  }

  // ------------------------------------------------------------------ selection info

  private emitInfo(force = false) {
    if (!this.cb.onSelect) return;
    const now = performance.now();
    if (!force && now - this.lastInfoEmit < 250) {
      // Trailing update: keep frames coming until the throttle lets the latest state out.
      this.infoPending = true;
      this.dirty = true;
      return;
    }
    this.infoPending = false;
    this.lastInfoEmit = now;
    this.cb.onSelect(this.selection ? this.describe(this.selection) : null);
  }

  private describe(key: string): SelectionInfo | null {
    const v = this.vectorOf(key);
    if (!v) return null;
    const date = new Date(this.time);
    const eqd = Astro.RotateVector(Astro.Rotation_EQJ_EQD(date), new Astro.Vector(v[0], v[1], v[2], Astro.MakeTime(date)));
    const radec = (x: number, y: number, z: number) => {
      let ra = Math.atan2(y, x) / D;
      if (ra < 0) ra += 360;
      return { ra, dec: Math.asin(Math.max(-1, Math.min(1, z / (Math.hypot(x, y, z) || 1)))) / D };
    };
    const ofDate = radec(eqd.x, eqd.y, eqd.z);
    const hor = this.horOf(v);
    const base: SelectionInfo = {
      key,
      kind: 'star',
      id: key,
      name: '',
      vmag: null,
      raDate: ofDate.ra,
      decDate: ofDate.dec,
      raLink: ofDate.ra,
      decLink: ofDate.dec,
      alt: hor.alt,
      az: hor.az,
      pm: null,
      hr: null,
      distAu: null,
      phase: null,
      moonPhaseIndex: null,
      targetId: null,
    };
    if (key.startsWith('star#')) {
      const i = Number(key.slice(5));
      const lv = [0, 0, 0];
      starVectorAt(this.cat, i, LINK_YEAR - 2000, lv);
      const link = radec(lv[0], lv[1], lv[2]);
      return {
        ...base,
        kind: 'star',
        id: String(i),
        name: starName(this.cat, i),
        vmag: this.cat.vmag[i],
        raLink: link.ra,
        decLink: link.dec,
        pm: Math.hypot(this.cat.pmRa[i], this.cat.pmDec[i]) / 1000,
        hr: this.cat.hr[i] || null,
      };
    }
    if (key.startsWith('target:')) {
      const t = SKY_TARGETS.find((x) => `target:${x.id}` === key)!;
      const link = targetVectorAt(t, LINK_YEAR);
      const l = radec(link[0], link[1], link[2]);
      return { ...base, kind: 'target', id: t.id, name: t.name, vmag: t.vmag, raLink: l.ra, decLink: l.dec, pm: Math.hypot(t.pmRa, t.pmDec) / 1000, targetId: t.id };
    }
    if (key.startsWith('mark:')) {
      const id = key.slice(5);
      const mk = HISTORIC_MARKS.find((m) => m.id === id);
      return { ...base, kind: 'mark', id, name: this.names.marks[id] ?? id, raLink: mk?.ra ?? base.raLink, decLink: mk?.dec ?? base.decLink };
    }
    const b = key.slice(5) as BodyId;
    let phase: number | null = null;
    let mag: number | null = this.bodyMag[b] ?? null;
    let moonIdx: number | null = null;
    if (b !== 'Sun') {
      try {
        const ill = Astro.Illumination(b as Astro.Body, date);
        phase = ill.phase_fraction;
        mag = ill.mag;
      } catch {
        /* keep defaults */
      }
    } else {
      mag = -26.7;
    }
    if (b === 'Moon') {
      const ang = Astro.MoonPhase(date);
      moonIdx = Math.floor(((ang + 22.5) % 360) / 45);
    }
    return { ...base, kind: 'body', id: b, name: this.names.bodies[b], vmag: mag, distAu: this.bodyDist[b] ?? null, phase, moonPhaseIndex: moonIdx };
  }

  // ------------------------------------------------------------------ visible-sky bands

  private computeVisibleBands(): { bands: SkyBand[]; info: VisibleSkyInfo } | null {
    if (!Number.isFinite(this.pmYear)) return null;
    this.skyGroup.updateMatrixWorld();
    const m = this.skyGroup.matrix;
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const aspect = this.camera.aspect || 1;
    const halfDiag = Math.atan(Math.tan((this.fov * D) / 2) * Math.sqrt(1 + aspect * aspect));
    const cosLim = Math.cos(Math.min(Math.PI / 2, halfDiag));
    const acc = new Float64Array(SKY_BAND_CENTERS_UM.length);
    let count = 0;
    let total = 0;
    const e = m.elements;
    for (let i = 0; i < this.cat.n; i++) {
      const x = this.starVecNow[i * 3], y = this.starVecNow[i * 3 + 1], z = this.starVecNow[i * 3 + 2];
      const wx = e[0] * x + e[4] * y + e[8] * z;
      const wy = e[1] * x + e[5] * y + e[9] * z;
      const wz = e[2] * x + e[6] * y + e[10] * z;
      if (this.layers.ground && wy < 0) continue;
      if (wx * fwd.x + wy * fwd.y + wz * fwd.z < cosLim) continue;
      const f = Math.pow(10, -0.4 * this.cat.vmag[i]);
      const bb = cachedBlackbody(bvToTemperature(this.cat.bv[i]));
      for (let k = 0; k < acc.length; k++) acc[k] += f * bb[k];
      count++;
      total += f;
    }
    let max = 0;
    for (let k = 0; k < acc.length; k++) max = Math.max(max, acc[k]);
    const bands = SKY_BAND_CENTERS_UM.map((lambda_um, k) => ({ lambda_um, intensity: max > 0 ? acc[k] / max : 0 }));
    // Centre of the view in J2000.
    const inv = new THREE.Matrix4().copy(m).invert();
    const c = fwd.clone().applyMatrix4(inv).normalize();
    let ra = Math.atan2(c.y, c.x) / D;
    if (ra < 0) ra += 360;
    return {
      bands,
      info: { kind: 'colour-based-approximation', starCount: count, totalFluxV: total, ra, dec: Math.asin(c.z) / D, fovDeg: this.fov, timeMs: this.time },
    };
  }

  private emitLook(az: number, alt: number, fov: number) {
    const l = this.lastLook;
    if (Math.abs(az - l[0]) < 0.1 && Math.abs(alt - l[1]) < 0.1 && Math.abs(fov - l[2]) < 0.1) return;
    this.lastLook = [az, alt, fov];
    this.cb.onLook?.(az, alt, fov);
  }

  // ------------------------------------------------------------------ frame loop

  private frame() {
    if (this.disposed) return;
    const now = performance.now();
    // Idle: nothing moves, nothing changed -> skip the frame. Slow playback (<= 1 min/s) renders
    // at ~5 fps, which is still smooth for motion that slow.
    const slow = this.playing && Math.abs(this.rate) <= 60;
    const active =
      this.renderer.xr.isPresenting ||
      this.dirty ||
      this.tween !== null ||
      this.pendingLook !== null ||
      this.mode !== 'normal' ||
      (this.playing && (!slow || now - this.lastRender > 200));
    if (!active) return;
    const dt = Math.min(0.25, (now - this.prevFrame) / 1000);
    this.prevFrame = now;

    if (this.playing) {
      const next = this.time + this.rate * dt * 1000;
      const clamped = clampTime(next);
      this.time = clamped;
      if (clamped !== next) this.playing = false;
    }

    if (this.tween) {
      const k = Math.min(1, (now - this.tween.t0) / this.tween.dur);
      const e = 1 - Math.pow(1 - k, 3);
      this.az = ((this.tween.from[0] + (this.tween.to[0] - this.tween.from[0]) * e) % 360 + 360) % 360;
      this.alt = this.tween.from[1] + (this.tween.to[1] - this.tween.from[1]) * e;
      if (k >= 1) this.tween = null;
    }

    const rt = this.rotTime();
    if (this.rotDirty || rt !== this.lastRotTime) this.updateRotation(rt);
    this.updateProperMotion();
    this.updateBodies(now);
    this.updateAtmosphere();
    this.updateTrails();
    if (this.selection) this.updateSelectionMarker();
    if (this.pendingLook) {
      const v = this.vectorOf(this.pendingLook);
      this.pendingLook = null;
      if (v) {
        const h = this.horOf(v);
        this.look(h.az, h.alt > -5 ? Math.max(12, h.alt) : 20);
      }
      this.emitInfo(true);
    }

    // Camera
    if (this.mode === 'motion' || this.mode === 'cardboard') {
      if (!this.orient.apply(this.camera.quaternion)) this.camera.rotation.set(this.alt * D, -this.az * D, 0, 'YXZ');
    } else if (this.mode !== 'xr') {
      this.camera.rotation.set(this.alt * D, -this.az * D, 0, 'YXZ');
    }
    if (this.camera.fov !== this.fov) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    const scale = Math.max(0.7, Math.min(2.6, Math.sqrt(70 / this.fov)));
    this.starMat.uniforms.uScale.value = scale;
    this.bodyMat.uniforms.uScale.value = Math.min(1.6, scale);

    this.camera.updateMatrixWorld();
    this.updateLabels();

    if (this.mode === 'cardboard' && this.stereo) this.stereo.render(this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
    this.dirty = false;
    this.lastRender = now;

    if (now - this.lastTick > 100 || !this.playing) {
      this.lastTick = now;
      this.cb.onTime?.(this.time, this.playing);
    }
    if (this.selection) this.emitInfo();

    // Look readout: throttled to 5 Hz, with a trailing update so the last value always lands.
    let az = this.az, alt = this.alt;
    if (this.mode === 'motion' || this.mode === 'cardboard') {
      const f = this.tmpV;
      this.camera.getWorldDirection(f);
      az = Math.atan2(f.x, -f.z) / D;
      if (az < 0) az += 360;
      alt = Math.asin(Math.max(-1, Math.min(1, f.y))) / D;
    }
    const l = this.lastLook;
    const lookChanged = Math.abs(az - l[0]) >= 0.1 || Math.abs(alt - l[1]) >= 0.1 || Math.abs(this.fov - l[2]) >= 0.1;
    if (lookChanged) {
      if (now - this.lastLookEmit > 200) {
        this.lastLookEmit = now;
        this.emitLook(az, alt, this.fov);
      } else this.dirty = true;
    }

    // Visible-sky bands for the symphony: ≤ 4 Hz, trailing update after the view settles.
    if (hasVisibleSkyListeners()) {
      if (now - this.lastBandEmit > 250) {
        this.lastBandEmit = now;
        this.bandsPending = false;
        const r = this.computeVisibleBands();
        if (r) publishVisibleSky(r.bands, r.info);
      } else {
        this.bandsPending = true;
        this.dirty = true;
      }
    }
  }
}
