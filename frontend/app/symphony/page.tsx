import type { Metadata } from 'next';
import ComingSoon from '../../components/site/ComingSoon';
import { en } from '../../lib/i18n/en';

export const metadata: Metadata = {
  title: en.symphony.metaTitle,
  description: en.symphony.metaDescription,
};

export default function Page() {
  return <ComingSoon section="symphony" />;
}
