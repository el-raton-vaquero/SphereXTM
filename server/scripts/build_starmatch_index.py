#!/usr/bin/env python3
"""
Build the coarse all-sky "Star Match" index from the official IRSA SPHEREx DR1 all-sky HiPS cube.

    base  https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube   (CORS *)

What it produces (in --out, normally frontend/public/starmatch/):
    index.json   metadata, wavelengths, per-band sky median / robust sigma, encoding description
    index.bin    Int8 [49152 x 102] row-major (pixel-major): per order-6 HEALPix pixel (NESTED,
                 equatorial/ICRS) and band, a robust z-score of the area-mean value relative to the
                 all-sky median of that band, z clipped to +-4 and stored as round(z * 127/4);
                 -128 = no data (blank band or no coverage).
    pixmeta.bin  Uint8 [49152 x 2]: [overall brightness 0..255, number of bands with data 0..100]
    coords.bin   Float32 [49152 x 2]: RA, Dec (deg) of each order-6 pixel centre.

IMPORTANT (integrity): the HiPS PNG tiles are DISPLAY-STRETCHED 8-bit images, not calibrated data.
Everything here is derived from those pictures.  What we found about the encoding (checked on the
real tiles of several frames while writing this script):
  * every PNG grey value g is one of a fixed set of 116..118 levels that is reproduced exactly by
        g = floor(255 * asinh(K * L) / asinh(K * 260)),  K = 0.97435, L = 0, 1, 2, ... (integer)
    i.e. HipsGen first quantised the data to an 8-bit LINEAR level L over the pixel cut
    (hips_pixel_cut = 0 40 MJy/sr, so one level is ~40/255 = 0.157 MJy/sr - an inference, not a
    documented calibration) and then applied the asinh transfer function.  We invert that LUT
    (g -> mean of the L values that map to g) so area averages are taken in the linear domain.
  * level 0 (flux <= 0 after the HiPS cut) covers most of the high-latitude sky in every band, so the
    cube appears to be background (zodiacal light) subtracted and clipped at 0.
  * Norder3/Allsky_<f>.png is a pure DECIMATION of the order-3 tiles (pixel [8i, 8j] of each tile),
    not an average, while order-3 tiles are (approximately) 2x2 means of order-4 tiles.  So the default
    mode ("tiles") reads all 768 order-3 tiles of every frame (512x512 px each, ~50 kB; 76,800
    requests, ~4 GB streamed, nothing is kept on disk) and averages the 64x64 tile pixels of every
    order-6 pixel.  Mode "allsky" uses the 100 Allsky images instead (8x8 point samples per pixel;
    fast but noisy) and is kept as a fallback.

Tile pixel orientation (same convention as frontend/lib/look/hipsRender.ts, validated on bright
stars): PNG column = face-local HEALPix y, PNG row (from the top) = face-local x.  A tile of order k
and width w therefore holds child cell (x = row // s, y = col // s) of size s = w / 2^m at order k+m,
whose nested index is  npix * 4^m + spread(x) + 2 * spread(y).

Usage (run on a machine that can reach IRSA; numpy + Pillow; healpy optional for validation):
    python3 build_starmatch_index.py build    --work WORK --out OUT [--mode tiles|allsky] [--threads 16]
    python3 build_starmatch_index.py validate --work WORK --out OUT
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import numpy as np
from PIL import Image

BASE = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube"
UA = {"User-Agent": "starmatch-index-builder/1.0 (python urllib)"}
NFRAMES = 102
BLANK = (50, 51)
ORDER = 6
NSIDE = 1 << ORDER
NPIX = 12 * NSIDE * NSIDE  # 49152
TILE_ORDER = 3
ALLSKY_COLS, ALLSKY_W, TILE_W = 27, 64, 512
CLIP = 4.0
QSCALE = 127.0 / CLIP
NODATA = -128

# PNG grey -> linear 8-bit level (see module docstring)
LUT_K, LUT_N = 0.9743542517924076, 260


def _lut():
    L = np.arange(LUT_N + 1)
    g = np.floor(255 * np.arcsinh(LUT_K * L) / np.arcsinh(LUT_K * LUT_N)).astype(int)
    inv = np.full(256, np.nan)
    for v in range(256):
        m = L[g == v]
        if len(m):
            inv[v] = m.mean()
    # grey values never produced by the model (254, 255): nearest level by continuous inversion
    for v in range(256):
        if np.isnan(inv[v]):
            inv[v] = math.sinh(v / 255 * math.asinh(LUT_K * LUT_N)) / LUT_K
    return g, inv


LEVEL_GREY, GREY_TO_L = _lut()


def restretch(L):
    """Area-mean linear level -> asinh-stretched 0..1 scale (comparable to hipsRender value = g/254)."""
    return np.arcsinh(LUT_K * np.asarray(L, dtype=np.float64)) / np.arcsinh(LUT_K * LUT_N)


# ------------------------------------------------------------------------------------------------
# HEALPix nested helpers (vectorised numpy, Gorski et al. 2005 / healpix_base)

def spread_bits(v):
    v = np.asarray(v, dtype=np.int64)
    r = np.zeros_like(v)
    for b in range(16):
        r |= ((v >> b) & 1) << (2 * b)
    return r


def compress_bits(v):
    v = np.asarray(v, dtype=np.int64)
    r = np.zeros_like(v)
    for b in range(16):
        r |= ((v >> (2 * b)) & 1) << b
    return r


JRLL = np.array([2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4])
JPLL = np.array([1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7])


def pix2ang_nest(order, pix):
    """Centre (RA, Dec) in degrees of nested pixels at `order`."""
    nside = 1 << order
    npface = nside * nside
    pix = np.asarray(pix, dtype=np.int64)
    face = pix >> (2 * order)
    ipf = pix & (npface - 1)
    ix = compress_bits(ipf)
    iy = compress_bits(ipf >> 1)
    jr = JRLL[face] * nside - ix - iy - 1
    nr = np.where(jr < nside, jr, np.where(jr > 3 * nside, 4 * nside - jr, nside)).astype(np.float64)
    z = np.where(jr < nside, 1 - nr * nr / (3.0 * npface),
                 np.where(jr > 3 * nside, -(1 - nr * nr / (3.0 * npface)), (2 * nside - jr) * 2.0 / (3 * nside)))
    kshift = np.where((jr >= nside) & (jr <= 3 * nside), (jr - nside) & 1, 0)
    nri = nr.astype(np.int64)
    jp = (JPLL[face] * nri + ix - iy + 1 + kshift) // 2
    jp = np.where(jp > 4 * nside, jp - 4 * nside, jp)
    jp = np.where(jp < 1, jp + 4 * nside, jp)
    phi = (jp - (kshift + 1) * 0.5) * (math.pi / 2 / nr)
    return np.degrees(phi) % 360.0, np.degrees(np.arcsin(np.clip(z, -1, 1)))


# Port of hipsRender.ts vecToFaceXY / nestIndex / locateInTile (scalar, for validation)
def vec_to_face_xy(vx, vy, vz, nside):
    z, za = vz, abs(vz)
    tt = math.atan2(vy, vx) / (math.pi / 2)
    if tt < 0:
        tt += 4
    if tt >= 4:
        tt -= 4
    if za <= 2 / 3:
        t1, t2 = nside * (0.5 + tt), nside * z * 0.75
        jp, jm = t1 - t2, t1 + t2
        ifp, ifm = math.floor(jp / nside), math.floor(jm / nside)
        face = (ifp | 4) if ifp == ifm else (ifp if ifp < ifm else ifm + 8)
        x = jm - ifm * nside
        y = nside - (jp - ifp * nside)
    else:
        ntt = min(3, math.floor(tt))
        tp = tt - ntt
        one_minus_za = (vx * vx + vy * vy) / (1 + za)
        tmp = nside * math.sqrt(3 * one_minus_za)
        jp, jm = min(nside, tp * tmp), min(nside, (1 - tp) * tmp)
        if z >= 0:
            face, x, y = ntt, nside - jm, nside - jp
        else:
            face, x, y = ntt + 8, jp, jm
    top = nside * (1 - 1e-12)
    return face, min(top, max(0, x)), min(top, max(0, y))


def radec_to_unit(ra, dec):
    a, d = math.radians(ra), math.radians(dec)
    return math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)


def locate_in_tile(ra, dec, order, width):
    nside = (1 << order) * width
    face, x, y = vec_to_face_xy(*radec_to_unit(ra, dec), nside)
    tx, ty = math.floor(x / width), math.floor(y / width)
    npix = face * 4 ** order + int(spread_bits(tx)) + 2 * int(spread_bits(ty))
    return npix, y - ty * width, x - tx * width  # npix, col, row


def ang2pix_ts(ra, dec, order):
    return locate_in_tile(ra, dec, order, 1)[0]


# ------------------------------------------------------------------------------------------------
# Fetching / decoding

def http_get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if i == tries - 1:
                raise
        except Exception:
            if i == tries - 1:
                raise
        time.sleep(1.5 * (i + 1))


def tile_url(order, npix, frame):
    d = (npix // 10000) * 10000
    return f"{BASE}/Norder{order}/Dir{d}/Npix{npix}{'_%d' % frame if frame > 0 else ''}.png"


def allsky_url(frame):
    return f"{BASE}/Norder3/Allsky{'_%d' % frame if frame > 0 else ''}.png"


def decode(png_bytes):
    """-> (grey uint8, has_data bool) with the hipsRender convention (alpha 0 = no data)."""
    a = np.asarray(Image.open(io.BytesIO(png_bytes)).convert("RGBA"))
    return a[..., 0], a[..., 3] > 0


def reduce_tile(grey, ok, sub):
    """Average a square tile into (w/sub)^2 child cells -> (sumL, sumG, count) indexed by nested child."""
    w = grey.shape[0]
    m = w // sub
    L = np.where(ok, GREY_TO_L[grey], 0.0)
    G = np.where(ok, np.maximum(grey, 1), 0).astype(np.float64)  # hipsRender keeps 0 for "no data"
    c = ok.astype(np.float64)
    shp = (m, sub, m, sub)
    sL, sG, n = (A.reshape(shp).sum(axis=(1, 3)) for A in (L, G, c))
    bx, by = np.meshgrid(np.arange(m), np.arange(m), indexing="ij")  # bx = row block = face x
    child = (spread_bits(bx) + 2 * spread_bits(by)).ravel()
    out = np.zeros((3, m * m))
    out[0, child], out[1, child], out[2, child] = sL.ravel(), sG.ravel(), n.ravel()
    return out


def frame_sums(frame, mode, threads):
    sums = np.zeros((3, NPIX))
    per = 4 ** (ORDER - TILE_ORDER)  # 64 order-6 cells per order-3 tile
    if mode == "allsky":
        raw = http_get(allsky_url(frame))
        g, ok = decode(raw)
        for n in range(768):
            ox, oy = (n % ALLSKY_COLS) * ALLSKY_W, (n // ALLSKY_COLS) * ALLSKY_W
            sums[:, n * per:(n + 1) * per] = reduce_tile(g[oy:oy + 64, ox:ox + 64], ok[oy:oy + 64, ox:ox + 64], 8)
        return sums, 0

    def one(n):
        raw = http_get(tile_url(TILE_ORDER, n, frame))
        if raw is None:
            return n, None
        g, ok = decode(raw)
        return n, reduce_tile(g, ok, TILE_W // 8)

    missing = 0
    with ThreadPoolExecutor(threads) as ex:
        for n, r in ex.map(one, range(768)):
            if r is None:
                missing += 1
            else:
                sums[:, n * per:(n + 1) * per] = r
    return sums, missing


def parse_properties(txt):
    props = {}
    for line in txt.splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            props[k.strip()] = v.strip()
    return props


# ------------------------------------------------------------------------------------------------

def cmd_build(a):
    os.makedirs(a.work, exist_ok=True)
    os.makedirs(a.out, exist_ok=True)
    props_txt = http_get(f"{BASE}/properties").decode()
    open(os.path.join(a.work, "properties.txt"), "w").write(props_txt)
    props = parse_properties(props_txt)
    lam = [float(x) for x in props["data_cube_crval3_arr"].split()]
    assert len(lam) == NFRAMES

    meanL = np.full((NFRAMES, NPIX), np.nan, np.float32)
    meanG = np.full((NFRAMES, NPIX), np.nan, np.float32)
    count = np.zeros((NFRAMES, NPIX), np.float32)
    for f in range(NFRAMES):
        if f in BLANK:
            continue
        ck = os.path.join(a.work, f"{a.mode}_f{f:03d}.npy")  # per-frame checkpoint (small: 3 x 49152)
        if os.path.exists(ck):
            s = np.load(ck)
        else:
            t0 = time.time()
            s, miss = frame_sums(f, a.mode, a.threads)
            np.save(ck, s)
            print(f"frame {f:3d} {lam[f]:.3f} um  {time.time() - t0:5.1f}s  missing tiles {miss}", flush=True)
        n = s[2]
        good = n > 0
        meanL[f, good] = s[0, good] / n[good]
        meanG[f, good] = s[1, good] / n[good]
        count[f] = n
    np.savez_compressed(os.path.join(a.work, f"raw_{a.mode}.npz"), meanL=meanL, meanG=meanG, count=count, lam=lam)
    write_outputs(a.out, a.mode, lam, meanL, meanG, count, props)


def write_outputs(out, mode, lam, meanL, meanG, count, props):
    S = restretch(meanL)  # (102, npix), area mean taken linearly then re-stretched; nan = no data
    valid = [f not in BLANK and bool(np.isfinite(S[f]).any()) for f in range(NFRAMES)]
    med = np.full(NFRAMES, np.nan)
    sig = np.full(NFRAMES, np.nan)
    medL = np.full(NFRAMES, np.nan)
    for f in range(NFRAMES):
        if not valid[f]:
            continue
        x = S[f][np.isfinite(S[f])]
        med[f] = np.median(x)
        mad = np.median(np.abs(x - med[f])) * 1.4826
        # The sky's dynamic range is huge and most pixels sit near level 0, so 1.4826*MAD alone makes
        # the whole Galactic plane / bright nebulae clip at +4 (measured: ~10% of all values) and their
        # spectral shape is lost.  Floor sigma so that the 99.5th percentile maps to +4: then <~0.5%
        # of values clip, bright regions keep their shape, and faint noise-dominated sky collapses
        # towards z ~ 0 (small shape variance) instead of producing random shapes.
        sig[f] = max(mad, (np.percentile(x, 99.5) - med[f]) / CLIP, 1e-4)
        medL[f] = np.median(meanL[f][np.isfinite(meanL[f])])
    z = (S - med[:, None]) / sig[:, None]
    q = np.clip(np.round(np.clip(z, -CLIP, CLIP) * QSCALE), -127, 127)
    q = np.where(np.isfinite(z), q, NODATA).astype(np.int8).T.copy()  # (npix, 102)
    q.tofile(os.path.join(out, "index.bin"))

    nbands = np.isfinite(S).sum(axis=0)
    bright = np.nanmean(np.where(np.isfinite(S), S, np.nan), axis=0)
    bright_b = np.where(nbands > 0, np.clip(np.round(np.nan_to_num(bright) * 255), 0, 255), 0).astype(np.uint8)
    np.stack([bright_b, nbands.astype(np.uint8)], axis=1).tofile(os.path.join(out, "pixmeta.bin"))

    ra, dec = pix2ang_nest(ORDER, np.arange(NPIX))
    np.stack([ra, dec], axis=1).astype(np.float32).tofile(os.path.join(out, "coords.bin"))

    zz = z[np.isfinite(z)]
    meta = {
        "version": 1,
        "source": {
            "title": props.get("obs_title"),
            "hips": BASE,
            "creator_did": props.get("creator_did"),
            "hips_release_date": props.get("hips_release_date"),
            "copyright": f"{props.get('obs_copyright')} / {props.get('hips_copyright')}",
            "pixel_function": props.get("hips_pixel_function"),
            "pixel_cut": props.get("hips_pixel_cut"),
            "input": ("all 768 Norder3 tiles (512x512 PNG) of each frame" if mode == "tiles"
                      else "Norder3/Allsky_<f>.png (64x64 decimated thumbnails of the order-3 tiles)"),
        },
        "created_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "order": ORDER, "nside": NSIDE, "npix": NPIX, "scheme": "nested", "frame": "equatorial (ICRS)",
        "bands": NFRAMES,
        "lambda_um": lam,
        "valid": valid,
        "files": {
            "index.bin": "Int8, npix x 102, row-major (pixel p occupies bytes [102p, 102p+102))",
            "pixmeta.bin": "Uint8, npix x 2: [brightness, nbands]; brightness = round(255 * mean over bands with data of S), nbands = bands with data",
            "coords.bin": "Float32 little-endian, npix x 2: [RA, Dec] deg of the nested order-6 pixel centre",
        },
        "encoding": (
            "For pixel p and band b: S = asinh(K*Lmean)/asinh(K*260) with K=0.97435, where Lmean is the area mean of the "
            "de-stretched linear 8-bit level L of every HiPS PNG pixel inside the order-6 pixel (L recovered by inverting the "
            "HipsGen asinh LUT g=floor(255*asinh(K*L)/asinh(K*260))). S is on the same 0..1 asinh scale as hipsRender.ts "
            "sampleSpectrum (value = g/254) but averaged in the linear domain. z = (S - median[b]) / sigma[b]; "
            "stored byte = round(clip(z,-4,4) * 127/4); -128 = no data. Decode: z = byte * 4/127; "
            "S ~= median[b] + z*sigma[b] (exact only inside the clip). For SHAPE matching subtract each pixel's mean z over "
            "valid bands (and normalise) before comparing, since a uniformly brighter pixel has positive z everywhere."
        ),
        "z_clip": CLIP, "z_scale": QSCALE, "nodata": NODATA,
        "median": [None if not np.isfinite(v) else round(float(v), 6) for v in med],
        "sigma": [None if not np.isfinite(v) else round(float(v), 6) for v in sig],
        "sigma_definition": "max(1.4826*MAD, (P99.5 - median)/4) of S over all pixels with data (so ~0.5% of values clip at +4; pure MAD would clip ~10%, the whole Galactic plane)",
        "median_level": [None if not np.isfinite(v) else round(float(v), 4) for v in medL],
        "level_to_MJy_sr_inferred": 40.0 / 255.0,
        "stats": {
            "z_fraction_clipped_high": round(float((zz >= CLIP).mean()), 4),
            "z_fraction_clipped_low": round(float((zz <= -CLIP).mean()), 4),
            "z_percentiles_1_5_25_50_75_95_99": [round(float(v), 3) for v in np.percentile(zz, [1, 5, 25, 50, 75, 95, 99])],
            "pixels_without_any_data": int((nbands == 0).sum()),
        },
        "notes": [
            "Real SPHEREx DR1 data, but derived from the DISPLAY-STRETCHED 8-bit PNG HiPS tiles (asinh, cut 0..40 MJy/sr), "
            "not from calibrated images: values are a picture of the sky, good for comparing spectral SHAPES, not for photometry.",
            "The PNG grey values are an asinh LUT of an integer linear level (~0.157 MJy/sr per level if the 0..40 MJy/sr cut maps "
            "linearly onto 0..255 - an inference). Most high-latitude pixels are at level 0 in every band: the cube appears "
            "background (zodiacal light) subtracted and clipped at 0, so faint-sky spectra are mostly noise / quantisation.",
            "Frames 50 and 51 (band 3 ch 17, band 4 ch 1, dichroic channels) are blank in the cube (valid=false, stored -128).",
            "Order-6 pixels are ~0.92 deg across (49152 pixels, ~0.84 deg^2 each); every value is an area average over "
            + ("~4096 order-12 HiPS pixels." if mode == "tiles" else "64 point samples (Allsky decimation)."),
            "Built by server/scripts/build_starmatch_index.py.",
        ],
    }
    json.dump(meta, open(os.path.join(out, "index.json"), "w"), indent=1)
    print("wrote", out, "z stats", meta["stats"])


# ------------------------------------------------------------------------------------------------

TARGETS = [
    ("Betelgeuse", 88.79294, 7.40706),
    ("Orion Nebula M42", 83.82208, -5.39111),
    ("Galactic centre Sgr A*", 266.41683, -29.00781),
    ("North America Nebula NGC 7000 (Cygnus X)", 314.75, 44.33),
    ("Lockman Hole (high-latitude blank field)", 161.25, 57.9),
]


def cmd_validate(a):
    out = a.out
    meta = json.load(open(os.path.join(out, "index.json")))
    lam = np.array(meta["lambda_um"])
    q = np.fromfile(os.path.join(out, "index.bin"), dtype=np.int8).reshape(NPIX, NFRAMES)
    coords = np.fromfile(os.path.join(out, "coords.bin"), dtype=np.float32).reshape(NPIX, 2)
    pm = np.fromfile(os.path.join(out, "pixmeta.bin"), dtype=np.uint8).reshape(NPIX, 2)
    raw = np.load(os.path.join(a.work, f"raw_{a.mode}.npz"))
    meanL, meanG = raw["meanL"], raw["meanG"]
    S = restretch(meanL)
    print("== sizes", {f: os.path.getsize(os.path.join(out, f)) for f in os.listdir(out)})

    # --- coordinates vs healpy / astropy-healpix
    try:
        import healpy as hp
        th, ph = hp.pix2ang(NSIDE, np.arange(NPIX), nest=True, lonlat=True)
        d = np.hypot(((coords[:, 0] - th + 180) % 360 - 180) * np.cos(np.radians(ph)), coords[:, 1] - ph)
        print(f"== coords vs healpy.pix2ang(nest): max sep {d.max() * 3600:.4f} arcsec")
        rng = np.random.default_rng(1)
        ra_r, de_r = rng.uniform(0, 360, 20000), np.degrees(np.arcsin(rng.uniform(-1, 1, 20000)))
        for order in (6, 9, 14):
            ts = np.array([ang2pix_ts(r, d_, order) for r, d_ in zip(ra_r[:4000], de_r[:4000])])
            ref = hp.ang2pix(1 << order, ra_r[:4000], de_r[:4000], nest=True, lonlat=True)
            print(f"== hipsRender ang2pix port vs healpy order {order}: {np.mean(ts == ref) * 100:.2f}% identical of 4000")
    except ImportError:
        print("healpy not installed; skipping")
    try:
        from astropy_healpix import HEALPix
        import astropy.units as u
        lon, lat = HEALPix(nside=NSIDE, order="nested").healpix_to_lonlat(np.arange(NPIX))
        d = np.hypot(((coords[:, 0] - lon.to_value(u.deg) + 180) % 360 - 180) * np.cos(lat.to_value(u.rad)), coords[:, 1] - lat.to_value(u.deg))
        print(f"== coords vs astropy_healpix: max sep {d.max() * 3600:.4f} arcsec")
    except ImportError:
        pass

    # --- tile-cell convention: every order-6 pixel centre, located with the hipsRender port at order 3 /
    #     width 512, must fall in tile p>>6 inside block (row//64, col//64) whose nested child index is p&63
    bad = 0
    for p in range(0, NPIX, 7):
        n, col, row = locate_in_tile(float(coords[p, 0]), float(coords[p, 1]), 3, 512)
        child = int(spread_bits(int(row // 64))) + 2 * int(spread_bits(int(col // 64)))
        bad += (n != p >> 6) or (child != (p & 63))
    print(f"== tile-cell convention check (every 7th pixel): {bad} mismatches")

    # --- known positions
    def show(p, label):
        Sp, Lp = S[:, p], meanL[:, p]
        def at(um):
            i = int(np.argmin(np.abs(lam - um)))
            return i
        pick = [0.75, 1.0, 1.25, 1.65, 2.2, 3.03, 3.29, 3.57, 4.05, 4.6, 4.99]
        s_str = " ".join(f"{lam[at(u)]:.2f}:{Lp[at(u)] * 40 / 255:6.2f}" for u in pick)
        cont = np.nanmean(np.r_[Lp[at(3.03) - 1:at(3.03) + 2], Lp[at(3.62) - 1:at(3.62) + 2]])
        pah = np.nanmean(Lp[at(3.29) - 1:at(3.29) + 2])
        br = np.nanmean(Lp[at(4.05) - 1:at(4.05) + 2]); cbr = np.nanmean(np.r_[Lp[at(3.90)], Lp[at(4.20)]])
        print(f"-- {label}: pix {p} centre ({coords[p, 0]:.3f},{coords[p, 1]:.3f}) brightness {pm[p, 0]} nb {pm[p, 1]}")
        print(f"   area-mean flux (MJy/sr, inferred = level*40/255) at um: {s_str}")
        print(f"   PAH 3.29/continuum(3.03,3.62) = {pah / cont if cont > 0 else float('nan'):.2f}   "
              f"Br-alpha 4.05/(3.90,4.20) = {br / cbr if cbr > 0 else float('nan'):.2f}   "
              f"S(0.75..1.1)/S(3.8..5) = {np.nanmean(Sp[:17]) / max(1e-6, np.nanmean(Sp[68:])):.2f}   "
              f"z range [{q[p][q[p] > -128].min() / QSCALE:.2f},{q[p][q[p] > -128].max() / QSCALE:.2f}]")

    print("== known positions")
    picks = []
    for name, ra, dec in TARGETS:
        p = ang2pix_ts(ra, dec, ORDER)
        picks.append(p)
        show(p, name)
    print("-- all-sky median (for reference): flux at um " + " ".join(
        f"{lam[i]:.2f}:{meta['median_level'][i] * 40 / 255:5.2f}" for i in (0, 12, 26, 44, 59, 62, 66, 72, 90, 101)))

    # --- cross-check against hipsRender sampleSpectrum logic on full-resolution order-5 tiles
    print("== cross-check vs order-5 full-res tiles (sampleSpectrum logic)")
    for name, p in (("M42", picks[1]), ("Galactic centre", picks[2]), ("Lockman Hole", picks[4])):
        ra, dec = float(coords[p, 0]), float(coords[p, 1])
        n5, col, row = locate_in_tile(ra, dec, 5, 512)
        qd = p & 3
        bx, by = qd & 1, qd >> 1
        assert n5 == p >> 2 and int(row // 256) == bx and int(col // 256) == by, "convention mismatch"
        blockG, blockL, point = [], [], []
        frames = [f for f in range(NFRAMES) if f not in BLANK]
        def fetch(f):
            raw_ = http_get(tile_url(5, n5, f))
            return f, (decode(raw_) if raw_ else None)
        res = dict(ThreadPoolExecutor(12).map(fetch, frames))
        for f in frames:
            g, ok = res[f]
            G = np.where(ok, np.maximum(g, 1), 0)
            blk = (slice(bx * 256, bx * 256 + 256), slice(by * 256, by * 256 + 256))
            o = ok[blk]
            blockG.append(G[blk][o].mean() / 254)
            blockL.append(GREY_TO_L[g[blk][o]].mean())
            # sampleSpectrum(ra, dec, radiusPx=1, order=5): mean of non-empty px within radius 1 of floor(col/row)
            c0, r0 = math.floor(col), math.floor(row)
            vals = [G[min(511, max(0, r0 + dy)), min(511, max(0, c0 + dx))] for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dx * dx + dy * dy <= 1]
            vals = [int(v) for v in vals if v]
            point.append(sum(vals) / len(vals) / 254 if vals else np.nan)
        fr = np.array(frames)
        bG, bL, pt = np.array(blockG), np.array(blockL), np.array(point)
        iG, iL = meanG[fr, p] / 254, meanL[fr, p]
        med_ = np.array([np.nan if v is None else v for v in meta["median"]], float)[fr]
        sig_ = np.array([np.nan if v is None else v for v in meta["sigma"]], float)[fr]
        Sb = (restretch(bL) - med_) / sig_
        print(f"-- {name} pix {p} -> Norder5 Npix{n5} quadrant rows {bx * 256}.. cols {by * 256}.. ; centre col {col:.1f} row {row:.1f}")
        print(f"   linear-level block mean: order5 vs index(order3)  r={np.corrcoef(bL, iL)[0, 1]:.4f}  "
              f"median |diff| {np.median(np.abs(bL - iL)):.3f} levels (index median level {np.median(iL):.2f})")
        print(f"   stretched (g/254) block mean: r={np.corrcoef(bG, iG)[0, 1]:.4f} median |diff| {np.median(np.abs(bG - iG)):.4f}")
        zq = q[p, fr] / QSCALE
        ok_ = np.abs(Sb) < CLIP
        print(f"   z from order-5 block vs stored z: r={np.corrcoef(np.clip(Sb, -4, 4), zq)[0, 1]:.4f} "
              f"median |dz| {np.median(np.abs(np.clip(Sb, -4, 4) - zq)):.3f} (unclipped bands {ok_.sum()})")
        print(f"   sampleSpectrum point value (radius 1 px at pixel centre) vs index stretched mean: "
              f"r={np.corrcoef(pt[np.isfinite(pt)], iG[np.isfinite(pt)])[0, 1]:.3f}  medians {np.nanmedian(pt):.3f} vs {np.median(iG):.3f}")

    # --- z distribution
    v = q[q > NODATA].astype(float) / QSCALE
    hist, edges = np.histogram(v, bins=np.arange(-4, 4.01, 0.5))
    print("== z histogram (0.5 bins from -4):", (hist / hist.sum()).round(3).tolist())
    print(f"   fraction at clip +4: {(q == 127).mean():.4f}  at -4: {(q == -127).mean():.4f}  distinct bytes used: {len(np.unique(q))}")
    zc = np.where(q > NODATA, q, 0).astype(float)
    nb = (q > NODATA).sum(1)
    zc = zc - (zc.sum(1) / np.maximum(nb, 1))[:, None] * (q > NODATA)
    norms = np.sqrt((zc ** 2).sum(1))
    print(f"   per-pixel shape (mean-removed z) norm: percentiles 5/50/95 = {np.percentile(norms / QSCALE, [5, 50, 95]).round(2).tolist()}; "
          f"pixels with zero shape variance: {(norms == 0).sum()}")
    zz = zc / np.maximum(norms, 1e-9)[:, None]
    rng = np.random.default_rng(0)
    i = rng.integers(0, NPIX, 3000); j = rng.integers(0, NPIX, 3000)
    cs = (zz[i] * zz[j]).sum(1)
    print(f"   cosine similarity of random pixel pairs (shape vectors): percentiles 5/50/95 = {np.percentile(cs, [5, 50, 95]).round(3).tolist()}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["build", "validate", "rewrite"])
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--mode", choices=["tiles", "allsky"], default="tiles")
    ap.add_argument("--threads", type=int, default=16)
    a = ap.parse_args()
    if a.cmd == "build":
        cmd_build(a)
    elif a.cmd == "rewrite":  # re-encode outputs from the saved raw arrays (no network for the data)
        r = np.load(os.path.join(a.work, f"raw_{a.mode}.npz"))
        props = parse_properties(open(os.path.join(a.work, "properties.txt")).read())
        write_outputs(a.out, a.mode, list(map(float, r["lam"])), r["meanL"], r["meanG"], r["count"], props)
    else:
        cmd_validate(a)


if __name__ == "__main__":
    sys.exit(main())
