/** Links from a Star Match result to the other StarChord routes. */
import { writeUrl } from '../prism/url';
import { specToQuery, zenithOf } from '../song/sky';

export function exploreHref(ra: number, dec: number): string {
  return `/explore?${writeUrl({ ra: ((ra % 360) + 360) % 360, dec, fov: 4, mode: 'frame', embed: false })}`;
}

/**
 * /song takes a date and a place and uses the patch straight overhead. A spot (ra, dec) is
 * (almost exactly) overhead at latitude = dec when the local sidereal time equals its RA, so we
 * use Greenwich longitude and solve for the next such minute (precession since J2000 moves the
 * zenith by a few tenths of a degree, well inside the poster's 9 deg view). Null if no solution.
 */
export function songHref(ra: number, dec: number, dedication = ''): string | null {
  const lat = Math.max(-89.99, Math.min(89.99, dec)), lon = 0;
  let ms = Date.now();
  for (let i = 0; i < 4; i++) {
    const z = zenithOf({ lat, lon }, new Date(ms));
    let d = ra - z.ra;
    d = ((d % 360) + 540) % 360 - 180; // -180..180
    if (Math.abs(d) < 0.02) break;
    ms += (d / 360.9856) * 86400000;
  }
  const z = zenithOf({ lat, lon }, new Date(ms));
  if (Math.abs((((ra - z.ra) % 360) + 540) % 360 - 180) > 0.5) return null;
  const q = specToQuery({ ms, lat: +lat.toFixed(2), lon, zone: 'UTC', dedication });
  return `/song?${q}`;
}
