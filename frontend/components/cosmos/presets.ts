/**
 * Fly-to presets for the 3D landing. ra/dec are copied from
 * server/spherex/data/prism-targets.json (the GET /v2/targets source: Gaia DR3 / SIMBAD
 * resolved live, propagated with astropy apply_space_motion to MJD 61000 = 2025-11-21), so
 * the landing, the explorer presets and the cached snapshots share one field centre.
 * These are catalogue predictions, not detections.
 */
export type CosmosPresetId = 'barnard' | 'eps-indi-b' | 'wise-0855' | 'rw-aur' | 'r-dra' | 'm101';

export interface CosmosPreset {
  id: CosmosPresetId;
  name: string;
  ra: number; // deg
  dec: number; // deg
  epoch: string;
  aliases: string[];
  kind: { es: string; en: string };
}

export const COSMOS_PRESETS: CosmosPreset[] = [
  {
    id: 'barnard',
    name: "Barnard's Star",
    ra: 269.4462920,
    dec: 4.7678988,
    epoch: 'MJD 61000 · /v2/targets',
    aliases: ['barnard', 'estrella de barnard', "barnard's star", 'gj 699'],
    kind: { es: 'movimiento propio 10.4″/año', en: 'proper motion 10.4″/yr' },
  },
  {
    id: 'eps-indi-b',
    name: 'ε Indi B',
    ra: 331.0964267,
    dec: -56.8005859,
    epoch: 'MJD 61000 · /v2/targets',
    aliases: ['eps indi b', 'epsilon indi b', 'eps ind b', 'ε indi b'],
    kind: { es: 'enanas marrones binarias', en: 'binary brown dwarfs' },
  },
  {
    id: 'wise-0855',
    name: 'WISE 0855−0714',
    ra: 133.7600206,
    dec: -7.2422032,
    epoch: 'MJD 61000 · /v2/targets',
    aliases: ['wise 0855', 'wise0855', 'wise j085510.83-071442.5', 'wise 0855-0714'],
    kind: { es: 'enana marrón fría, 8.2″/año', en: 'cold brown dwarf, 8.2″/yr' },
  },
  {
    id: 'rw-aur',
    name: 'RW Aurigae',
    ra: 76.9565863,
    dec: 30.4012920,
    epoch: 'MJD 61000 · /v2/targets',
    aliases: ['rw aur', 'rw aurigae'],
    kind: { es: 'variable T Tauri', en: 'T Tauri variable' },
  },
  {
    id: 'r-dra',
    name: 'R Draconis',
    ra: 248.1672347,
    dec: 66.7550236,
    epoch: 'MJD 61000 · /v2/targets',
    aliases: ['r dra', 'r draconis'],
    kind: { es: 'variable Mira', en: 'Mira variable' },
  },
  {
    id: 'm101',
    name: 'M101',
    ra: 210.8024292,
    dec: 54.3487500,
    epoch: 'MJD 61000 · /v2/targets',
    aliases: ['m101', 'm 101', 'ngc 5457', 'pinwheel', 'molinete'],
    kind: { es: 'galaxia espiral (fija)', en: 'spiral galaxy (static)' },
  },
];

export function findPreset(query: string): CosmosPreset | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return (
    COSMOS_PRESETS.find((p) => p.id === q || p.aliases.includes(q) || p.name.toLowerCase() === q) ??
    COSMOS_PRESETS.find((p) => p.aliases.some((a) => a.startsWith(q)) || p.name.toLowerCase().startsWith(q))
  );
}

/** Resolve an arbitrary name with CDS Sesame (browser fetch, CORS-enabled mirrors). */
export async function resolveWithSesame(name: string, signal?: AbortSignal): Promise<{ ra: number; dec: number; source: string } | null> {
  // Query the mirrors in parallel and take the first answer that carries coordinates
  // (cds.unistra.fr answers with a cross-origin redirect that some browsers abort).
  const mirrors = [
    'https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/SNV?',
    'https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?',
  ];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  const one = async (base: string) => {
    const res = await fetch(base + encodeURIComponent(name), { signal: ctl.signal });
    if (!res.ok) throw new Error(String(res.status));
    const text = await res.text();
    const ra = text.match(/<jradeg>\s*([0-9.]+)\s*<\/jradeg>/);
    const de = text.match(/<jdedeg>\s*([+-]?[0-9.]+)\s*<\/jdedeg>/);
    if (!ra || !de) throw new Error('no coordinates');
    return { ra: parseFloat(ra[1]), dec: parseFloat(de[1]), source: 'CDS Sesame' };
  };
  try {
    return await Promise.any(mirrors.map(one));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    ctl.abort();
  }
}
