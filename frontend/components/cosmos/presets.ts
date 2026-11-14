/**
 * Hard-coded fly-to presets for /cosmos.
 *
 * Coordinates were resolved on 2026-11-14 with CDS Sesame (SIMBAD, ICRS,
 * epoch J2000.0) except WISE 0855, which uses the position given in the
 * Space Apps challenge statement (08h55m10.831s −07°14′42.53″, the WISE-era
 * detection; SIMBAD's J2000 back-propagated position differs by ~1.4′ because
 * of its 8″/yr proper motion). The integrator reconciles these with
 * GET /v2/targets; the backend list is authoritative for science.
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
    ra: 269.45207696,
    dec: 4.69336497,
    epoch: 'J2000 · SIMBAD',
    aliases: ['barnard', 'estrella de barnard', "barnard's star", 'gj 699'],
    kind: { es: 'movimiento propio 10.4″/año', en: 'proper motion 10.4″/yr' },
  },
  {
    id: 'eps-indi-b',
    name: 'ε Indi B',
    ra: 331.04414659,
    dec: -56.7828442,
    epoch: 'J2000 · SIMBAD',
    aliases: ['eps indi b', 'epsilon indi b', 'eps ind b', 'ε indi b'],
    kind: { es: 'enanas marrones binarias', en: 'binary brown dwarfs' },
  },
  {
    id: 'wise-0855',
    name: 'WISE 0855−0714',
    ra: 133.795129,
    dec: -7.245147,
    epoch: 'reto Space Apps (época WISE)',
    aliases: ['wise 0855', 'wise0855', 'wise j085510.83-071442.5', 'wise 0855-0714'],
    kind: { es: 'enana marrón fría, 8.1″/año', en: 'cold brown dwarf, 8.1″/yr' },
  },
  {
    id: 'rw-aur',
    name: 'RW Aurigae',
    ra: 76.95652603,
    dec: 30.40143817,
    epoch: 'J2000 · SIMBAD',
    aliases: ['rw aur', 'rw aurigae'],
    kind: { es: 'variable T Tauri', en: 'T Tauri variable' },
  },
  {
    id: 'r-dra',
    name: 'R Draconis',
    ra: 248.16761083,
    dec: 66.75497942,
    epoch: 'J2000 · SIMBAD',
    aliases: ['r dra', 'r draconis'],
    kind: { es: 'variable Mira', en: 'Mira variable' },
  },
  {
    id: 'm101',
    name: 'M101',
    ra: 210.80242917,
    dec: 54.34875,
    epoch: 'J2000 · SIMBAD',
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
  const mirrors = [
    'https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?',
    'https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/SNV?',
  ];
  for (const base of mirrors) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      signal?.addEventListener('abort', () => ctl.abort());
      const res = await fetch(base + encodeURIComponent(name), { signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const text = await res.text();
      const ra = text.match(/<jradeg>\s*([0-9.]+)\s*<\/jradeg>/);
      const de = text.match(/<jdedeg>\s*([+-]?[0-9.]+)\s*<\/jdedeg>/);
      if (ra && de) return { ra: parseFloat(ra[1]), dec: parseFloat(de[1]), source: 'CDS Sesame' };
      return null;
    } catch {
      if (signal?.aborted) return null;
    }
  }
  return null;
}
