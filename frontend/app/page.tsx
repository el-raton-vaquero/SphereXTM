import type { Metadata } from 'next';
import CosmosLanding from '../components/cosmos/CosmosLanding';
import './prism-tokens.css';
import '../components/cosmos/cosmos.css';

export const metadata: Metadata = {
  title: 'PRISM · SPHEREx Time Machine',
  description:
    'Esfera celeste con estrellas reales del Yale Bright Star Catalogue, la órbita de SPHEREx y un patrón ilustrativo de su barrido. Elige un objetivo y ábrelo en PRISM, el explorador de cuadros reales de SPHEREx.',
};

export default function Home() {
  return <CosmosLanding />;
}
