'use client';
/**
 * "What am I looking at?" next to SPHEREx sky pictures outside /explore (Look, Symphony, Match,
 * Song). Those pictures come from the DR1 all-sky cube or a stacked snapshot, so the reading is a
 * guide to the features any SPHEREx image shows (stars, saturated stars, noise, dust, seams) and
 * why, rather than a per-pixel measurement (that lives in /explore, lib/prism/reading.ts).
 */
import { useLocale } from '../../lib/i18n';

const TEXT = {
  en: {
    k: 'What you are seeing',
    cube: 'A real SPHEREx infrared picture from its DR1 all-sky map, brightened so faint things show.',
    plate: 'Real SPHEREx frames of this target, stacked and brightened so faint things show.',
    items: [
      ['Small dots', 'stars and distant galaxies.'],
      ['Big white blobs, rings or spikes', 'bright stars that overfill the detector (saturation). Their shape is an instrument effect, not the star.'],
      ['Fine grain or speckle', 'noise. Where the sky is faint the picture is mostly detector noise plus the glow of dust in the Solar System (zodiacal light), stretched to be visible.'],
      ['Smooth glow or wisps', 'dust and gas in our Galaxy, brightest near the Milky Way.'],
      ['Straight seams or blank patches', 'joins between survey strips or places with no data yet.'],
    ],
  },
  es: {
    k: 'Qué estás viendo',
    cube: 'Una imagen infrarroja real de SPHEREx, de su mapa de todo el cielo DR1, aclarada para que se vean las cosas débiles.',
    plate: 'Cuadros reales de SPHEREx de este objetivo, apilados y aclarados para que se vean las cosas débiles.',
    items: [
      ['Puntitos', 'estrellas y galaxias lejanas.'],
      ['Manchas blancas grandes, anillos o picos', 'estrellas brillantes que llenan el detector (saturación). Esa forma es un efecto del instrumento, no la estrella.'],
      ['Granulado fino', 'ruido. Donde el cielo es débil, la imagen es casi toda ruido del detector más el brillo del polvo del Sistema Solar (luz zodiacal), estirado para que se vea.'],
      ['Brillo suave o filamentos', 'polvo y gas de nuestra galaxia, más intenso cerca de la Vía Láctea.'],
      ['Cortes rectos o parches vacíos', 'uniones entre franjas del sondeo o zonas sin datos todavía.'],
    ],
  },
};

export default function SkyImageNote({ variant = 'cube', className = '' }: { variant?: 'cube' | 'plate'; className?: string }) {
  const { locale } = useLocale();
  const T = locale === 'es' ? TEXT.es : TEXT.en;
  return (
    <details className={`sky-note ${className}`}>
      <summary><span className="sky-note-k">{T.k}</span> {variant === 'plate' ? T.plate : T.cube}</summary>
      <ul>
        {T.items.map(([a, b]) => <li key={a}><b>{a}:</b> {b}</li>)}
      </ul>
    </details>
  );
}
