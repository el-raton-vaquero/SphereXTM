// The 6-stop wavelength ramp (tokens --p-l1..--p-l6). Colour encodes λ ONLY.
export const RAMP_STOPS: { um: number; hex: string }[] = [
  { um: 0.75, hex: '#5b6cff' },
  { um: 1.36, hex: '#3fb6e8' },
  { um: 2.02, hex: '#59d1a0' },
  { um: 3.12, hex: '#d9d45b' },
  { um: 4.12, hex: '#f29a3e' },
  { um: 5.0, hex: '#e5533d' },
];

export const DETECTOR_HEX = ['#5b6cff', '#3fb6e8', '#59d1a0', '#d9d45b', '#f29a3e', '#e5533d'];
export const DETECTOR_RANGES: [number, number][] = [
  [0.75, 1.09], [1.1, 1.62], [1.63, 2.41], [2.42, 3.82], [3.83, 4.41], [4.42, 5.0],
];
export const LAMBDA_MIN = 0.7;
export const LAMBDA_MAX = 5.05;

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Interpolated ramp colour for a wavelength in µm. */
export function lambdaColor(um: number): string {
  const s = RAMP_STOPS;
  if (um <= s[0].um) return s[0].hex;
  if (um >= s[s.length - 1].um) return s[s.length - 1].hex;
  for (let i = 0; i < s.length - 1; i++) {
    if (um <= s[i + 1].um) {
      const t = (um - s[i].um) / (s[i + 1].um - s[i].um);
      const a = hexToRgb(s[i].hex), b = hexToRgb(s[i + 1].hex);
      const c = a.map((v, k) => Math.round(v + (b[k] - v) * t));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return s[0].hex;
}

export function detectorColor(det: number): string {
  return DETECTOR_HEX[Math.min(5, Math.max(0, det - 1))];
}
