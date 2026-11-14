import type { V2Target } from './types';

/**
 * Offline fallback for /v2/targets. ra/dec are copied from server/spherex/data/prism-targets.json
 * (the /v2/targets source: Gaia DR3 / SIMBAD resolved live, propagated with astropy
 * apply_space_motion to MJD 61000 = 2025-11-21). Snapshots are centred on the same positions.
 * Positions are catalogue predictions used as field centres, not detections.
 */
export interface PresetPm { ra_cosdec_masyr: number; dec_masyr: number; ref_mjd: number; source: string }

export const PRESETS: (V2Target & { blurb_en: string; why_en: string; pm?: PresetPm })[] = [
  {
    id: 'wise-0855', name: 'WISE 0855−0714', ra: 133.7600206, dec: -7.2422032, category: 'Y dwarf',
    epoch: 'MJD 61000 (prop.)', coord_source: 'Luhman 2014 astrometry + PM (registry)',
    blurb: 'La enana café más fría conocida (~285 K). Sólo brilla a 4–5 µm.',
    blurb_en: 'Coldest known brown dwarf (~285 K). Only bright at 4–5 µm.',
    why: 'Movimiento propio 8,1″/año ≈ 1,3 px/año: busque en D5/D6.',
    why_en: 'Proper motion 8.1″/yr ≈ 1.3 px/yr: look in D5/D6.',
    expected: { pm_arcsec_yr: 8.1, saturated: false, best_detectors: [5, 6] },
    pm: { ra_cosdec_masyr: -8060, dec_masyr: 700, ref_mjd: 61000, source: 'Luhman 2014' },
  },
  {
    id: 'barnard', name: "Barnard's Star", ra: 269.4462920, dec: 4.7678988, category: 'M dwarf',
    epoch: 'MJD 61000 (prop.)', coord_source: 'Gaia DR3 4472832130942575872 (registry)',
    blurb: 'La estrella con mayor movimiento propio del cielo.',
    blurb_en: 'The highest proper-motion star in the sky.',
    why: '10,4″/año, pero satura el detector (K≈4,5): el núcleo es inutilizable.',
    why_en: '10.4″/yr, but saturates the detector (K≈4.5): the core is unusable.',
    expected: { pm_arcsec_yr: 10.4, saturated: true, best_detectors: [1, 2] },
    pm: { ra_cosdec_masyr: -801.55, dec_masyr: 10362.39, ref_mjd: 61000, source: 'Gaia DR3' },
  },
  {
    id: 'eps-indi-b', name: 'Epsilon Indi B', ra: 331.0964267, dec: -56.8005859, category: 'T dwarf binary',
    epoch: 'MJD 61000 (prop.)', coord_source: 'SIMBAD (Gaia DR3) + PM',
    blurb: 'Par de enanas T a 3,6 pc, compañeras de ε Indi A.',
    blurb_en: 'Pair of T dwarfs at 3.6 pc, companions of ε Indi A.',
    why: '4,7″/año; fantasmas y diafonía de ε Indi A cerca.',
    why_en: '4.7″/yr; ghosts and crosstalk from nearby ε Indi A.',
    expected: { pm_arcsec_yr: 4.7, saturated: false, best_detectors: [2, 3, 5] },
    pm: { ra_cosdec_masyr: 3981.98, dec_masyr: -2466.83, ref_mjd: 61000, source: 'SIMBAD (Gaia DR3)' },
  },
  {
    id: 'rw-aur', name: 'RW Aurigae', ra: 76.9565863, dec: 30.4012920, category: 'T Tauri variable',
    epoch: 'MJD 61000 (prop.)', coord_source: 'SIMBAD + PM',
    blurb: 'Estrella joven con eclipses profundos por polvo.',
    blurb_en: 'Young star with deep dust dimming events.',
    why: 'Variable, pero satura en varios detectores: compare con cautela.',
    why_en: 'Variable, but saturates in several detectors: compare with care.',
    expected: { saturated: true, best_detectors: [5, 6] },
  },
  {
    id: 'r-dra', name: 'R Draconis', ra: 248.1672347, dec: 66.7550236, category: 'Mira variable',
    epoch: 'MJD 61000 (prop.)', coord_source: 'SIMBAD (Gaia DR3) + PM',
    blurb: 'Mira de periodo ~246 días.',
    blurb_en: 'Mira variable, period ~246 days.',
    why: 'Cambia de brillo entre temporadas; muy brillante, satura.',
    why_en: 'Changes brightness between seasons; very bright, saturates.',
    expected: { saturated: true, best_detectors: [1, 2] },
  },
  {
    id: 'm101', name: 'M101', ra: 210.8024292, dec: 54.3487500, category: 'Galaxy',
    epoch: 'J2000', coord_source: 'SIMBAD',
    blurb: 'Galaxia espiral: campo estático de control.',
    blurb_en: 'Spiral galaxy: a static control field.',
    why: 'Nada debería moverse aquí: cualquier "cambio" es color o artefacto.',
    why_en: 'Nothing should move here: any "change" is colour or artifact.',
    expected: { saturated: false, best_detectors: [1, 2, 3] },
  },
];
