import type { Metadata } from 'next';
import { en } from '../../lib/i18n/en';
import './explore.css';

export const metadata: Metadata = {
  title: en.explore.metaTitle,
  description: en.explore.metaDescription,
};

export default function ExploreLayout({ children }: { children: React.ReactNode }) {
  return <div className="prism-root">{children}</div>;
}
