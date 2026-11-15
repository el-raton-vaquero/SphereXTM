import { parseRaDec } from './prism/coords';

/** Where a resolved position came from; the UI renders the label through the i18n layer. */
export type ResolveSource = 'coords' | 'local' | 'sesame';

export interface ResolvedTarget {
  name: string;
  ra: number;
  dec: number;
  source: ResolveSource;
  /** SIMBAD object type when resolved by CDS Sesame. */
  type?: string;
}

// Small offline lookup (J2000 catalogue positions) so common demo names resolve instantly.
// These are catalogue positions, not SPHEREx measurements.
const KNOWN_OBJECTS: Record<string, { ra: number; dec: number; name: string }> = {
  'barnard': { ra: 269.4521, dec: 4.6933, name: "Barnard's Star" },
  "barnard's star": { ra: 269.4521, dec: 4.6933, name: "Barnard's Star" },
  'estrella de barnard': { ra: 269.4521, dec: 4.6933, name: "Barnard's Star" },
  'wise 0855': { ra: 133.7951, dec: -7.2451, name: 'WISE 0855-0714' },
  'wise0855': { ra: 133.7951, dec: -7.2451, name: 'WISE 0855-0714' },
  'epsilon indi b': { ra: 331.0438, dec: -56.7828, name: 'Epsilon Indi B' },
  'eps ind b': { ra: 331.0438, dec: -56.7828, name: 'Epsilon Indi B' },
  'rw aur': { ra: 76.9564, dec: 30.4014, name: 'RW Aurigae' },
  'rw aurigae': { ra: 76.9564, dec: 30.4014, name: 'RW Aurigae' },
  'r dra': { ra: 248.1676, dec: 66.7551, name: 'R Draconis' },
  'r draconis': { ra: 248.1676, dec: 66.7551, name: 'R Draconis' },
  'm101': { ra: 210.80227, dec: 54.34895, name: 'M101' },
  'proxima centauri': { ra: 217.4289, dec: -62.6795, name: 'Proxima Centauri' },
  'luhman 16': { ra: 162.3288, dec: -53.3195, name: 'Luhman 16' },
  'teegarden': { ra: 43.2536, dec: 16.8997, name: "Teegarden's Star" },
  'trappist-1': { ra: 346.6224, dec: -5.0414, name: 'TRAPPIST-1' },
  'sirius': { ra: 101.2871, dec: -16.7161, name: 'Sirius' },
  'betelgeuse': { ra: 88.7929, dec: 7.4071, name: 'Betelgeuse' },
};

/** Resolve a typed coordinate pair, a known demo name, or (online) any name via CDS Sesame. */
export async function resolveTargetName(query: string): Promise<ResolvedTarget | null> {
  const q = query.trim();
  if (!q) return null;

  const coords = parseRaDec(q);
  if (coords) {
    return { name: `J${coords.ra.toFixed(3)}${coords.dec >= 0 ? '+' : ''}${coords.dec.toFixed(3)}`, ...coords, source: 'coords' };
  }

  const key = q.toLowerCase();
  const known = KNOWN_OBJECTS[key];
  if (known) return { name: known.name, ra: known.ra, dec: known.dec, source: 'local' };

  if (typeof window !== 'undefined' && navigator.onLine) {
    try {
      const url = `https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?${encodeURIComponent(q)}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (resp.ok) {
        const text = await resp.text();
        const ra = text.match(/<jradeg>([0-9.]+)<\/jradeg>/);
        const dec = text.match(/<jdedeg>([+-]?[0-9.]+)<\/jdedeg>/);
        const otype = text.match(/<otype>([^<]+)<\/otype>/);
        if (ra && dec) {
          return { name: q, ra: parseFloat(ra[1]), dec: parseFloat(dec[1]), source: 'sesame', type: otype?.[1].trim() };
        }
      }
    } catch {
      // Network blocked or timeout: fall through to the partial local match.
    }
  }

  for (const [k, obj] of Object.entries(KNOWN_OBJECTS)) {
    if (k.includes(key) || key.includes(k)) return { name: obj.name, ra: obj.ra, dec: obj.dec, source: 'local' };
  }
  return null;
}
