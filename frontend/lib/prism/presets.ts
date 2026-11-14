import type { V2Target } from './types';

/**
 * Offline fallback for /v2/targets. Coordinates: CDS Sesame/SIMBAD (Gaia DR3 astrometry where
 * available, J2000 epoch) propagated with catalogue proper motion to MJD 60900 (2025-08) to centre
 * the SPHEREx field; WISE 0855 and Barnard use the repository registry
 * (server/spherex/data/m4-targets.json). Positions are field centres, not detections.
 */
export interface PresetPm { ra_cosdec_masyr: number; dec_masyr: number; ref_mjd: number; source: string }

export const PRESETS: (V2Target & { blurb_en: string; why_en: string; pm?: PresetPm })[] = [
  {
    id: 'wise-0855', name: 'WISE 0855−0714', ra: 133.760993, dec: -7.242202, category: 'Y dwarf',
    epoch: 'MJD 60900 (prop.)', coord_source: 'Luhman 2014 astrometry + PM (registry)',
    blurb: 'La enana café más fría conocida (~285 K). Sólo brilla a 4–5 µm.',
    blurb_en: 'Coldest known brown dwarf (~285 K). Only bright at 4–5 µm.',
    why: 'Movimiento propio 8,1″/año ≈ 1,3 px/año: busque en D5/D6.',
    why_en: 'Proper motion 8.1″/yr ≈ 1.3 px/yr: look in D5/D6.',
    expected: { pm_arcsec_yr: 8.1, saturated: false, best_detectors: [5, 6] },
    pm: { ra_cosdec_masyr: -8060, dec_masyr: 700, ref_mjd: 60900, source: 'Luhman 2014' },
  },
  {
    id: 'barnard', name: "Barnard's Star", ra: 269.446353, dec: 4.767110, category: 'M dwarf',
    epoch: 'MJD 60900 (prop.)', coord_source: 'Gaia DR3 4472832130942575872 (registry)',
    blurb: 'La estrella con mayor movimiento propio del cielo.',
    blurb_en: 'The highest proper-motion star in the sky.',
    why: '10,4″/año, pero satura el detector (K≈4,5): el núcleo es inutilizable.',
    why_en: '10.4″/yr, but saturates the detector (K≈4.5): the core is unusable.',
    expected: { pm_arcsec_yr: 10.4, saturated: true, best_detectors: [1, 2] },
    pm: { ra_cosdec_masyr: -801.55, dec_masyr: 10362.39, ref_mjd: 60900, source: 'Gaia DR3' },
  },
  {
    id: 'eps-indi-b', name: 'Epsilon Indi B', ra: 331.095889, dec: -56.800385, category: 'T dwarf binary',
    epoch: 'MJD 60900 (prop.)', coord_source: 'SIMBAD (Gaia DR3) + PM',
    blurb: 'Par de enanas T a 3,6 pc, compañeras de ε Indi A.',
    blurb_en: 'Pair of T dwarfs at 3.6 pc, companions of ε Indi A.',
    why: '4,7″/año; fantasmas y diafonía de ε Indi A cerca.',
    why_en: '4.7″/yr; ghosts and crosstalk from nearby ε Indi A.',
    expected: { pm_arcsec_yr: 4.7, saturated: false, best_detectors: [2, 3, 5] },
    pm: { ra_cosdec_masyr: 3981.98, dec_masyr: -2466.83, ref_mjd: 60900, source: 'SIMBAD (Gaia DR3)' },
  },
  {
    id: 'rw-aur', name: 'RW Aurigae', ra: 76.956586, dec: 30.401294, category: 'T Tauri variable',
    epoch: 'MJD 60900 (prop.)', coord_source: 'SIMBAD + PM',
    blurb: 'Estrella joven con eclipses profundos por polvo.',
    blurb_en: 'Young star with deep dust dimming events.',
    why: 'Variable, pero satura en varios detectores: compare con cautela.',
    why_en: 'Variable, but saturates in several detectors: compare with care.',
    expected: { saturated: true, best_detectors: [5, 6] },
  },
  {
    id: 'r-dra', name: 'R Draconis', ra: 248.167239, dec: 66.755023, category: 'Mira variable',
    epoch: 'MJD 60900 (prop.)', coord_source: 'SIMBAD (Gaia DR3) + PM',
    blurb: 'Mira de periodo ~246 días.',
    blurb_en: 'Mira variable, period ~246 days.',
    why: 'Cambia de brillo entre temporadas; muy brillante, satura.',
    why_en: 'Changes brightness between seasons; very bright, saturates.',
    expected: { saturated: true, best_detectors: [1, 2] },
  },
  {
    id: 'm101', name: 'M101', ra: 210.802429, dec: 54.348750, category: 'Galaxy',
    epoch: 'J2000', coord_source: 'SIMBAD',
    blurb: 'Galaxia espiral: campo estático de control.',
    blurb_en: 'Spiral galaxy: a static control field.',
    why: 'Nada debería moverse aquí: cualquier "cambio" es color o artefacto.',
    why_en: 'Nothing should move here: any "change" is colour or artifact.',
    expected: { saturated: false, best_detectors: [1, 2, 3] },
  },
];
