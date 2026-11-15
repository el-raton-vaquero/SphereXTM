# /sky assets (sky time machine)

Everything on `/sky` is a **computed sky** (ephemeris + proper-motion model). None of it is a
SPHEREx observation. The page says so permanently in its header strip.

## bsc5pm.bin — proper motions + HR numbers for the bright-star catalogue

- **Catalogue:** Yale Bright Star Catalogue, 5th Revised Ed. (Hoffleit & Warren 1991),
  NASA ADC / CDS catalogue **V/50** — the same catalogue as `public/cosmos/bsc5.bin`.
- **Copy used:** the binary distribution of the Harvard-Smithsonian Center for Astrophysics
  Telescope Data Center, `http://tdc-www.harvard.edu/catalogs/BSC5` (retrieved 2026-11-14).
  CDS VizieR and its CfA mirror returned "database not reachable" / "page unavailable" that
  night; the TDC file carries the same J2000 FK5 positions and annual proper motions.
- **Licence / terms:** BSC5 is a NASA Astronomical Data Center catalogue distributed freely for
  scientific and educational use. Cite: *Hoffleit, D. & Warren, W. H. Jr. (1991), The Bright
  Star Catalogue, 5th Revised Ed., VizieR On-line Data Catalog V/50.*
- **Content:** one record per star of `public/cosmos/bsc5.bin`, same order (9 096 stars, all
  matched by position ≤ 60″ and V within 0.08 mag): `int16 pmRA*` (μα·cosδ, mas/yr),
  `int16 pmDec` (mas/yr), `uint16 HR` number. Header: `"BSCP"` magic + `uint32` count.
  54 584 bytes. Checked against Hipparcos: Arcturus −1093/−1998, Sirius −553/−1205,
  Vega 202/286, 61 Cyg A 4136/3203 mas/yr.
- **Builder:** `frontend/lib/sky/tools/build-pm.mjs` (exact command in its header).
- **Model:** linear motion on the tangent plane from epoch J2000.0, no radial velocity and no
  parallax. Good to a fraction of a degree over a few thousand years for almost every star;
  labelled "approximate" in the UI.

## constellations.json — constellation stick figures

- **Source:** d3-celestial by Olaf Frohn, `data/constellations.lines.json` v0.7.35,
  fetched from `https://cdn.jsdelivr.net/npm/d3-celestial@0.7.35/data/constellations.lines.json`.
- **Licence:** BSD 3-Clause. Copyright (c) 2015, Olaf Frohn. All rights reserved.
  Redistribution and use in source and binary forms, with or without modification, are
  permitted provided that the following conditions are met: (1) redistributions of source code
  must retain the above copyright notice, this list of conditions and the following disclaimer;
  (2) redistributions in binary form must reproduce the above copyright notice, this list of
  conditions and the following disclaimer in the documentation and/or other materials provided
  with the distribution; (3) neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from this software without
  specific prior written permission. THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND
  CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN
  NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
  INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
  PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
  INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
  LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
  THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
- **Transformation:** every vertex snapped to its BSC5 star (≤ 0.25°; 743/743 segments kept),
  stored as pairs of indices into `bsc5.bin`, so the figures follow proper motion over
  millennia. Builder: `frontend/lib/sky/tools/build-constellations.mjs`.

## Other inputs (no files)

| Element | Source / method | Status in UI |
|---|---|---|
| Sun, Moon, planets | astronomy-engine 2.1.19 (MIT; VSOP87 / NOVAS-derived models), topocentric, J2000 then rotated to the horizon of date | computed; accuracy degrades for dates far from today |
| Precession / nutation / Earth rotation | astronomy-engine `Rotation_EQJ_HOR` | computed |
| Barnard's Star, ε Indi B | Gaia DR3 astrometry (epoch J2016.0), as recorded in `server/spherex/data/prism-targets.json` | catalogue-predicted position |
| WISE 0855−0714 | SIMBAD / Kirkpatrick et al. 2021 (ApJS 253, 7), epoch J2000.0, same file | catalogue-predicted position |
| Star names | IAU WGSN proper names, attached by HR number (`lib/sky/names.ts`) | — |
| Visible-sky "bands" for the symphony | blackbody from each visible star's B−V, summed and sampled on a SPHEREx-like 0.75–5 µm grid (`lib/sky/bands.ts`) | colour-based approximation, **not SPHEREx data** |

At playback speeds of 1 day/s and faster the horizon frame is drawn at whole sidereal days from
the moment playback started (same star time each day), so the sky does not spin several turns
per second; bodies and stars still move to their exact positions for the displayed instant, and
pausing snaps the clock to the instant on screen. The UI says so next to the speed selector.

Atmospheric refraction is not applied. Dates use the proleptic Gregorian calendar; historical
records before 1582 used the Julian calendar (the epoch notes say so where it matters).
