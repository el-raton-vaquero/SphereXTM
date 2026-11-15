'use client';

import BrandMark from '../brand/BrandMark';
import SiteNav, { type SiteRouteId } from './SiteNav';

/** Standard page header for content pages: brand on the left, site navigation on the right. */
export default function SiteHeader({ current, children }: { current?: SiteRouteId; children?: React.ReactNode }) {
  return (
    <header className="site-header">
      <BrandMark />
      {children}
      <SiteNav current={current} />
    </header>
  );
}
