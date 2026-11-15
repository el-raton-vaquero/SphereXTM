/**
 * Phone pointing for /look: DeviceOrientation (alpha, beta, gamma) -> camera basis in the local
 * ENU frame (x = East, y = North, z = Up), plus a pinhole projection for the overlay.
 *
 * W3C device frame: x = right edge of the screen, y = top edge, z = out of the screen (toward
 * the user). Earth frame: X = East, Y = North, Z = Up. The device->earth rotation is
 *   R = Rz(alpha) * Rx(beta) * Ry(gamma)
 * The rear camera looks along device -z. Screen "up"/"right" follow screen.orientation.angle.
 *
 * The result is APPROXIMATE: phone compasses are typically off by 5-15 deg (magnetic declination
 * and local interference are not corrected), which is why the UI offers an azimuth offset.
 */
import { D2R, R2D, altAzToEnu, enuToAltAz, type V3 } from './sky';

export interface CamBasis { f: V3; u: V3; r: V3 } // forward, screen-up, screen-right (ENU)

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3): V3 => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };

/** Device->earth rotation matrix (row-major) from W3C Euler angles in degrees. */
function deviceMatrix(alpha: number, beta: number, gamma: number): V3[] {
  const a = alpha * D2R, b = beta * D2R, g = gamma * D2R;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  // Rz(a) * Rx(b) * Ry(g)
  return [
    [ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg],
    [sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg],
    [-cb * sg, sb, cb * cg],
  ];
}

const apply = (m: V3[], v: V3): V3 => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];

/**
 * Camera basis from device orientation. `alphaNorth` must already be referenced to North
 * (absolute orientation or iOS compass); `screenAngle` is screen.orientation.angle (0/90/180/270).
 */
export function basisFromOrientation(alphaNorth: number, beta: number, gamma: number, screenAngle: number): CamBasis {
  return basisFromMatrix(deviceMatrix(alphaNorth, beta, gamma), screenAngle);
}

/** Camera basis from a device->ENU rotation matrix (see lib/look/orientation.ts). */
export function basisFromMatrix(m: V3[], screenAngle: number): CamBasis {
  const th = screenAngle * D2R;
  // Screen axes expressed in device coordinates after the UI rotates by screenAngle.
  const upDev: V3 = [Math.sin(th), Math.cos(th), 0];
  const rightDev: V3 = [Math.cos(th), -Math.sin(th), 0];
  const f = unit(apply(m, [0, 0, -1]));
  const u = unit(apply(m, upDev));
  const r = unit(apply(m, rightDev));
  return { f, u, r };
}

/** Camera basis looking at (alt, az) with the horizon level and a roll of 0. */
export function basisFromAltAz(alt: number, az: number): CamBasis {
  const f = altAzToEnu(alt, az);
  // right = horizontal, 90 deg clockwise of the azimuth; up = right x forward... keep right-handed: r = f x u
  const r: V3 = [Math.cos(az * D2R), -Math.sin(az * D2R), 0];
  const u = unit(cross(r, f));
  return { f, u, r };
}

/** Rotate a basis about the local zenith by `deg` (positive = toward East). Used for compass correction. */
export function yawBasis(b: CamBasis, deg: number): CamBasis {
  if (!deg) return b;
  const c = Math.cos(-deg * D2R), s = Math.sin(-deg * D2R);
  const rot = (v: V3): V3 => [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
  return { f: rot(b.f), u: rot(b.u), r: rot(b.r) };
}

/** Tilt a basis up/down by `deg` about its right axis (positive = up). Used for manual altitude trim. */
export function pitchBasis(b: CamBasis, deg: number): CamBasis {
  if (!deg) return b;
  const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R);
  const f = unit([b.f[0] * c + b.u[0] * s, b.f[1] * c + b.u[1] * s, b.f[2] * c + b.u[2] * s]);
  const u = unit(cross(b.r, f));
  return { f, u, r: b.r };
}

export interface View { w: number; h: number; vfov: number } // px, px, degrees (vertical)

export const focalPx = (v: View) => (v.h / 2) / Math.tan((v.vfov * D2R) / 2);

/** ENU direction -> screen px, or null when behind the camera. */
export function project(b: CamBasis, v: View, dir: V3): { x: number; y: number } | null {
  const z = dot(dir, b.f);
  if (z <= 1e-3) return null;
  const fp = focalPx(v);
  return { x: v.w / 2 + (dot(dir, b.r) / z) * fp, y: v.h / 2 - (dot(dir, b.u) / z) * fp };
}

/** Screen px -> ENU unit direction. */
export function unproject(b: CamBasis, v: View, x: number, y: number): V3 {
  const fp = focalPx(v);
  const dx = (x - v.w / 2) / fp, dy = -(y - v.h / 2) / fp;
  return unit([b.f[0] + b.r[0] * dx + b.u[0] * dy, b.f[1] + b.r[1] * dx + b.u[1] * dy, b.f[2] + b.r[2] * dx + b.u[2] * dy]);
}

/** Roll of the camera: angle of screen-up from the local vertical plane, degrees (0 = level). */
export function rollDeg(b: CamBasis): number {
  // Horizontal right reference for the forward direction:
  const { az } = enuToAltAz(b.f);
  const hr: V3 = [Math.cos(az * D2R), -Math.sin(az * D2R), 0];
  const up = unit(cross(hr, b.f));
  return Math.atan2(dot(b.u, hr), dot(b.u, up)) * R2D;
}

export { cross, dot, unit };
