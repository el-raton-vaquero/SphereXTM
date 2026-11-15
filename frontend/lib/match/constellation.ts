/**
 * "Which constellation is this near?" without new dependencies: the nearest constellation stick
 * figure (public/sky/constellations.json, d3-celestial lines snapped to BSC5 stars in
 * public/cosmos/bsc5.bin). This is the nearest figure, not the official IAU boundary, so the UI
 * says "near <name>".
 */
import { loadStarCatalog, type StarCatalog } from '../../components/cosmos/stars';

/** IAU names (Latin, used in both languages). */
export const CONSTELLATION_NAMES: Record<string, string> = {
  And: 'Andromeda', Ant: 'Antlia', Aps: 'Apus', Aqr: 'Aquarius', Aql: 'Aquila', Ara: 'Ara', Ari: 'Aries', Aur: 'Auriga',
  Boo: 'Boötes', Cae: 'Caelum', Cam: 'Camelopardalis', Cnc: 'Cancer', CVn: 'Canes Venatici', CMa: 'Canis Major',
  CMi: 'Canis Minor', Cap: 'Capricornus', Car: 'Carina', Cas: 'Cassiopeia', Cen: 'Centaurus', Cep: 'Cepheus', Cet: 'Cetus',
  Cha: 'Chamaeleon', Cir: 'Circinus', Col: 'Columba', Com: 'Coma Berenices', CrA: 'Corona Australis', CrB: 'Corona Borealis',
  Crv: 'Corvus', Crt: 'Crater', Cru: 'Crux', Cyg: 'Cygnus', Del: 'Delphinus', Dor: 'Dorado', Dra: 'Draco', Equ: 'Equuleus',
  Eri: 'Eridanus', For: 'Fornax', Gem: 'Gemini', Gru: 'Grus', Her: 'Hercules', Hor: 'Horologium', Hya: 'Hydra', Hyi: 'Hydrus',
  Ind: 'Indus', Lac: 'Lacerta', Leo: 'Leo', LMi: 'Leo Minor', Lep: 'Lepus', Lib: 'Libra', Lup: 'Lupus', Lyn: 'Lynx', Lyr: 'Lyra',
  Men: 'Mensa', Mic: 'Microscopium', Mon: 'Monoceros', Mus: 'Musca', Nor: 'Norma', Oct: 'Octans', Oph: 'Ophiuchus', Ori: 'Orion',
  Pav: 'Pavo', Peg: 'Pegasus', Per: 'Perseus', Phe: 'Phoenix', Pic: 'Pictor', Psc: 'Pisces', PsA: 'Piscis Austrinus', Pup: 'Puppis',
  Pyx: 'Pyxis', Ret: 'Reticulum', Sge: 'Sagitta', Sgr: 'Sagittarius', Sco: 'Scorpius', Scl: 'Sculptor', Sct: 'Scutum',
  Ser: 'Serpens', Sex: 'Sextans', Tau: 'Taurus', Tel: 'Telescopium', Tri: 'Triangulum', TrA: 'Triangulum Australe',
  Tuc: 'Tucana', UMa: 'Ursa Major', UMi: 'Ursa Minor', Vel: 'Vela', Vir: 'Virgo', Vol: 'Volans', Vul: 'Vulpecula',
};

type V3 = [number, number, number];
interface Seg { abbr: string; a: V3; b: V3 }

const unit = (raDeg: number, decDeg: number): V3 => {
  const a = (raDeg * Math.PI) / 180, d = (decDeg * Math.PI) / 180;
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
const ang = (a: V3, b: V3) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));

/** Angular distance from p to the great-circle arc a-b (radians). */
function arcDistance(p: V3, a: V3, b: V3): number {
  const n = norm(cross(a, b));
  const d = Math.asin(Math.max(-1, Math.min(1, dot(p, n))));
  const proj = norm([p[0] - n[0] * Math.sin(d), p[1] - n[1] * Math.sin(d), p[2] - n[2] * Math.sin(d)]);
  const ab = ang(a, b);
  if (Math.abs(ang(a, proj) + ang(proj, b) - ab) < 1e-6) return Math.abs(d);
  return Math.min(ang(p, a), ang(p, b));
}

let segsP: Promise<Seg[]> | null = null;
function loadSegments(): Promise<Seg[]> {
  if (segsP) return segsP;
  segsP = Promise.all([
    loadStarCatalog(),
    fetch('/sky/constellations.json').then((r) => { if (!r.ok) throw new Error(`constellations.json HTTP ${r.status}`); return r.json() as Promise<{ lines: Record<string, number[]> }>; }),
  ]).then(([cat, j]: [StarCatalog, { lines: Record<string, number[]> }]) => {
    const segs: Seg[] = [];
    for (const [abbr, idx] of Object.entries(j.lines)) {
      for (let i = 0; i + 1 < idx.length; i += 2) {
        const s = idx[i], e = idx[i + 1];
        if (s >= cat.n || e >= cat.n) continue;
        segs.push({ abbr, a: unit(cat.ra[s], cat.dec[s]), b: unit(cat.ra[e], cat.dec[e]) });
      }
    }
    return segs;
  });
  segsP.catch(() => { segsP = null; });
  return segsP;
}

/** Nearest constellation figure to (ra, dec): IAU abbreviation, name and distance (deg). */
export async function nearestConstellation(ra: number, dec: number): Promise<{ abbr: string; name: string; distDeg: number } | null> {
  const segs = await loadSegments();
  const p = unit(ra, dec);
  let best: Seg | null = null, bd = Infinity;
  for (const s of segs) {
    const d = arcDistance(p, s.a, s.b);
    if (d < bd) { bd = d; best = s; }
  }
  return best ? { abbr: best.abbr, name: CONSTELLATION_NAMES[best.abbr] ?? best.abbr, distDeg: (bd * 180) / Math.PI } : null;
}
