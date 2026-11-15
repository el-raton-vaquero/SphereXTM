import type { Metadata } from 'next';
import SkyApp from '../../components/sky/SkyApp';
import { en } from '../../lib/i18n/en';

export const metadata: Metadata = {
  title: en.sky.metaTitle,
  description: en.sky.metaDescription,
};

export default function Page() {
  return <SkyApp />;
}
