import type { Metadata } from 'next';
import ComingSoon from '../../components/site/ComingSoon';
import { en } from '../../lib/i18n/en';

export const metadata: Metadata = {
  title: en.look.metaTitle,
  description: en.look.metaDescription,
};

export default function Page() {
  return <ComingSoon section="look" />;
}
