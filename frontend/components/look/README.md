# /look: camera sky view and "Above me"

Route: `app/look/page.tsx` -> `components/look/LookApp.tsx`. Two tabs (`?mode=camera|above`;
the default is Camera on touch devices and Above me elsewhere).

## Camera (phone)

- **Start camera and sensors** asks, inside the same tap, for the rear camera
  (`getUserMedia({video: {facingMode: 'environment'}})`), the motion sensors
  (`DeviceOrientationEvent.requestPermission()` on iOS) and the location (GPS, unless a
  location was already chosen in Above me).
- Orientation: `deviceorientationabsolute` (Android Chrome) is preferred; on iOS
  `webkitCompassHeading` gives the north reference; otherwise the reading is relative and the
  UI says "no north reference". `lib/look/camera.ts` turns (alpha, beta, gamma, screen angle)
  into a camera basis in the local East-North-Up frame (W3C `Rz(alpha) Rx(beta) Ry(gamma)`,
  rear camera = device -z), then `lib/look/sky.ts` rotates it to J2000 RA/Dec with
  astronomy-engine (`Rotation_EQJ_HOR`, includes precession and nutation; refraction ignored).
- The overlay (`lib/look/overlay.ts`) projects BSC5 stars, named bright stars, the Sun, Moon,
  planets and the six StarChord targets with a pinhole model. The vertical field of view is
  adjustable (stored in `localStorage`), and **Align** lets the user drag the sky onto a known
  star; the azimuth and altitude correction is stored too.
- Without a camera or sensors (desktop, denied permission, plain http) the same view becomes a
  drag-to-look sky (arrows and +/- also work).
- **Capture** freezes the photo (a JPEG data URL that stays in memory and is never uploaded) and
  the pointing, then shows:
  1. **SPHEREx all-sky map (HiPS)**, rendered for the exact TAN WCS of the photo, side by side
     or blended over it (opacity slider). The band can be colour or D1 to D6.
  2. **SPHEREx frames at this spot** (`lib/look/region.ts`): the preset snapshot when one lies
     within 1 deg, otherwise a live `/v2/search` (10 arcmin, 48 frames) through
     `lib/prism/api.ts`. A false-colour median of the real frames (blue D1+D2, green D3+D4,
     red D5+D6) is shown, with **Open in explorer**.
  3. The nearest StarChord targets, each of which can be shown or opened in /explore.

The pointing is always labelled "approximate, from phone sensors" or "manual". Compass error
is typically 5 to 15 deg, and magnetic declination is not corrected.

## Above me (desktop)

Location comes from geolocation, a city list or typed lat/lon, and is stored in `localStorage`
under `starchord.look.place`. The time is live, or fixed with a picker. The tab shows:

- an all-sky dome canvas (zenith centre, North up, East left). Clicking any point shows the
  HiPS cut-out (3 deg, north up) and the real frames there;
- Sun, Moon and planets with altitude, azimuth, rise, set and magnitude (astronomy-engine);
- the brightest named stars above the horizon;
- the six StarChord targets: up or down, the next transit time and altitude, and links to
  /explore and /sky.

Everything here is labelled **computed**.

## SPHEREx HiPS: primary source, IRSA DR1 cube rendered in the browser (2026-11-14)

The official SPHEREx DR1 all-sky HiPS cube is served by IRSA with `Access-Control-Allow-Origin: *`:
`https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube` (`/properties`:
`ivo://IPAC/P/SPHEREx/DR1/cube`, 102 frames, order 5, 512 px PNG tiles, asinh stretch cut
0..40 MJy/sr, MJD 60789.75 to 61174.49, creator SPHEREx Science Data Center, copyright
Caltech/IPAC, NASA/SPHEREx). Frame f = 17*(band-1)+(channel-1); frames 50 and 51 are blank.

`lib/look/hipsRender.ts` draws it for any TAN WCS (including the rotated phone-camera WCS) with
no dependencies: HEALPix nested lookup, HiPS tile pixel order (PNG column = face y, row = face x,
checked against Betelgeuse, Rigel, Bellatrix, Saiph, Alnilam, the Pleiades, Polaris and Crux at
orders 3 to 5 and in `Allsky.png`; north up puts East on the left), order chosen from the output
pixel scale (3 to 5, or the 64 px `Allsky` thumbnails for wide fields or when a view needs more
than 60 tile downloads), LRU cache, 8 parallel fetches, abortable. Layers: colour = 1.00 / 2.19 /
4.00 µm (blue / green / red), D1 to D6 = the middle channel of each detector. Each channel gets a
percentile display stretch. Tiles are display-stretched, not calibrated fluxes, and the UI says so.
`sampleSpectrum(ra, dec)` returns the 102-frame display values at one position (not wired up yet).

CDS hips2fits (below) is kept only as the fallback when the IRSA tiles fail to load; the
StarChord snapshot / live-search frames remain the last fallback.

## SPHEREx HiPS at CDS (fallback; research, 2026-11-14)

The CDS HiPS registry (MocServer, query `ID=CDS/P/SPHEREx*`) lists real SPHEREx HiPS built by
CDS from IRSA QR2 spectral images (progenitor `https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2`,
MJD 60789 to 61165):

| ID | Content |
|---|---|
| `CDS/P/SPHEREx/QR2/D1` … `D6` | one per detector, 0.75–1.10 … 4.42–5.00 µm, order 7, png + fits tiles |
| `CDS/P/SPHEREx/QR2/color` | colour HiPS built from the six detector HiPS |

- **Hosts:** `https://alasky.cds.unistra.fr/SPHEREx/<layer>`, with the mirror on `alaskybis`.
- **Copyright:** "Courtesy NASA/JPL-Caltech" (https://spherex.caltech.edu/page/image-use-policy).
- **CORS:** responses carry `Access-Control-Allow-Origin: *`.
- **How we use it:** we request JPEG cut-outs from the CDS `hips2fits` service with an explicit
  WCS (`lib/look/hips.ts`). We never download or ship the tiles themselves.
- **Status on 2026-11-14:** the alasky data host returned the CDS "page unavailable" response
  and alaskybis timed out, while the registry still answered. The UI therefore tries both hosts,
  with a 15 s timeout each. If both fail it says so and keeps showing the StarChord frames,
  which are also real SPHEREx data.

No other survey's imagery is ever shown as SPHEREx.
