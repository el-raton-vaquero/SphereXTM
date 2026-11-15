import type { Metadata } from 'next';
import MatchApp from '../../components/match/MatchApp';
import { en } from '../../lib/i18n/en';
import '../../components/match/match.css';

export const metadata: Metadata = {
  title: en.match.metaTitle,
  description: en.match.metaDescription,
};

export default function Page() {
  return <MatchApp />;
}
