'use client';

import { useLocale, withLang } from '../../lib/i18n';

/**
 * StarChord brand slot.
 *
 * Swapping in the real logo is one line: drop the files into public/brand/ (see the README
 * there) and set BRAND_HAS_LOGO = true. Until then the wordmark is plain Fraunces text.
 */
export const BRAND_NAME = 'StarChord';
export const BRAND_LOGO = '/brand/logo.svg';
export const BRAND_LOGO_MARK = '/brand/logo-mark.svg';
export const BRAND_HAS_LOGO = false;

export type BrandSize = 'sm' | 'md' | 'lg';

export interface BrandMarkProps {
  /** Link target; defaults to the landing page. Pass null to render without a link. */
  href?: string | null;
  size?: BrandSize;
  /** Hide the wordmark text (only meaningful once BRAND_HAS_LOGO is true). */
  hideName?: boolean;
  className?: string;
}

export default function BrandMark({ href = '/', size = 'md', hideName = false, className }: BrandMarkProps) {
  const { locale, t } = useLocale();
  const showName = !hideName || !BRAND_HAS_LOGO;
  const inner = (
    <>
      {BRAND_HAS_LOGO && (
        // eslint-disable-next-line @next/next/no-img-element -- static SVG logo, intrinsic size from CSS
        <img className="brandmark-logo" src={BRAND_LOGO} alt={showName ? '' : BRAND_NAME} />
      )}
      {showName && <span className="brandmark-name">{BRAND_NAME}</span>}
    </>
  );
  const cls = `brandmark brandmark-${size}${className ? ` ${className}` : ''}`;
  if (href === null) return <span className={cls}>{inner}</span>;
  return (
    <a className={cls} href={withLang(href, locale)} title={t.nav.home}>
      {inner}
    </a>
  );
}
