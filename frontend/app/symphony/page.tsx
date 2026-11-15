import type { Metadata } from 'next';
import SymphonyApp from '../../components/symphony/SymphonyApp';
import { en } from '../../lib/i18n/en';
import '../../components/symphony/symphony.css';

export const metadata: Metadata = {
  title: en.symphony.metaTitle,
  description: en.symphony.metaDescription,
};

export default function Page() {
  return <SymphonyApp />;
}
