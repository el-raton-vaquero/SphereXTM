/**
 * Device-orientation look-around for /sky (magic-window and Cardboard modes).
 *
 * World frame of the sky scene: +Y = zenith, −Z = north, +X = east. With the W3C
 * deviceorientation angles (alpha about the vertical, counter-clockwise from north when the
 * event is absolute; beta front-back tilt; gamma left-right tilt) the classic three.js
 * DeviceOrientationControls formula gives a camera quaternion in exactly this frame.
 *
 * Heading: Android Chrome fires `deviceorientationabsolute` (alpha relative to magnetic north);
 * iOS Safari exposes `webkitCompassHeading` (clockwise from north). Without either, alpha is
 * relative to the phone's start orientation and `absolute` is false — the UI then says the
 * heading is approximate. Sensor-derived pointing is always labelled approximate.
 */
import * as THREE from 'three';

interface OrientationState {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  absolute: boolean;
}

type IOSOrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };
type PermissionCtor = { requestPermission?: () => Promise<'granted' | 'denied'> };

export function hasOrientationSensor(): boolean {
  return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
}

/** iOS 13+ needs an explicit permission request from a user gesture. */
export async function requestOrientationPermission(): Promise<boolean> {
  if (!hasOrientationSensor()) return false;
  const ctor = (window as unknown as { DeviceOrientationEvent: PermissionCtor }).DeviceOrientationEvent;
  if (typeof ctor.requestPermission === 'function') {
    try {
      return (await ctor.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }
  return true;
}

const zee = new THREE.Vector3(0, 0, 1);
const euler = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // −90° about X

function screenAngle(): number {
  const so = typeof screen !== 'undefined' ? screen.orientation : undefined;
  if (so && typeof so.angle === 'number') return so.angle;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? legacy : 0;
}

export class OrientationLook {
  private state: OrientationState = { alpha: null, beta: null, gamma: null, absolute: false };
  private sawAbsolute = false;
  private onAbs = (e: DeviceOrientationEvent) => {
    if (e.alpha === null) return;
    this.sawAbsolute = true;
    this.state = { alpha: e.alpha, beta: e.beta, gamma: e.gamma, absolute: true };
  };
  private onRel = (e: DeviceOrientationEvent) => {
    if (this.sawAbsolute) return;
    const ios = (e as IOSOrientationEvent).webkitCompassHeading;
    if (typeof ios === 'number' && Number.isFinite(ios)) {
      this.state = { alpha: 360 - ios, beta: e.beta, gamma: e.gamma, absolute: true };
    } else {
      this.state = { alpha: e.alpha, beta: e.beta, gamma: e.gamma, absolute: !!e.absolute };
    }
  };

  start(): void {
    window.addEventListener('deviceorientationabsolute' as 'deviceorientation', this.onAbs as EventListener);
    window.addEventListener('deviceorientation', this.onRel);
  }

  stop(): void {
    window.removeEventListener('deviceorientationabsolute' as 'deviceorientation', this.onAbs as EventListener);
    window.removeEventListener('deviceorientation', this.onRel);
  }

  get hasData(): boolean {
    return this.state.alpha !== null && this.state.beta !== null;
  }

  get absolute(): boolean {
    return this.state.absolute;
  }

  /** Write the device pose into `q`; returns false until the first event arrives. */
  apply(q: THREE.Quaternion): boolean {
    const { alpha, beta, gamma } = this.state;
    if (alpha === null || beta === null || gamma === null) return false;
    const D = Math.PI / 180;
    euler.set(beta * D, alpha * D, -gamma * D, 'YXZ');
    q.setFromEuler(euler);
    q.multiply(q1);
    q.multiply(q0.setFromAxisAngle(zee, -screenAngle() * D));
    return true;
  }
}
