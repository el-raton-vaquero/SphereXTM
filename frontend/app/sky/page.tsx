import type { Metadata } from 'next';
import ComingSoon from '../../components/site/ComingSoon';
import { en } from '../../lib/i18n/en';

export const metadata: Metadata = {
  title: en.sky.metaTitle,
  description: en.sky.metaDescription,
};

export default function Page() {
  return <ComingSoon section="sky" />;
}
