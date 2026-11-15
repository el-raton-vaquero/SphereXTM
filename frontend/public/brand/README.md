# Listar brand assets

This folder is the drop-in slot for the official Listar logos. Until they arrive the site
shows a plain text wordmark ("Listar", set in Fraunces) and a placeholder icon.

## Files to drop here

| File | Used for | Notes |
| --- | --- | --- |
| `logo.svg` | Full logo next to / instead of the wordmark in every page header | SVG preferred; light artwork for a dark (#0b0a09) background. Height renders at ~1.15 em of the wordmark size. |
| `logo-mark.svg` | Compact mark (square) for tight spaces | Optional. Exposed as `BRAND_LOGO_MARK`. |
| `favicon.svg` (or `favicon.ico`) | Browser tab icon | See "Favicon" below. |

## Switching the site to the real logo (one line)

1. Copy `logo.svg` (and optionally `logo-mark.svg`) into this folder.
2. In `frontend/components/brand/BrandMark.tsx` set `BRAND_HAS_LOGO = true`.

Every header uses `<BrandMark />`, so all pages pick the logo up. If the logo already contains
the name, render `<BrandMark hideName />` where you want the image alone (the text is kept
whenever no logo is configured, so the brand never disappears).

## Favicon

The current tab icon is `frontend/app/icon.svg` (Next.js app-icon convention). Replace that
file with the official icon (keep the name `icon.svg`, or add `app/icon.png` / `app/favicon.ico`
and delete `icon.svg`). Apple touch icon: add `app/apple-icon.png` (180x180).

## Licence

Only commit artwork the team owns or is licensed to use, and note its source here.
