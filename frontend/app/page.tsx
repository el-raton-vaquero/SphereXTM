import type { Metadata } from 'next';
import CosmosLanding from '../components/cosmos/CosmosLanding';
import { en } from '../lib/i18n/en';
import '../components/cosmos/cosmos.css';

export const metadata: Metadata = {
  title: en.cosmos.metaTitle,
  description: en.cosmos.metaDescription,
};

export default function Home() {
  return <CosmosLanding />;
}
