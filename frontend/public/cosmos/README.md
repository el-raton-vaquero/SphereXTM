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

## Landing textures (real Earth, Moon, Milky Way)

All downloaded 2026-11-14 from the NASA Goddard Scientific Visualization Studio (SVS) and
re-encoded by `components/cosmos/tools/build-textures.py` (Pillow + NumPy; the Milky Way EXR is
first decoded with `ffmpeg -i milkyway_2020_4k.exr -vf scale=2048:1024:flags=area -pix_fmt gbrpf32le -f rawvideo mw.raw`).
NASA SVS imagery is not copyrighted (NASA media usage guidelines); credit is given as each page asks.
The Gaia DR2 contribution to the Deep Star Maps is ESA/Gaia/DPAC (CC BY-SA 3.0 IGO).

| File | Size | Source | Processing | Credit |
|---|---|---|---|---|
| `earth-day.jpg` | 2048×1024, 290 KB | SVS 3615, `earth_noClouds.0330.jpg` (Blue Marble Next Generation, no clouds) — https://svs.gsfc.nasa.gov/3615/ | re-encoded JPEG q86 | NASA/Goddard SVS; Blue Marble NG courtesy Reto Stöckli (NASA/GSFC) and NASA Earth Observatory |
| `earth-clouds.jpg` | 2048×1024, 146 KB, greyscale | SVS 3615, `flat_earth03.jpg` (same Earth **with** clouds) | cloud alpha = (with − without)/(1 − without), thresholded; faded beyond ±56° where the source has no clouds | as above. **One archival, art-directed cloud field — not live weather**; the HUD says so. |
| `earth-night.jpg` | 2048×1024, 166 KB | SVS 30028, `earthatnight2012.png` (5760×2880) — https://svs.gsfc.nasa.gov/30028/ | Lanczos downscale | NASA Earth Observatory / Robert Simmon, Suomi NPP VIIRS data courtesy Chris Elvidge (NOAA NGDC) |
| `moon.jpg` | 1024×512, 96 KB | SVS 4720 CGI Moon Kit, `lroc_color_2k.jpg` — https://svs.gsfc.nasa.gov/4720/ | Lanczos downscale | NASA's Scientific Visualization Studio (Ernie Wright); LRO LROC WAC mosaic |
| `milkyway.jpg` | 2048×1024, 396 KB | SVS 4851 Deep Star Maps 2020, `milkyway_2020_4k.exr` (ICRS, RA 0h centred, RA increasing to the left) — https://svs.gsfc.nasa.gov/4851/ | asinh stretch of the linear HDR (99.7th percentile reference) | NASA/Goddard SVS; Gaia DR2: ESA/Gaia/DPAC |

### How the landing uses them

- **Earth** (`CosmosEngine.ts`, custom shader): day map lit by the real Sun direction, night lights
  where the Sun is down, a soft terminator, an ocean glint (ocean mask taken from the day map's
  blue-dominant pixels), a Fresnel limb and an analytic atmosphere halo. The globe turns by
  apparent sidereal time (astronomy-engine), so the day side and the sub-solar point (shown in
  the HUD) are those of the displayed instant. Precession (~0.3° since J2000) is ignored.
- **Clock**: "Now" follows the wall clock (updated every second). Touching the SPHEREx sweep
  timeline switches to that survey day at the same UTC time of day ("Survey date"), so the globe
  does not strobe while the timeline plays; "Back to now" returns to the live clock.
- **Sun, Moon, Mercury–Saturn**: geocentric J2000 positions with light time and aberration from
  astronomy-engine 2.1.19 (MIT), placed on the celestial sphere and labelled. The Moon is a
  textured sphere at its true angular size, lit by the real Sun (so its phase is correct), near
  side towards the Earth; libration is ignored. Planets are magnitude-scaled points (no discs).
- **Milky Way**: backdrop at 42 % gain, faded further when zoomed in (the map is ~0.18°/px).
- **Stars**: unchanged BSC5 data, drawn with a Gaussian core plus a faint wing for bright stars.

## cosmos-static.jpg

A frame rendered by the landing page itself in headless Chromium (orbit view, live clock on
2026-11-15 03:5x UTC, HUD hidden, 1600×900). Shown instead of WebGL when `prefers-reduced-motion: reduce` is set or WebGL is
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
| Sun, Moon, planet positions; Earth rotation; day/night line | **Computed** (astronomy-engine), labelled in the HUD legend and credits |
| Earth, Moon, Milky Way imagery | Real NASA/ESA imagery (see table above); clouds are an archival snapshot |
| Sweep-strip phase on the timeline | Computed (low-precision solar longitude, ~0.01°) |
| Earth radius vs. orbit altitude (~650 km) | To scale |
| Spacecraft size | Enlarged ~10⁵× |
| Scan strips / coverage | **Illustrative**: a great circle perpendicular to the Sun sweeping 180° in ~6 months, half-width 5.6°. Not the SPHEREx pointing plan; labelled as such in the HUD. |
| Preset coordinates | SIMBAD J2000 via CDS Sesame (2026-11-14); WISE 0855 from the challenge statement. `/v2/targets` is authoritative. |
