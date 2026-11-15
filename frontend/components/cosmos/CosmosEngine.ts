import * as THREE from 'three';
import {
  DEG,
  eclipticToRadec,
  galacticToRadec,
  radecToScene,
  sceneToRadec,
  sunEclipticLongitude,
} from './astro';
import { allBodies, PLANET_IDS, siderealDeg, subSolarPoint, type BodyId, type BodyState, type PlanetId } from './bodies';
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
  /** Instant the Sun, Moon, planets and Earth's rotation are computed for (ms). */
  date: number;
  /** true: following the wall clock; false: following the survey timeline. */
  live: boolean;
  subSolar: { lat: number; lon: number };
  moonPhase: number; // illuminated fraction
}

export interface CosmosLabels {
  ecliptic: string;
  galactic: string;
  sun: string;
  earth: string;
  spacecraft: string;
  moon: string;
  planets: Record<PlanetId, string>;
}

export interface CosmosEngineOptions {
  reducedMotion: boolean;
  onView?: (s: CosmosViewState) => void;
  onPick?: (ra: number, dec: number) => void;
  labels: CosmosLabels;
}

/** Texture paths (public/cosmos, provenance in its README). */
export const COSMOS_TEXTURES = {
  day: '/cosmos/earth-day.jpg',
  night: '/cosmos/earth-night.jpg',
  clouds: '/cosmos/earth-clouds.jpg',
  moon: '/cosmos/moon.jpg',
  milkyway: '/cosmos/milkyway.jpg',
};

/** Survey timeline origin: SPHEREx began its all-sky survey on 2025-05-01. */
export const SURVEY_START = new Date(Date.UTC(2025, 4, 1));
export const SURVEY_DAYS = 184; // 2025-05-01 → 2025-11-01

const SKY_R = 480;
const STAR_R = 490;
const GRID_R = 470;
const MW_R = 496; // Milky Way backdrop, behind the stars
const BODY_R = 440; // Sun, Moon and planets: in front of the grid and stars
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
  kind: 'sky' | 'earth' | 'body';
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
  private earthSpin = new THREE.Group(); // rotates with sidereal time
  private earthMat: THREE.ShaderMaterial;
  private atmoMat: THREE.ShaderMaterial;
  private mwMat: THREE.ShaderMaterial;
  private moon: THREE.Mesh;
  private moonMat: THREE.ShaderMaterial;
  private bodyPoints: THREE.Points;
  private bodyMat: THREE.ShaderMaterial;
  private bodyLabels: Partial<Record<BodyId, Label>> = {};
  private bodies: BodyState[] = [];
  private textures: THREE.Texture[] = [];
  private live = true;
  private date = new Date();
  private readonly todMs: number; // UTC time of day used for survey-timeline dates
  private lastClock = 0;
  private subSolar = { lat: 0, lon: 0 };
  private moonPhase = 0;
  private moonRadiusDeg = 0.26;
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
        varying float vHalo;
        void main() {
          float s = sqrt(pow(10.0, -0.4 * (aMag - 1.0)));   // ~ sqrt(flux), 1 at V = 1
          float size = clamp(3.0 + 7.5 * s, 3.0, 22.0);      // bright stars get room for a halo
          vAlpha = clamp(0.28 + 1.3 * s, 0.28, 1.0);
          vHalo = clamp(s * 0.9, 0.0, 1.0);
          vColor = mix(vec3(1.0), aColor, 0.8);
          gl_PointSize = size * uPx * uZoom;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision mediump float;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vHalo;
        void main() {
          // Soft PSF: tight Gaussian core plus a faint exponential wing for bright stars.
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float core = exp(-r * r * 14.0);
          float wing = exp(-r * 5.0) * 0.28 * vHalo;
          float a = (core + wing) * smoothstep(1.0, 0.75, r);
          gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
        }`,
    });

    // ---------- Milky Way backdrop (NASA SVS Deep Star Maps 2020, ICRS equirectangular) ----------
    this.mwMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uMap: { value: null }, uGain: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform sampler2D uMap;
        uniform float uGain;
        varying vec2 vUv;
        void main() {
          // Map centred on RA 0h with RA increasing to the left; sphere u=0.5 is RA 0h, u grows with RA.
          vec3 c = texture2D(uMap, vec2(1.0 - vUv.x, vUv.y)).rgb;
          gl_FragColor = vec4(c * uGain, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const mw = new THREE.Mesh(new THREE.SphereGeometry(MW_R, 64, 32), this.mwMat);
    mw.renderOrder = -3;
    this.scene.add(mw);

    // ---------- Earth system ----------
    this.sunLight = new THREE.DirectionalLight(0xfff4e6, 3.0);
    this.scene.add(this.sunLight);
    this.scene.add(new THREE.AmbientLight(0x8a857c, 0.22));

    // Real Earth: Blue Marble day + Black Marble night, blended at the real terminator.
    this.earthMat = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        uDay: { value: null },
        uNight: { value: null },
        uClouds: { value: null },
        uSun: { value: new THREE.Vector3(1, 0, 0) },
        uAlpha: { value: 1 },
        uReady: { value: 0 },
        uHasClouds: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vN;
        varying vec3 vP;
        void main() {
          vUv = uv;
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vP = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uDay, uNight, uClouds;
        uniform vec3 uSun;
        uniform float uAlpha, uReady, uHasClouds;
        varying vec2 vUv;
        varying vec3 vN;
        varying vec3 vP;
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(cameraPosition - vP);
          vec3 L = normalize(uSun);
          float ndl = dot(N, L);
          float diff = max(ndl, 0.0);
          vec3 day = texture2D(uDay, vUv).rgb;
          vec3 night = texture2D(uNight, vUv).rgb;
          float cloud = uHasClouds * texture2D(uClouds, vUv).r;
          // Soft terminator: civil-twilight-wide blend around the real day/night line.
          float dayK = smoothstep(-0.10, 0.20, ndl);
          // Ocean mask from the day map itself (blue-dominant pixels).
          float ocean = smoothstep(0.04, 0.16, day.b - max(day.r, day.g));
          vec3 H = normalize(L + V);
          float glint = pow(max(dot(N, H), 0.0), 80.0) * ocean * (1.0 - cloud) * smoothstep(0.0, 0.2, ndl);
          vec3 col = day * (diff * 1.3 + 0.012);
          col = mix(col, vec3(0.92, 0.93, 0.95) * (diff * 1.2 + 0.01), cloud * 0.92);
          col += vec3(1.0, 0.93, 0.82) * glint * 0.9;
          // City lights where it is dark; the blue land base kept faint.
          float city = smoothstep(0.03, 0.30, night.r);
          vec3 lights = night * (0.18 + 1.9 * city) * (1.0 - cloud * 0.75);
          col += lights * (1.0 - dayK);
          // Warm twilight band and thin Fresnel atmosphere rim on the lit limb.
          col += vec3(0.30, 0.10, 0.03) * exp(-pow(ndl / 0.05, 2.0)) * 0.012; // tiny: sRGB output lifts small values a lot
          float fres = pow(1.0 - max(dot(N, V), 0.0), 2.5);
          col = mix(col, vec3(0.32, 0.56, 1.0) * (smoothstep(-0.25, 0.5, ndl) * 0.7 + 0.02), fres * 0.7);
          // Until the textures arrive: the old graphite globe.
          vec3 fallback = vec3(0.07, 0.068, 0.062) * (diff * 2.5 + 0.12);
          col = mix(fallback, col, uReady);
          col = vec3(1.0) - exp(-col * 1.4); // soft filmic shoulder
          gl_FragColor = vec4(col, uAlpha);
          #include <colorspace_fragment>
        }`,
    });
    const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), this.earthMat);
    this.earthSpin.add(earth);
    const eg = this.buildEarthGraticule();
    this.earthSpin.add(eg);
    this.earthGroup.add(this.earthSpin);
    this.earthMats.push(eg.material as THREE.Material);

    // Atmosphere halo just outside the limb: analytic ray–sphere impact parameter, additive.
    this.atmoMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uSun: { value: new THREE.Vector3(1, 0, 0) }, uAlpha: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec3 vP;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vP = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uSun;
        uniform float uAlpha;
        varying vec3 vP;
        void main() {
          vec3 rd = normalize(vP - cameraPosition);
          float tc = dot(-cameraPosition, rd);
          vec3 closest = cameraPosition + rd * tc;
          float b = length(closest);
          float h = max(b - 1.0, 0.0);
          float k = exp(-h / 0.016) * (1.0 - smoothstep(1.03, 1.06, b));
          float lit = smoothstep(-0.35, 0.45, dot(normalize(closest), normalize(uSun)));
          vec3 c = vec3(0.30, 0.55, 1.0) * k * (0.02 + 0.42 * lit) * uAlpha; // matched to the globe rim: no bright ring at the limb
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.06, 96, 48), this.atmoMat);
    atmo.renderOrder = 1; // after the Earth, so its depth hides the halo behind the globe
    this.earthGroup.add(atmo);

    // ---------- Moon (NASA SVS CGI Moon Kit), true angular size, phase from the real Sun ----------
    this.moonMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: null }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uReady: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vN;
        void main() {
          vUv = uv;
          vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform sampler2D uMap;
        uniform vec3 uSun;
        uniform float uReady;
        varying vec2 vUv;
        varying vec3 vN;
        void main() {
          vec3 a = mix(vec3(0.16), texture2D(uMap, vUv).rgb, uReady);
          float d = max(dot(normalize(vN), normalize(uSun)), 0.0);
          vec3 col = a * (d * 1.9 + 0.006);
          col = vec3(1.0) - exp(-col * 1.5);
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.moonMat);
    this.scene.add(this.moon);

    // ---------- Sun and naked-eye planets: soft discs/PSFs sized by magnitude ----------
    this.bodyMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uPxPerDeg: { value: 10 }, uPx: { value: this.renderer.getPixelRatio() } },
      vertexShader: /* glsl */ `
        attribute float aMag;
        attribute float aDiam;
        attribute vec3 aColor;
        uniform float uPxPerDeg, uPx;
        varying vec3 vColor;
        varying float vDisc;
        varying float vGlow;
        void main() {
          float disc = aDiam * uPxPerDeg;              // true disc, px
          float s = sqrt(pow(10.0, -0.4 * (max(aMag, -6.0) + 1.0)));
          float glow = clamp(5.0 + 7.0 * s, 5.0, 26.0) * uPx;
          float size = max(disc * 2.6, glow);
          size = aMag < -20.0 ? max(size, 46.0 * uPx) : size;
          gl_PointSize = min(size, 512.0);
          vDisc = disc / max(gl_PointSize, 1.0);
          vGlow = aMag < -20.0 ? 1.0 : clamp(0.55 + 0.25 * s, 0.55, 1.0);
          vColor = aColor;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision mediump float;
        varying vec3 vColor;
        varying float vDisc;
        varying float vGlow;
        void main() {
          float r = length(gl_PointCoord - 0.5);       // 0..0.5 across the sprite
          float core = exp(-r * r * 90.0);
          float halo = exp(-r * 9.0) * 0.35;
          float disc = vDisc > 0.02 ? 1.0 - smoothstep(vDisc - 0.01, vDisc + 0.01, r) : 0.0;
          float a = max(disc, (core + halo) * vGlow) * smoothstep(0.5, 0.42, r);
          gl_FragColor = vec4(vColor * a, 1.0);
        }`,
    });
    const nB = 1 + PLANET_IDS.length;
    const bGeo = new THREE.BufferGeometry();
    bGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nB * 3), 3));
    bGeo.setAttribute('aMag', new THREE.BufferAttribute(new Float32Array(nB), 1));
    bGeo.setAttribute('aDiam', new THREE.BufferAttribute(new Float32Array(nB), 1));
    const tint: Record<string, [number, number, number]> = {
      sun: [1.0, 0.93, 0.8],
      mercury: [0.85, 0.82, 0.78],
      venus: [1.0, 0.97, 0.88],
      mars: [1.0, 0.62, 0.42],
      jupiter: [1.0, 0.92, 0.8],
      saturn: [1.0, 0.88, 0.66],
    };
    const cols = new Float32Array(nB * 3);
    ['sun', ...PLANET_IDS].forEach((id, i) => cols.set(tint[id], i * 3));
    bGeo.setAttribute('aColor', new THREE.BufferAttribute(cols, 3));
    this.bodyPoints = new THREE.Points(bGeo, this.bodyMat);
    this.bodyPoints.frustumCulled = false;
    this.bodyPoints.renderOrder = 1;
    this.scene.add(this.bodyPoints);

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

    this.sunLabel = this.addLabel(opts.labels.sun, new THREE.Vector3(), 'body', 'sun');
    this.bodyLabels.sun = this.sunLabel;
    this.bodyLabels.moon = this.addLabel(opts.labels.moon, new THREE.Vector3(), 'body', 'body');
    for (const id of PLANET_IDS) this.bodyLabels[id] = this.addLabel(opts.labels.planets[id], new THREE.Vector3(), 'body', 'body');
    this.scLabel = this.addLabel(opts.labels.spacecraft, new THREE.Vector3(), 'earth', 'craft');
    this.earthLabel = this.addLabel(opts.labels.earth, new THREE.Vector3(0, -1.18, 0), 'earth', 'craft');

    const now = new Date();
    this.todMs = now.getTime() % 86400000;
    this.updateCoverage(0);
    this.applyDate(now);
    this.loadTextures();

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
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x9a958c, transparent: true, opacity: 0.1 }));
  }

  private addLabel(text: string, pos: THREE.Vector3, kind: Label['kind'], cls: string): Label {
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

  /** Loads the Earth, Moon and Milky Way textures; the scene renders without them until they land. */
  private loadTextures() {
    const loader = new THREE.TextureLoader();
    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const load = (url: string, srgb: boolean, done: (t: THREE.Texture) => void) =>
      loader.load(
        url,
        (tex) => {
          if (this.disposed) return tex.dispose();
          tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          tex.anisotropy = aniso;
          this.textures.push(tex);
          done(tex);
          if (!this.active) this.render(performance.now());
        },
        undefined,
        () => {
          /* missing texture: keep the procedural fallback */
        },
      );
    const u = this.earthMat.uniforms;
    let pending = 2;
    const earthPart = () => {
      pending -= 1;
      if (pending === 0) u.uReady.value = 1;
    };
    load(COSMOS_TEXTURES.day, true, (t) => {
      u.uDay.value = t;
      earthPart();
    });
    load(COSMOS_TEXTURES.night, true, (t) => {
      u.uNight.value = t;
      earthPart();
    });
    load(COSMOS_TEXTURES.clouds, false, (t) => {
      u.uClouds.value = t;
      u.uHasClouds.value = 1;
    });
    load(COSMOS_TEXTURES.moon, true, (t) => {
      this.moonMat.uniforms.uMap.value = t;
      this.moonMat.uniforms.uReady.value = 1;
    });
    load(COSMOS_TEXTURES.milkyway, true, (t) => {
      this.mwMat.uniforms.uMap.value = t;
      this.mwMat.uniforms.uGain.value = 1;
    });
  }

  setLabels(labels: CosmosLabels) {
    this.opts.labels = labels;
    this.sunLabel.el.textContent = labels.sun;
    if (this.bodyLabels.moon) this.bodyLabels.moon.el.textContent = labels.moon;
    for (const id of PLANET_IDS) {
      const l = this.bodyLabels[id];
      if (l) l.el.textContent = labels.planets[id];
    }
    this.scLabel.el.textContent = labels.spacecraft;
    this.earthLabel.el.textContent = labels.earth;
    for (const l of this.labels) {
      if (l.el.dataset.k === 'ecl') l.el.textContent = labels.ecliptic;
      if (l.el.dataset.k === 'gal') l.el.textContent = labels.galactic;
    }
  }

  /** Illustrative sweep pattern for a survey day (low-precision solar longitude). */
  private updateCoverage(day: number) {
    const lam0 = sunEclipticLongitude(SURVEY_START);
    const lam = sunEclipticLongitude(new Date(SURVEY_START.getTime() + day * 86400000));
    let sweep = lam - lam0;
    if (sweep < 0) sweep += 360;
    this.coverageMat.uniforms.uL0.value = (lam0 + 90) * DEG;
    this.coverageMat.uniforms.uSweep.value = Math.min(sweep, 180) * DEG;
  }

  /** Moves the scene to a survey day; the clock leaves "live" and follows the timeline. */
  setDay(day: number) {
    this.day = Math.max(0, Math.min(SURVEY_DAYS, day));
    this.updateCoverage(this.day);
    this.live = false;
    // Whole days at a fixed UTC time of day: the globe does not strobe while the timeline plays.
    const t = SURVEY_START.getTime() + Math.floor(this.day) * 86400000 + this.todMs;
    if (t !== this.date.getTime()) this.applyDate(new Date(t));
  }

  /** Back to the wall clock. */
  setLive() {
    this.live = true;
    this.applyDate(new Date());
  }

  /**
   * Places the Sun, Moon and planets (astronomy-engine, computed) and spins the Earth
   * by sidereal time, so the day side faces the real Sun for this instant.
   */
  private applyDate(date: Date) {
    this.date = date;
    this.bodies = allBodies(date);
    const byId = Object.fromEntries(this.bodies.map((b) => [b.id, b])) as Record<BodyId, BodyState>;
    const sun = byId.sun;
    this.sunDir.set(...radecToScene(sun.ra, sun.dec, 1));
    this.sunLight.position.copy(this.sunDir).multiplyScalar(10);
    (this.earthMat.uniforms.uSun.value as THREE.Vector3).copy(this.sunDir);
    (this.atmoMat.uniforms.uSun.value as THREE.Vector3).copy(this.sunDir);
    (this.moonMat.uniforms.uSun.value as THREE.Vector3).copy(this.sunDir);
    // Dawn–dusk orbit: plane perpendicular to the Sun line.
    this.orbitLine.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.sunDir);
    // Greenwich (texture longitude 0, +X in mesh space) faces RA = sidereal time.
    this.earthSpin.rotation.y = siderealDeg(date) * DEG;
    this.subSolar = subSolarPoint(sun, date);

    // Sun + planets as points.
    const g = this.bodyPoints.geometry;
    const pos = g.attributes.position as THREE.BufferAttribute;
    const mag = g.attributes.aMag as THREE.BufferAttribute;
    const diam = g.attributes.aDiam as THREE.BufferAttribute;
    (['sun', ...PLANET_IDS] as BodyId[]).forEach((id, i) => {
      const b = byId[id];
      const p = radecToScene(b.ra, b.dec, BODY_R);
      pos.setXYZ(i, p[0], p[1], p[2]);
      mag.setX(i, b.mag);
      diam.setX(i, b.diamDeg);
      this.bodyLabels[id]?.pos.set(p[0], p[1], p[2]);
    });
    pos.needsUpdate = true;
    mag.needsUpdate = true;
    diam.needsUpdate = true;

    // Moon: textured sphere at its true angular size, near side towards the Earth.
    const m = byId.moon;
    this.moonPhase = m.phase;
    this.moonRadiusDeg = m.diamDeg / 2;
    const md = new THREE.Vector3(...radecToScene(m.ra, m.dec, 1));
    this.moon.position.copy(md).multiplyScalar(BODY_R);
    this.moon.scale.setScalar(BODY_R * Math.tan((m.diamDeg / 2) * DEG));
    const xAxis = md.clone().negate();
    const eclN = new THREE.Vector3(...radecToScene(270, 90 - 23.4393, 1));
    const zAxis = new THREE.Vector3().crossVectors(xAxis, eclN).normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    this.moon.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
    this.bodyLabels.moon?.pos.copy(md).multiplyScalar(BODY_R);
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
    } else if (this.live && t - this.lastClock > 1000) {
      // Live clock: the Earth turns and the Moon creeps in real time.
      this.lastClock = t;
      this.applyDate(new Date());
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
    this.earthMat.uniforms.uAlpha.value = earthAlpha;
    this.atmoMat.uniforms.uAlpha.value = earthAlpha;
    this.earthMat.depthWrite = earthAlpha > 0.98;
    const hPx = (this.canvas.clientHeight || 1) * this.renderer.getPixelRatio();
    this.bodyMat.uniforms.uPxPerDeg.value = hPx / this.camera.fov;
    // Milky Way: a quiet backdrop, dimmer when zoomed (the 2048 px map is ~0.18 deg/px).
    this.mwMat.uniforms.uGain.value = this.mwMat.uniforms.uMap.value ? 0.42 * (0.1 + 0.9 * smooth(6, 35, this.camera.fov)) : 0;
    const fine = 1 - smooth(8, 20, this.camera.fov);
    this.fineGrid.visible = fine > 0.01;
    (this.fineGrid.material as THREE.LineBasicMaterial).opacity = fine;
    this.starMat.uniforms.uZoom.value = Math.min(2.6, Math.max(1, Math.sqrt(40 / this.camera.fov)));

    this.renderer.render(this.scene, this.camera);
    this.placeLabels(earthAlpha);

    if (this.opts.onView && t - this.lastViewEmit > 90) {
      this.lastViewEmit = t;
      const c = this.viewCenter();
      this.opts.onView({
        mode: this.mode,
        ra: c.ra,
        dec: c.dec,
        fov: this.camera.fov,
        day: this.day,
        flying: !!this.flight,
        date: this.date.getTime(),
        live: this.live,
        subSolar: this.subSolar,
        moonPhase: this.moonPhase,
      });
    }
  }

  private placeLabels(earthAlpha: number) {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const camDir = this.camera.getWorldDirection(new THREE.Vector3());
    const showSky = this.camera.fov > 14;
    for (const l of this.labels) {
      let visible = l.kind === 'earth' ? earthAlpha > 0.5 : l.kind === 'body' || showSky;
      if (visible) {
        this.tmp.copy(l.pos);
        const toP = this.tmp.clone().sub(this.camera.position).normalize();
        if (toP.dot(camDir) < 0.05) visible = false;
        else {
          this.tmp.project(this.camera);
          // The Moon's label sits beside its disc, which is large when zoomed in.
          const dx = l === this.bodyLabels.moon ? (this.moonRadiusDeg / this.camera.fov) * h : 0;
          const x = (this.tmp.x * 0.5 + 0.5) * w + dx;
          const y = (-this.tmp.y * 0.5 + 0.5) * h;
          if (x < -40 || x > w + 40 || y < -20 || y > h + 20) visible = false;
          else l.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
        }
      }
      // Earth-system labels hidden behind the Earth disc.
      if (visible && ((l.kind === 'earth' && l !== this.earthLabel) || (l.kind === 'body' && earthAlpha > 0.5))) {
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
    for (const t of this.textures) t.dispose();
    this.renderer.dispose();
  }
}
