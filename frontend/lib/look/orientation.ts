/**
 * Stable phone pointing for /look.
 *
 * Problem with the naive approach (feeding absolute alpha/beta/gamma straight into the camera):
 *  - the magnetometer is noisy and jumps by tens of degrees near metal / when the phone moves,
 *  - iOS `webkitCompassHeading` is not consistent with the gyro Euler angles when the phone is held
 *    upright (exactly the "point at the sky" pose), so mixing them points the overlay wrongly,
 *  - Euler angles are degenerate near beta = 90 deg, so a tiny wobble swings alpha/gamma.
 *
 * Fix (complementary filter, the standard AR approach):
 *  - ORIENTATION comes from the gyro-fused *relative* attitude (`deviceorientation` on Chrome
 *    Android / iOS), turned into a rotation matrix (no Euler arithmetic after that point), which is
 *    smooth and responsive;
 *  - only the HEADING (one yaw angle about the local vertical) comes from the compass
 *    (`deviceorientationabsolute` or iOS `webkitCompassHeading`), and it is low-pass filtered over
 *    ~1.5 s, so magnetometer noise never shakes the view;
 *  - the output attitude is smoothed with an adaptive filter: heavy when the phone is still (no
 *    jitter), light when it moves fast (no lag).
 */
import type { V3 } from './sky';

export type M3x3 = V3[]; // row-major, device -> ENU (x East, y North, z Up)

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** W3C device->earth rotation R = Rz(alpha) Rx(beta) Ry(gamma), degrees. */
export function eulerToMatrix(alpha: number, beta: number, gamma: number): M3x3 {
  const a = alpha * D2R, b = beta * D2R, g = gamma * D2R;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  return [
    [ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg],
    [sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg],
    [-cb * sg, sb, cb * cg],
  ];
}

type Q = [number, number, number, number]; // x, y, z, w

function matToQuat(m: M3x3): Q {
  const t = m[0][0] + m[1][1] + m[2][2];
  let x: number, y: number, z: number, w: number;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    w = 0.25 * s; x = (m[2][1] - m[1][2]) / s; y = (m[0][2] - m[2][0]) / s; z = (m[1][0] - m[0][1]) / s;
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    w = (m[2][1] - m[1][2]) / s; x = 0.25 * s; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s;
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = 0.25 * s; z = (m[1][2] + m[2][1]) / s;
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = 0.25 * s;
  }
  const n = Math.hypot(x, y, z, w) || 1;
  return [x / n, y / n, z / n, w / n];
}

function quatToMat([x, y, z, w]: Q): M3x3 {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

function slerp(a: Q, b: Q, t: number): Q {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb: Q = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
  d = Math.abs(d);
  if (d > 0.9995) {
    const r: Q = [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t];
    const n = Math.hypot(...r) || 1;
    return [r[0] / n, r[1] / n, r[2] / n, r[3] / n];
  }
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}

const quatAngleDeg = (a: Q, b: Q) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * R2D;

function mul(a: M3x3, b: M3x3): M3x3 {
  const r: M3x3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
  return r;
}
const transpose = (m: M3x3): M3x3 => [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
/** Rotation about the local vertical (z, Up) by `deg`, counter-clockwise seen from above (East -> North). */
function rotZ(deg: number): M3x3 {
  const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R);
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}
const wrap180 = (d: number) => ((d + 540) % 360) - 180;
/** Azimuth (deg, clockwise from North) of device axis `v` under `m`, and its elevation component. */
function azOf(m: M3x3, v: V3): { az: number; up: number } {
  const e = m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2];
  const n = m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2];
  const u = m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2];
  return { az: Math.atan2(e, n) * R2D, up: u };
}

export type HeadingSource = 'compass' | 'none';

export interface OrientationState {
  /** Smoothed device->ENU matrix, heading referenced to (magnetic) North when a compass exists. */
  m: M3x3;
  heading: HeadingSource;
}

/**
 * Collects DeviceOrientation events and produces a smoothed, compass-referenced attitude.
 * Call `start()` after the iOS permission prompt, `read(now)` once per animation frame.
 */
export class OrientationTracker {
  private rel: M3x3 | null = null; // gyro-fused attitude, arbitrary yaw reference
  private relAt = 0;
  private absOnly: M3x3 | null = null; // absolute attitude when no relative stream exists
  private yawOff: number | null = null; // deg, CCW, maps rel -> true(magnetic) North
  private yawAt = 0;
  private out: Q | null = null;
  private outAt = 0;
  private lastHeadingAt = 0;
  private stopFns: (() => void)[] = [];
  onFirstSample: (() => void) | null = null;
  private gotFirst = false;

  start() {
    if (typeof window === 'undefined' || this.stopFns.length) return;
    const onRel = (e: DeviceOrientationEvent) => {
      if (e.alpha == null || e.beta == null || e.gamma == null) return;
      const m = eulerToMatrix(e.alpha, e.beta, e.gamma);
      const heading = (e as DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number });
      if (e.absolute) {
        // Firefox / some Androids: the "deviceorientation" stream is already absolute.
        this.absOnly = m;
        this.feedAbsolute(m);
      } else {
        this.rel = m;
        this.relAt = performance.now();
      }
      if (typeof heading.webkitCompassHeading === 'number' && Number.isFinite(heading.webkitCompassHeading)) {
        const acc = heading.webkitCompassAccuracy;
        if (acc == null || (acc >= 0 && acc <= 35)) this.feedIosHeading(m, heading.webkitCompassHeading);
      }
      this.first();
    };
    const onAbs = (e: DeviceOrientationEvent) => {
      if (e.alpha == null || e.beta == null || e.gamma == null) return;
      const m = eulerToMatrix(e.alpha, e.beta, e.gamma);
      this.absOnly = m;
      this.feedAbsolute(m);
      this.first();
    };
    window.addEventListener('deviceorientation', onRel);
    this.stopFns.push(() => window.removeEventListener('deviceorientation', onRel));
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', onAbs as EventListener);
      this.stopFns.push(() => window.removeEventListener('deviceorientationabsolute', onAbs as EventListener));
    }
  }

  stop() {
    this.stopFns.forEach((f) => f());
    this.stopFns = [];
  }

  private first() {
    if (!this.gotFirst) { this.gotFirst = true; this.onFirstSample?.(); }
  }

  /** A compass-referenced attitude arrived: update the yaw offset between it and the gyro attitude. */
  private feedAbsolute(abs: M3x3) {
    const now = performance.now();
    this.lastHeadingAt = now;
    if (!this.rel || now - this.relAt > 250) return; // no gyro stream: absOnly is used directly
    const d = mul(abs, transpose(this.rel));
    this.blendYaw(Math.atan2(d[1][0], d[0][0]) * R2D, now);
  }

  /**
   * iOS: `webkitCompassHeading` is the heading of the device top edge when the phone is flat and of
   * the rear camera when it is held up; ignore the ambiguous band in between.
   */
  private feedIosHeading(rel: M3x3, headingCw: number) {
    const now = performance.now();
    const top = azOf(rel, [0, 1, 0]);
    const back = azOf(rel, [0, 0, -1]);
    let azRel: number;
    if (Math.abs(back.up) < 0.55) azRel = back.az; // upright: the camera looks near the horizon
    else if (Math.abs(top.up) < 0.35 && Math.abs(back.up) > 0.8) azRel = top.az; // nearly flat
    else return;
    this.lastHeadingAt = now;
    // Rz(off) turns azimuths by -off (CW convention): want azRel - off = heading.
    this.blendYaw(azRel - headingCw, now);
  }

  private blendYaw(target: number, now: number) {
    if (this.yawOff == null) { this.yawOff = target; this.yawAt = now; return; }
    const dt = Math.min(0.5, (now - this.yawAt) / 1000);
    this.yawAt = now;
    const err = wrap180(target - this.yawOff);
    // ~1.5 s time constant, faster for large disagreements (first seconds, or after a compass recal).
    const tau = Math.abs(err) > 25 ? 0.4 : 1.5;
    this.yawOff = wrap180(this.yawOff + err * (1 - Math.exp(-dt / tau)));
  }

  /** Smoothed attitude for this frame, or null before the first sample. */
  read(now: number): OrientationState | null {
    let raw: M3x3 | null = null;
    let heading: HeadingSource = 'none';
    if (this.rel && now - this.relAt < 1000) {
      raw = this.yawOff == null ? this.rel : mul(rotZ(this.yawOff), this.rel);
      heading = this.yawOff != null ? 'compass' : 'none';
    } else if (this.absOnly) {
      raw = this.absOnly;
      heading = 'compass';
    }
    if (!raw) return null;
    const q = matToQuat(raw);
    if (!this.out) { this.out = q; this.outAt = now; }
    else {
      const dt = Math.min(0.1, Math.max(0.001, (now - this.outAt) / 1000));
      this.outAt = now;
      const speed = quatAngleDeg(this.out, q) / dt; // deg/s toward the target
      // Adaptive smoothing: 0.2 s when still (kills jitter), 0.03 s when turning fast (no lag).
      const tau = speed < 4 ? 0.2 : speed > 80 ? 0.03 : 0.2 - ((speed - 4) / 76) * 0.17;
      this.out = slerp(this.out, q, 1 - Math.exp(-dt / tau));
    }
    return { m: quatToMat(this.out), heading };
  }
}
