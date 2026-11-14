# /cosmos assets

## bsc5.bin — real bright stars

- **Source:** Yale Bright Star Catalogue, 5th Revised Ed. (Hoffleit & Warren 1991),
  NASA ADC / CDS catalogue **V/50**, retrieved 2026-11-14 from the VizieR mirror at
  `https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?-source=V/50/catalog&-out=HR,Name,RAJ2000,DEJ2000,Vmag,B-V&-out.max=10000`
  (the primary CDS host returned an "unavailable" page that day).
- **Licence / terms:** the BSC5 is a NASA Astronomical Data Center catalogue, distributed
  freely by CDS for scientific and educational use. Cite: *Hoffleit, D. & Warren, W. H. Jr.
  (1991), The Bright Star Catalogue, 5th Revised Ed., VizieR On-line Data Catalog V/50.*
  This research has made use of the VizieR catalogue access tool, CDS, Strasbourg, France.
- **Content:** 9 096 stars (every BSC5 entry with RA, Dec and V; V ≤ ~6.5), J2000 positions
  (no proper-motion propagation — at this scale it is invisible), V magnitude and B−V.
- **Format:** 54 584 bytes. `"BSC5"` magic, uint32 count, then 6-byte records
  (uint16 RA, int16 Dec, uint8 V, int8 B−V). See
  `components/cosmos/tools/build-stars.mjs` (encoder, with the exact fetch command) and
  `components/cosmos/stars.ts` (decoder). Quantisation ≤ 20″ in position, 0.05 mag in V.
- **Rendering:** point size and opacity ∝ √flux from V; colour from B−V via the
  Ballesteros (2012) temperature relation and a blackbody RGB fit, desaturated 30 %.

## cosmos-static.jpg

A frame rendered by the /cosmos page itself in headless Chromium (orbit view, survey day 75,
HUD hidden). Shown instead of WebGL when `prefers-reduced-motion: reduce` is set or WebGL is
unavailable. Regenerate after visual changes to the scene.

## Spacecraft model

No official SPHEREx 3D model was found on NASA's 3D Resources site on 2026-11-14
(`https://science.nasa.gov/3d-resources/spherex/` → 404). The spacecraft is therefore a
**procedural three.js model** built from primitives (`components/cosmos/spacecraft.ts`):
three nested conical photon shields, telescope, six-sided bus, one fixed solar array.
Proportions are approximate; it is not an engineering model and contains no AI-generated mesh.

## What is real and what is illustrative on /cosmos

| Element | Status |
|---|---|
| Star positions, magnitudes, colours | Real (BSC5) |
| RA/Dec graticule, ecliptic, galactic plane | Computed (IAU J2000 obliquity; ICRS→galactic matrix) |
| Sun position on the timeline | Computed (low-precision solar longitude, ~0.01°) |
| Earth radius vs. orbit altitude (~650 km) | To scale |
| Spacecraft size | Enlarged ~10⁵× |
| Scan strips / coverage | **Illustrative**: a great circle perpendicular to the Sun sweeping 180° in ~6 months, half-width 5.6°. Not the SPHEREx pointing plan; labelled as such in the HUD. |
| Preset coordinates | SIMBAD J2000 via CDS Sesame (2026-11-14); WISE 0855 from the challenge statement. `/v2/targets` is authoritative. |
