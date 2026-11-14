import type { Metadata } from 'next';
import '../prism-tokens.css';
import '../../components/cosmos/cosmos.css';

export const metadata: Metadata = {
  title: 'PRISM · Cosmos — SPHEREx Time Machine',
  description:
    'Esfera celeste con estrellas reales del Yale Bright Star Catalogue, la órbita de SPHEREx y un patrón ilustrativo de su barrido del cielo. Elige un objetivo y ábrelo en PRISM.',
};

export default function CosmosLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* React 19 hoists and de-duplicates stylesheet links with a precedence. */}
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      {/* eslint-disable-next-line @next/next/no-page-custom-font -- App Router: fonts scoped to /cosmos on purpose */}
      <link
        rel="stylesheet"
        precedence="default"
        href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap"
      />
      {children}
    </>
  );
}
