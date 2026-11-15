import type { Metadata } from 'next';
import { en } from '../../lib/i18n/en';
import '../../components/cosmos/cosmos.css';

export const metadata: Metadata = {
  title: en.cube.metaTitle,
  description: en.cube.lede,
};

export default function CosmosLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
