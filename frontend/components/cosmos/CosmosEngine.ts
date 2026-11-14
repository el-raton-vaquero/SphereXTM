import * as THREE from 'three';
import {
  DEG,
  eclipticToRadec,
  galacticToRadec,
  radecToScene,
  sceneToRadec,
  sunEclipticLongitude,
} from './astro';
import { buildSpacecraft, disposeObject } from './spacecraft';
import type { StarCatalog } from './stars';

/**
 * Imperative three.js engine behind the /cosmos landing. React owns the HUD;
 * this class owns the canvas, camera and render loop. Loaded lazily (dynamic
 * import) so three.js never lands in the initial route bundle.
 */

export type CosmosMode = 'orbit' | 'sky';

export interface CosmosViewState {
  mode: CosmosMode;
  ra: number; // view centre, deg
  dec: number;
  fov: number; // vertical field of view, deg
  day: number;
  flying: boolean;
}

export interface CosmosEngineOptions {
  reducedMotion: boolean;
  onView?: (s: CosmosViewState) => void;
  onPick?: (ra: number, dec: number) => void;
  labels: { ecliptic: string; galactic: string; sun: string; earth: string; spacecraft: string };
}

/** Survey timeline origin: SPHEREx began its all-sky survey on 2025-05-01. */
export const SURVEY_START = new Date(Date.UTC(2025, 4, 1));
export const SURVEY_DAYS = 184; // 2025-05-01 → 2025-11-01

const SKY_R = 480;
const STAR_R = 490;
const GRID_R = 470;
const ORBIT_R = 1 + 650 / 6371; // mean altitude ~650 km over a 6371 km Earth: to scale
const SC_SCALE = 0.05; // spacecraft magnified ~10^5× — labelled in the HUD
const HALF_WIDTH = 5.6; // illustrative scan-strip half width, deg

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Label {
  el: HTMLDivElement;
  pos: THREE.Vector3;
  kind: 'sky' | 'earth';
}

interface Flight {
  t0: number;
  dur: number;
  pos0: THREE.Vector3;
  pos1: THREE.Vector3;
  q0: THREE.Quaternion;
  q1: THREE.Quaternion;
  fov0: number;
  fov1: number;
  toMode: CosmosMode;
  sky?: { ra: number; dec: number };
  resolve: () => void;
}

export class CosmosEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;
  private labelLayer: HTMLElement;
  private opts: CosmosEngineOptions;
  private raf = 0;
  private active = true;
  private disposed = false;
  private lastT = 0;
  private lastViewEmit = 0;

  private mode: CosmosMode = 'orbit';
  private orbit = { az: 0.9, el: 0.32, dist: 6.4 };
  private sky = { ra: 270, dec: 5, fov: 60 };
  private orbitFov = 34;
  // Projection shifts (fractions of the viewport) that keep the subject clear of the HUD:
  private shiftX = 0; // orbit view, desktop: Earth moves right of the left panel
  private orbitShiftY = 0; // orbit view, phones: Earth moves down below the title
  private skyShiftY = 0; // sky view, phones: locked target sits above the lock panel
  private flight: Flight | null = null;

  private day = 0;
  private playing = false;
  private orbitPhase = 0;
  private idle = 0;

  private stars?: THREE.Points;
  private fineGrid!: THREE.LineSegments;
  private starMat: THREE.ShaderMaterial;
  private coverageMat: THREE.ShaderMaterial;
  private earthGroup = new THREE.Group();
  private earthMats: THREE.Material[] = [];
  private spacecraft: THREE.Group;
  private boresight: THREE.Line;
  private orbitLine: THREE.Line;
  private sunLight: THREE.DirectionalLight;
  private labels: Label[] = [];
  private sunLabel!: Label;
  private scLabel!: Label;
  private earthLabel!: Label;
  private sunDir = new THREE.Vector3(1, 0, 0);
  private tmp = new THREE.Vector3();
  private ro: ResizeObserver;

  private drag: { x: number; y: number; id: number } | null = null;

  constructor(canvas: HTMLCanvasElement, labelLayer: HTMLElement, opts: CosmosEngineOptions) {
    this.canvas = canvas;
    this.labelLayer = labelLayer;
    this.opts = opts;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    const mobile = Math.min(window.innerWidth, window.innerHeight) < 700;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 1.75));
    this.renderer.setClearColor(0x0b0a09, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(this.orbitFov, 1, 0.01, 2000);

    // ---------- Sky: coverage sphere (illustrative scan pattern) ----------
    this.coverageMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uL0: { value: 0 },
        uSweep: { value: 0 },
        uHW: { value: HALF_WIDTH * DEG },
        uInk: { value: new THREE.Color(0xece8e1) },
        uSignal: { value: new THREE.Color(0xff5a1f) },
        uShow: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vDir;
        uniform float uL0, uSweep, uHW, uShow;
        uniform vec3 uInk, uSignal;
        const float EPS = 0.40909280;
        const float PI = 3.14159265;
        void main() {
          // scene -> equatorial -> ecliptic
          vec3 e = vec3(vDir.x, -vDir.z, vDir.y);
          float lam = atan(e.y * cos(EPS) + e.z * sin(EPS), e.x);
          float bet = asin(clamp(e.z * cos(EPS) - e.y * sin(EPS), -1.0, 1.0));
          // phase of this point relative to the starting scan great circle (period PI)
          float phi = mod(lam - uL0, PI);
          float cb = max(cos(bet), 1e-4);
          float d = asin(min(1.0, sin(uHW) / cb));
          bool covered = (phi <= uSweep + d) || (phi >= PI - d);
          float fresh = 1.0 - smoothstep(0.0, d, abs(phi - uSweep));
          // also the antipodal half of the same great circle shares phi
          float a = covered ? 0.045 : 0.0;
          vec3 col = uInk;
          float af = fresh * 0.11;
          gl_FragColor = vec4(mix(col, uSignal, af > 0.0 ? 1.0 : 0.0), (a + af) * uShow);
        }`,
    });
    const coverage = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 128, 64), this.coverageMat);
    coverage.renderOrder = -2;
    this.scene.add(coverage);

    // ---------- Sky: graticule, ecliptic, galactic plane ----------
    this.scene.add(this.buildGraticule());
    this.fineGrid = this.buildFineGraticule();
    this.scene.add(this.fineGrid);
    this.scene.add(this.buildGreatCircle((t) => eclipticToRadec(t, 0), 0x8a857c, 0.55, false));
    this.scene.add(this.buildGreatCircle((t) => galacticToRadec(t, 0), 0x8a857c, 0.5, true));
    for (let h = 0; h < 24; h++) this.addSkyLabel(`${h}h`, h * 15, 0, 'tick');
    for (const d of [-60, -30, 30, 60]) {
      const txt = `${d > 0 ? '+' : '−'}${Math.abs(d)}°`;
      this.addSkyLabel(txt, 0, d, 'tick');
      this.addSkyLabel(txt, 180, d, 'tick');
    }
    this.addSkyLabel('+90°', 0, 89.9, 'tick');
    this.addSkyLabel('−90°', 0, -89.9, 'tick');
    for (const lon of [60, 240]) {
      const p = eclipticToRadec(lon, 0);
      this.addSkyLabel(opts.labels.ecliptic, p.ra, p.dec, 'line').el.dataset.k = 'ecl';
    }
    for (const l of [30, 210]) {
      const p = galacticToRadec(l, 0);
      this.addSkyLabel(opts.labels.galactic, p.ra, p.dec, 'line').el.dataset.k = 'gal';
    }

    // ---------- Stars ----------
    this.starMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uPx: { value: this.renderer.getPixelRatio() }, uZoom: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aMag;
        attribute vec3 aColor;
        uniform float uPx, uZoom;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float s = sqrt(pow(10.0, -0.4 * (aMag - 1.0)));
          float size = clamp(2.2 + 4.2 * s, 2.2, 12.0);
          vAlpha = clamp(0.3 + 1.4 * s, 0.3, 1.0);
          vColor = mix(vec3(1.0), aColor, 0.7);
          gl_PointSize = size * uPx * uZoom;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision mediump float;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float r = length(c) * 2.0;
          float a = exp(-r * r * 5.0) * smoothstep(1.0, 0.7, r);
          gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
        }`,
    });

    // ---------- Earth system ----------
    this.sunLight = new THREE.DirectionalLight(0xfff4e6, 3.0);
    this.scene.add(this.sunLight);
    this.scene.add(new THREE.AmbientLight(0x8a857c, 0.22));

    const earthMat = new THREE.MeshLambertMaterial({ color: 0x4a4740, transparent: true });
    const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), earthMat);
    this.earthGroup.add(earth);
    const eg = this.buildEarthGraticule();
    this.earthGroup.add(eg);
    this.earthMats.push(earthMat, eg.material as THREE.Material);

    const orbitPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 160; i++) {
      const a = (i / 160) * Math.PI * 2;
      orbitPts.push(new THREE.Vector3(Math.cos(a) * ORBIT_R, Math.sin(a) * ORBIT_R, 0));
    }
    const orbitMat = new THREE.LineDashedMaterial({ color: 0xa8a39a, dashSize: 0.03, gapSize: 0.025, transparent: true, opacity: 0.8 });
    this.orbitLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(orbitPts), orbitMat);
    this.orbitLine.computeLineDistances();
    this.earthGroup.add(this.orbitLine);
    this.earthMats.push(orbitMat);

    this.spacecraft = buildSpacecraft();
    this.spacecraft.scale.setScalar(SC_SCALE);
    this.earthGroup.add(this.spacecraft);
    this.spacecraft.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) {
        m.transparent = true;
        this.earthMats.push(m);
      }
    });

    const boreMat = new THREE.LineBasicMaterial({ color: 0xff5a1f, transparent: true, opacity: 0.55 });
    this.boresight = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]), boreMat);
    this.earthGroup.add(this.boresight);
    this.earthMats.push(boreMat);
    this.scene.add(this.earthGroup);

    this.sunLabel = this.addLabel(opts.labels.sun, new THREE.Vector3(), 'sky', 'sun');
    this.scLabel = this.addLabel(opts.labels.spacecraft, new THREE.Vector3(), 'earth', 'craft');
    this.earthLabel = this.addLabel(opts.labels.earth, new THREE.Vector3(0, -1.18, 0), 'earth', 'craft');

    this.setDay(0);

    // ---------- Input ----------
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('dblclick', this.onDbl);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    this.applyCamera();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------------ build

  private buildGraticule(): THREE.LineSegments {
    const pts: number[] = [];
    const push = (a: number[], b: number[]) => pts.push(...a, ...b);
    for (let h = 0; h < 24; h++) {
      for (let d = -88; d < 88; d += 2) push(radecToScene(h * 15, d, GRID_R), radecToScene(h * 15, d + 2, GRID_R));
    }
    for (let d = -75; d <= 75; d += 15) {
      for (let r = 0; r < 360; r += 2) push(radecToScene(r, d, GRID_R), radecToScene(r + 2, d, GRID_R));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x3a3733, transparent: true, opacity: 0.9 });
    const lines = new THREE.LineSegments(geo, mat);
    lines.renderOrder = -1;
    // Celestial equator a touch stronger.
    const eq: number[] = [];
    for (let r = 0; r < 360; r += 1) eq.push(...radecToScene(r, 0, GRID_R), ...radecToScene(r + 1, 0, GRID_R));
    const eqGeo = new THREE.BufferGeometry();
    eqGeo.setAttribute('position', new THREE.Float32BufferAttribute(eq, 3));
    lines.add(new THREE.LineSegments(eqGeo, new THREE.LineBasicMaterial({ color: 0x55514b })));
    return lines;
  }

  /** 1° graticule, faded in only when zoomed below ~20° field. */
  private buildFineGraticule(): THREE.LineSegments {
    const pts: number[] = [];
    const R = GRID_R - 1;
    for (let r = 0; r < 360; r += 1) {
      if (r % 15 === 0) continue;
      for (let d = -88; d < 88; d += 1) pts.push(...radecToScene(r, d, R), ...radecToScene(r, d + 1, R));
    }
    for (let d = -88; d <= 88; d += 1) {
      if (d % 15 === 0) continue;
      for (let r = 0; r < 360; r += 1) pts.push(...radecToScene(r, d, R), ...radecToScene(r + 1, d, R));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x2f2d2a, transparent: true, opacity: 0 }));
    lines.visible = false;
    lines.frustumCulled = false;
    return lines;
  }

  private buildGreatCircle(fn: (t: number) => { ra: number; dec: number }, color: number, opacity: number, dashed: boolean) {
    const pts: THREE.Vector3[] = [];
    for (let t = 0; t <= 360; t += 1) {
      const p = fn(t);
      pts.push(new THREE.Vector3(...radecToScene(p.ra, p.dec, GRID_R)));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 4, gapSize: 4, transparent: true, opacity })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    const line = new THREE.Line(geo, mat);
    if (dashed) line.computeLineDistances();
    return line;
  }

  private buildEarthGraticule(): THREE.LineSegments {
    const pts: number[] = [];
    const R = 1.003;
    const v = (lon: number, lat: number) => [
      R * Math.cos(lat * DEG) * Math.cos(lon * DEG),
      R * Math.sin(lat * DEG),
      -R * Math.cos(lat * DEG) * Math.sin(lon * DEG),
    ];
    for (let lon = 0; lon < 360; lon += 30) for (let lat = -88; lat < 88; lat += 4) pts.push(...v(lon, lat), ...v(lon, lat + 4));
    for (let lat = -60; lat <= 60; lat += 30) for (let lon = 0; lon < 360; lon += 4) pts.push(...v(lon, lat), ...v(lon + 4, lat));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x6d6961, transparent: true, opacity: 0.45 }));
  }

  private addLabel(text: string, pos: THREE.Vector3, kind: 'sky' | 'earth', cls: string): Label {
    const el = document.createElement('div');
    el.className = `cz-lbl cz-lbl-${cls}`;
    el.textContent = text;
    el.setAttribute('aria-hidden', 'true');
    this.labelLayer.appendChild(el);
    const l = { el, pos, kind };
    this.labels.push(l);
    return l;
  }

  private addSkyLabel(text: string, ra: number, dec: number, cls: string): Label {
    return this.addLabel(text, new THREE.Vector3(...radecToScene(ra, dec, GRID_R)), 'sky', cls);
  }

  setStars(cat: StarCatalog) {
    if (this.stars) {
      this.scene.remove(this.stars);
      this.stars.geometry.dispose();
    }
    const pos = new Float32Array(cat.n * 3);
    for (let i = 0; i < cat.n; i++) {
      const p = radecToScene(cat.ra[i], cat.dec[i], STAR_R);
      pos[i * 3] = p[0];
      pos[i * 3 + 1] = p[1];
      pos[i * 3 + 2] = p[2];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aMag', new THREE.BufferAttribute(cat.vmag, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(cat.rgb, 3));
    this.stars = new THREE.Points(geo, this.starMat);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  // ------------------------------------------------------------------ state

  setLabels(labels: CosmosEngineOptions['labels']) {
    this.opts.labels = labels;
    this.sunLabel.el.textContent = labels.sun;
    this.scLabel.el.textContent = labels.spacecraft;
    this.earthLabel.el.textContent = labels.earth;
    for (const l of this.labels) {
      if (l.el.dataset.k === 'ecl') l.el.textContent = labels.ecliptic;
      if (l.el.dataset.k === 'gal') l.el.textContent = labels.galactic;
    }
  }

  setDay(day: number) {
    this.day = Math.max(0, Math.min(SURVEY_DAYS, day));
    const lam0 = sunEclipticLongitude(SURVEY_START);
    const date = new Date(SURVEY_START.getTime() + this.day * 86400000);
    const lam = sunEclipticLongitude(date);
    let sweep = lam - lam0;
    if (sweep < 0) sweep += 360;
    this.coverageMat.uniforms.uL0.value = (lam0 + 90) * DEG;
    this.coverageMat.uniforms.uSweep.value = Math.min(sweep, 180) * DEG;
    const s = eclipticToRadec(lam, 0);
    this.sunDir.set(...radecToScene(s.ra, s.dec, 1));
    this.sunLight.position.copy(this.sunDir).multiplyScalar(10);
    this.sunLabel.pos.copy(this.sunDir).multiplyScalar(GRID_R);
    // Dawn–dusk orbit: plane perpendicular to the Sun line.
    this.orbitLine.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.sunDir);
  }

  getDay() {
    return this.day;
  }

  setPlaying(p: boolean) {
    this.playing = p;
  }

  setCoverageVisible(v: boolean) {
    this.coverageMat.uniforms.uShow.value = v ? 1 : 0;
  }

  setActive(a: boolean) {
    if (a === this.active || this.disposed) return;
    this.active = a;
    if (a) {
      this.lastT = 0;
      this.raf = requestAnimationFrame(this.loop);
    } else cancelAnimationFrame(this.raf);
  }

  getMode() {
    return this.mode;
  }

  /** Fly the camera to (ra, dec) as seen from the centre of the sky. */
  flyTo(ra: number, dec: number, fov = 8): Promise<void> {
    const dir = new THREE.Vector3(...radecToScene(ra, Math.max(-89, Math.min(89, dec)), 1));
    const dummy = new THREE.PerspectiveCamera();
    dummy.up.set(0, 1, 0);
    dummy.lookAt(dir);
    const dur = this.opts.reducedMotion ? 1 : this.mode === 'orbit' ? 2800 : 1900;
    return this.startFlight(new THREE.Vector3(0, 0, 0), dummy.quaternion.clone(), fov, 'sky', dur, { ra, dec });
  }

  setMode(mode: CosmosMode): Promise<void> {
    if (mode === this.mode && !this.flight) return Promise.resolve();
    if (mode === 'sky') {
      const c = this.viewCenter();
      return this.flyTo(c.ra, c.dec, 60);
    }
    const p = this.orbitPosition();
    const dummy = new THREE.PerspectiveCamera();
    dummy.position.copy(p);
    dummy.lookAt(0, 0, 0);
    return this.startFlight(p, dummy.quaternion.clone(), this.orbitFov, 'orbit', this.opts.reducedMotion ? 1 : 2200);
  }

  private startFlight(pos1: THREE.Vector3, q1: THREE.Quaternion, fov1: number, toMode: CosmosMode, dur: number, sky?: { ra: number; dec: number }) {
    this.flight?.resolve();
    return new Promise<void>((resolve) => {
      this.flight = {
        t0: performance.now(),
        dur,
        pos0: this.camera.position.clone(),
        pos1,
        q0: this.camera.quaternion.clone(),
        q1,
        fov0: this.camera.fov,
        fov1,
        toMode,
        sky,
        resolve,
      };
      if (!this.active) this.render(performance.now());
    });
  }

  /** RA/Dec under a client-space point. */
  pick(clientX: number, clientY: number): { ra: number; dec: number } | null {
    const r = this.canvas.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * 2 - 1;
    const y = -((clientY - r.top) / r.height) * 2 + 1;
    const v = new THREE.Vector3(x, y, 0.5).unproject(this.camera).sub(this.camera.position);
    return sceneToRadec(v.x, v.y, v.z);
  }

  nudge(dx: number, dy: number) {
    this.applyDrag(dx, dy);
  }

  zoom(factor: number) {
    if (this.flight) return;
    if (this.mode === 'sky') this.sky.fov = Math.max(1.5, Math.min(100, this.sky.fov * factor));
    else this.orbit.dist = Math.max(1.5, Math.min(14, this.orbit.dist * factor));
  }

  // ------------------------------------------------------------------ input

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
    this.canvas.setPointerCapture(e.pointerId);
    this.idle = 0;
  };
  private onMove = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.applyDrag(e.clientX - this.drag.x, e.clientY - this.drag.y);
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
  };
  private onUp = (e: PointerEvent) => {
    if (this.drag && e.pointerId === this.drag.id) this.drag = null;
  };
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoom(Math.exp(e.deltaY * 0.0012));
    this.idle = 0;
  };
  private onDbl = (e: MouseEvent) => {
    const p = this.pick(e.clientX, e.clientY);
    if (p && this.opts.onPick) this.opts.onPick(p.ra, p.dec);
  };

  private applyDrag(dx: number, dy: number) {
    if (this.flight) return;
    this.idle = 0;
    if (this.mode === 'sky') {
      const h = this.canvas.clientHeight || 1;
      const k = this.sky.fov / h;
      this.sky.ra = (this.sky.ra + dx * k / Math.max(0.15, Math.cos(this.sky.dec * DEG)) + 360) % 360;
      this.sky.dec = Math.max(-89, Math.min(89, this.sky.dec + dy * k));
    } else {
      this.orbit.az -= dx * 0.005;
      this.orbit.el = Math.max(-1.35, Math.min(1.35, this.orbit.el + dy * 0.005));
    }
  }

  // ------------------------------------------------------------------ frame

  private orbitPosition() {
    const { az, el } = this.orbit;
    // Portrait screens: back off so the Earth keeps the same apparent width.
    const dist = this.orbit.dist * (this.camera.aspect < 1 ? Math.min(2.2, 0.8 / this.camera.aspect) : 1);
    return new THREE.Vector3(dist * Math.cos(el) * Math.sin(az), dist * Math.sin(el), dist * Math.cos(el) * Math.cos(az));
  }

  private viewCenter() {
    this.camera.getWorldDirection(this.tmp);
    return sceneToRadec(this.tmp.x, this.tmp.y, this.tmp.z);
  }

  private applyCamera() {
    if (this.mode === 'orbit') {
      this.camera.position.copy(this.orbitPosition());
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(0, 0, 0);
      this.camera.fov = this.orbitFov;
    } else {
      this.camera.position.set(0, 0, 0);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(new THREE.Vector3(...radecToScene(this.sky.ra, this.sky.dec, 1)));
      this.camera.fov = this.sky.fov;
    }
    this.camera.updateProjectionMatrix();
  }

  private resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const narrow = w <= 900;
    this.shiftX = narrow ? 0 : 0.13;
    this.orbitShiftY = narrow ? -0.17 : 0;
    this.skyShiftY = narrow ? 0.1 : 0;
    this.camera.updateProjectionMatrix();
    if (!this.active) this.render(performance.now());
  }

  private loop(t: number) {
    if (!this.active || this.disposed) return;
    this.render(t);
    this.raf = requestAnimationFrame(this.loop);
  }

  private render(t: number) {
    const dt = this.lastT ? Math.min(0.1, (t - this.lastT) / 1000) : 0;
    this.lastT = t;
    const rm = this.opts.reducedMotion;

    if (this.playing) {
      this.setDay(this.day + dt * (SURVEY_DAYS / 36));
      if (this.day >= SURVEY_DAYS) this.playing = false;
    }

    // Spacecraft along its orbit (time compressed; one orbit ≈ 9 s on screen).
    if (!rm) this.orbitPhase += dt * ((Math.PI * 2) / 9);
    const u = new THREE.Vector3(0, 1, 0).cross(this.sunDir);
    if (u.lengthSq() < 1e-6) u.set(1, 0, 0);
    u.normalize();
    const v = new THREE.Vector3().crossVectors(this.sunDir, u).normalize();
    const radial = u.clone().multiplyScalar(Math.cos(this.orbitPhase)).addScaledVector(v, Math.sin(this.orbitPhase));
    this.spacecraft.position.copy(radial).multiplyScalar(ORBIT_R);
    const zAxis = new THREE.Vector3().crossVectors(this.sunDir, radial).normalize();
    this.spacecraft.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(this.sunDir, radial, zAxis));
    const bp = this.boresight.geometry.attributes.position as THREE.BufferAttribute;
    const tip = radial.clone().multiplyScalar(ORBIT_R + 0.14);
    const end = radial.clone().multiplyScalar(ORBIT_R + 1.6);
    bp.setXYZ(0, tip.x, tip.y, tip.z);
    bp.setXYZ(1, end.x, end.y, end.z);
    bp.needsUpdate = true;
    this.scLabel.pos.copy(radial).multiplyScalar(ORBIT_R + 0.2);

    // Idle drift in orbit mode.
    this.idle += dt;
    if (this.mode === 'orbit' && !this.flight && !this.drag && !rm && this.idle > 2.5) this.orbit.az += dt * 0.035;

    let earthAlpha = this.mode === 'orbit' ? 1 : 0;
    if (this.flight) {
      const f = this.flight;
      const k = Math.min(1, (t - f.t0) / f.dur);
      const e = easeInOut(k);
      this.camera.position.lerpVectors(f.pos0, f.pos1, e);
      this.camera.quaternion.slerpQuaternions(f.q0, f.q1, e);
      this.camera.fov = f.fov0 + (f.fov1 - f.fov0) * e;
      this.camera.updateProjectionMatrix();
      const d = this.camera.position.length();
      earthAlpha = smooth(1.25, 2.2, d);
      if (k >= 1) {
        this.flight = null;
        this.mode = f.toMode;
        if (f.toMode === 'sky' && f.sky) {
          this.sky.ra = f.sky.ra;
          this.sky.dec = Math.max(-89, Math.min(89, f.sky.dec));
          this.sky.fov = f.fov1;
        }
        if (f.toMode === 'orbit') this.idle = 0;
        this.applyCamera();
        f.resolve();
      }
    } else {
      this.applyCamera();
    }

    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w && h) {
      const sx = this.shiftX * earthAlpha;
      const sy = this.orbitShiftY * earthAlpha + this.skyShiftY * (1 - earthAlpha);
      if (Math.abs(sx) > 0.001 || Math.abs(sy) > 0.001) this.camera.setViewOffset(w, h, -sx * w, sy * h, w, h);
      else this.camera.clearViewOffset();
      this.camera.updateProjectionMatrix();
    }
    this.earthGroup.visible = earthAlpha > 0.01;
    for (const m of this.earthMats) {
      const base = (m.userData.baseOpacity ??= m.opacity);
      m.opacity = base * earthAlpha;
    }
    const fine = 1 - smooth(8, 20, this.camera.fov);
    this.fineGrid.visible = fine > 0.01;
    (this.fineGrid.material as THREE.LineBasicMaterial).opacity = fine;
    this.starMat.uniforms.uZoom.value = Math.min(2.6, Math.max(1, Math.sqrt(40 / this.camera.fov)));

    this.renderer.render(this.scene, this.camera);
    this.placeLabels(earthAlpha);

    if (this.opts.onView && t - this.lastViewEmit > 90) {
      this.lastViewEmit = t;
      const c = this.viewCenter();
      this.opts.onView({ mode: this.mode, ra: c.ra, dec: c.dec, fov: this.camera.fov, day: this.day, flying: !!this.flight });
    }
  }

  private placeLabels(earthAlpha: number) {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const camDir = this.camera.getWorldDirection(new THREE.Vector3());
    const showSky = this.camera.fov > 14;
    for (const l of this.labels) {
      let visible = l.kind === 'earth' ? earthAlpha > 0.5 : showSky || l === this.sunLabel;
      if (visible) {
        this.tmp.copy(l.pos);
        const toP = this.tmp.clone().sub(this.camera.position).normalize();
        if (toP.dot(camDir) < 0.05) visible = false;
        else {
          this.tmp.project(this.camera);
          const x = (this.tmp.x * 0.5 + 0.5) * w;
          const y = (-this.tmp.y * 0.5 + 0.5) * h;
          if (x < -40 || x > w + 40 || y < -20 || y > h + 20) visible = false;
          else l.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
        }
      }
      // Earth-system labels hidden behind the Earth disc.
      if (visible && l.kind === 'earth' && l !== this.earthLabel) {
        const ray = new THREE.Ray(this.camera.position.clone(), l.pos.clone().sub(this.camera.position).normalize());
        const hit = ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1), new THREE.Vector3());
        if (hit && hit.distanceTo(this.camera.position) < l.pos.distanceTo(this.camera.position)) visible = false;
      }
      l.el.style.opacity = visible ? '1' : '0';
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.flight?.resolve();
    this.ro.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('dblclick', this.onDbl);
    for (const l of this.labels) l.el.remove();
    disposeObject(this.scene);
    this.renderer.dispose();
  }
}
