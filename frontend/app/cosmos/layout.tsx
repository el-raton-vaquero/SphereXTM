import type { Metadata } from 'next';
import '../prism-tokens.css';
import '../../components/cosmos/cosmos.css';

export const metadata: Metadata = {
  title: 'PRISM · Cosmos — SPHEREx Time Machine',
  description: 'Vistas 3D de PRISM: cubo espectral de cuadros reales de SPHEREx.',
};

export default function CosmosLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
