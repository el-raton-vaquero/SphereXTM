import type { Metadata } from 'next';
import LookApp from '../../components/look/LookApp';
import { en } from '../../lib/i18n/en';

export const metadata: Metadata = {
  title: en.look.metaTitle,
  description: en.look.metaDescription,
};

export default function Page() {
  return <LookApp />;
}
