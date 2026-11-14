import type { Metadata } from 'next';
import CubeDemo from '../../../components/cosmos/CubeDemo';

export const metadata: Metadata = {
  title: 'PRISM · Cubo espectral',
};

export default function CubePage() {
  return <CubeDemo />;
}
