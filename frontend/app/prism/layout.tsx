import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans, Instrument_Serif } from 'next/font/google';
import '../prism-tokens.css';
import './prism.css';

const display = Instrument_Serif({ subsets: ['latin'], weight: '400', variable: '--p-font-display-loaded', display: 'swap' });
const body = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--p-font-body-loaded', display: 'swap' });
const data = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--p-font-data-loaded', display: 'swap' });

export const metadata: Metadata = {
  title: 'PRISM · SPHEREx',
  description: 'Every SPHEREx frame is a different colour. PRISM separates colour from motion — real IRSA SPHEREx observations, catalogue predictions labelled as such.',
};

export default function PrismLayout({ children }: { children: React.ReactNode }) {
  return <div className={`prism-root ${display.variable} ${body.variable} ${data.variable}`}>{children}</div>;
}
