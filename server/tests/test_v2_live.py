"""Offline tests for spherex.live (no network). Synthetic FITS here are TEST FIXTURES only."""
from __future__ import annotations

import base64
import io
import json

from astropy.io import fits
from astropy.wcs import WCS
import numpy as np
import pytest

from spherex import live


@pytest.fixture(autouse=True)
def isolated_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("PRISM_CACHE_DIR", str(tmp_path / "cache"))


# ----------------------------------------------------------------------- fixtures
NX = NY = 120
FLAG_NAMES = {0: "TRANSIENT", 1: "OVERFLOW", 6: "NONFUNC", 21: "SOURCE", 26: "BLOOM"}


def celestial_header(ra=150.0, dec=2.0, nx=NX, ny=NY) -> fits.Header:
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [nx / 2 + 0.5, ny / 2 + 0.5]
    theta = np.deg2rad(20.0)
    s = 6.15 / 3600
    w.wcs.cd = [[-s * np.cos(theta), s * np.sin(theta)], [s * np.sin(theta), s * np.cos(theta)]]
    h = w.to_header()
    h["CRPIX1A"], h["CRPIX2A"] = 1.0, 1.0
    h["CTYPE1A"], h["CTYPE2A"] = "LINEAR", "LINEAR"
    return h


def synthetic_mef(ra=150.0, dec=2.0) -> tuple[bytes, dict]:
    rng = np.random.default_rng(1)
    image = rng.normal(1.0, 0.1, (NY, NX)).astype(np.float32)
    flags = np.zeros((NY, NX), dtype=np.int32)
    flags[10:20, 30:40] = 1 << 21
    flags[59:61, 59:61] = (1 << 1) | (1 << 26)  # saturation at centre (crpix 60.5)
    flags[5, 5] = 1 << 6
    variance = np.full((NY, NX), 0.01, dtype=np.float32)
    h = celestial_header(ra, dec)
    h["EXTNAME"] = "IMAGE"
    h["BUNIT"] = "MJy / sr"
    h["DETECTOR"] = 3
    h["OBSID"] = "2025W40_1A_0001_1"
    h["TIMESYS"] = "UTC"
    h["DATE-OBS"] = "2025-10-01T00:00:00.000"
    h["MJD-OBS"] = 60949.0
    h["XPOSURE"] = 113.58
    h["PSF_FWHM"] = 9.0
    fh = celestial_header(ra, dec)
    for bit, name in FLAG_NAMES.items():
        fh[f"MSKN{bit:04d}"] = name
    hdus = fits.HDUList([
        fits.PrimaryHDU(),
        fits.ImageHDU(image, header=h, name="IMAGE"),
        fits.CompImageHDU(flags, header=fh, name="FLAGS", compression_type="RICE_1",
                          tile_shape=(1, NX)),
        fits.ImageHDU(variance, name="VARIANCE"),
        fits.ImageHDU(np.zeros((NY, NX), np.float32), name="ZODI"),
        fits.BinTableHDU.from_columns([fits.Column(name="PSF", format="100D",
                                                   array=np.zeros((7, 100)))], name="EPSF"),
        fits.BinTableHDU.from_columns([
            fits.Column(name="X", format="2J", array=np.array([[0, NX - 1]])),
            fits.Column(name="Y", format="2J", array=np.array([[0, NY - 1]])),
            fits.Column(name="VALUES", format="8E", dim="(2,2,2)", array=np.ones((1, 2, 2, 2)))],
            name="WCS-WAVE"),
    ])
    buf = io.BytesIO()
    hdus.writeto(buf)
    row = {"obs_id": h["OBSID"], "t_min": "60949.0", "energy_bandpassname": "SPHEREx-D3",
           "obs_collection": "spherex_dr1",
           "access_url": "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/x/3/f.fits",
           "cloud_access": json.dumps({"aws": {"bucket_name": "nasa-irsa-spherex",
                                               "key": "dr1/level2/x/3/f.fits"}})}
    return buf.getvalue(), {"image": image, "flags": flags, "variance": variance, "row": row}


class FakeClient(live.RangeClient):
    """Serves byte ranges from an in-memory FITS file (no network)."""

    def __init__(self, blob: bytes):
        super().__init__(host="example.invalid")
        self.blob = blob

    def get(self, path, start=None, end=None, suffix=None):
        data = self.blob[-suffix:] if suffix is not None else self.blob[start:end + 1]
        self.requests += 1
        self.bytes_transferred += len(data)
        return data, len(self.blob)


# ----------------------------------------------------------------------- tests
def test_grid_is_north_up_odd_and_centred():
    g = live.make_grid(10.0, -5.0, 4.0)
    assert g.n % 2 == 1 and g.n == 39
    j = g.to_json()
    assert j["north_up"] and j["wcs"]["crval"] == [10.0, -5.0]
    assert j["wcs"]["cd"][0][0] < 0 and j["wcs"]["cd"][1][1] < 0
    x, y = g.wcs.world_to_pixel_values(10.0, -5.0)
    assert abs(x - (g.n - 1) / 2) < 1e-9 and abs(y - (g.n - 1) / 2) < 1e-9


def test_assign_seasons_splits_on_60_day_gaps():
    labels, seasons = live.assign_seasons([100.0, 101.0, 300.0, 140.0, 305.0, 500.0])
    assert labels == [0, 0, 1, 0, 1, 2]
    assert [s["n_frames"] for s in seasons] == [3, 2, 1]
    assert seasons[0]["start_mjd"] == 100.0 and seasons[0]["end_mjd"] == 140.0


def _row(obs, det, t, col="spherex_dr1"):
    return {"obs_id": obs, "energy_bandpassname": f"SPHEREx-D{det}", "t_min": str(t),
            "obs_collection": col, "access_url": f"u/{obs}/{det}/{col}",
            "dataproduct_subtype": "science"}


def test_dedupe_prefers_dr1_and_select_is_balanced_and_deterministic():
    rows = [_row(f"o{i}", d, 60000 + i) for i in range(40) for d in (1, 2, 6)]
    rows.append(_row("o3", 1, 60003, "spherex_qr3"))
    deduped = live.dedupe_rows(rows)
    assert len(deduped) == 120
    assert all(r["obs_collection"] == "spherex_dr1" for r in deduped if r["obs_id"] == "o3")
    picked = live.select_rows(deduped, 30)
    assert len(picked) == 30
    per_det = {d: sum(1 for r in picked if live.detector_of(r) == d) for d in (1, 2, 6)}
    assert per_det == {1: 10, 2: 10, 6: 10}
    times = sorted(float(r["t_min"]) for r in picked if live.detector_of(r) == 1)
    assert times[0] == 60000 and times[-1] == 60039  # spans the full baseline
    assert picked == live.select_rows(deduped, 30)
    assert live.select_rows(deduped[:5], 30) == deduped[:5]


def test_parse_header_and_data_bytes():
    hdr = fits.Header()
    hdr["XTENSION"], hdr["BITPIX"], hdr["NAXIS"] = "IMAGE", -32, 2
    hdr["NAXIS1"], hdr["NAXIS2"], hdr["PCOUNT"], hdr["GCOUNT"] = 10, 3, 0, 1
    raw = hdr.tostring().encode()
    parsed, length = live._parse_header(raw, 0)
    assert length == 2880 and parsed["NAXIS1"] == 10
    assert live._data_bytes(parsed) == 2880
    assert live._parse_header(raw[:160], 0) is None


def test_s3_range_reader_matches_direct_read_including_compressed_flags():
    blob, truth = synthetic_mef()
    client = FakeClient(blob)
    cut = live.load_native_s3(truth["row"], 150.0, 2.0, 10, client)
    x0, y0 = cut.origin_xy
    ny, nx = cut.image.shape
    np.testing.assert_array_equal(cut.image, truth["image"][y0:y0 + ny, x0:x0 + nx])
    np.testing.assert_array_equal(cut.flags, truth["flags"][y0:y0 + ny, x0:x0 + nx].astype(np.uint32))
    np.testing.assert_array_equal(cut.variance, truth["variance"][y0:y0 + ny, x0:x0 + nx])
    # Shifted CRPIX keeps the sky mapping identical to the full frame.
    full = WCS(celestial_header())
    a = full.pixel_to_world(x0 + 3, y0 + 4)
    b = cut.wcs.pixel_to_world(3, 4)
    assert a.separation(b).arcsec < 1e-6
    assert cut.flag_names()[21] == "SOURCE"
    assert cut.transfer_bytes < len(blob)
    # Second read uses the cached layout: only row reads remain.
    before = client.requests
    live.load_native_s3(truth["row"], 150.0, 2.0, 10, client)
    assert client.requests - before == 4  # IMAGE rows, FLAGS descriptors + heap, VARIANCE rows


def test_process_frame_reprojects_flags_and_reports_saturation():
    blob, truth = synthetic_mef()
    cut = live.load_native_s3(truth["row"], 150.0, 2.0, 30, FakeClient(blob))
    grid = live.make_grid(150.0, 2.0, 4.0)
    res = live.process_frame(cut, grid)
    meta = res["meta"]
    assert res["pixels"].shape == (grid.n, grid.n) and res["pixels"].dtype == np.float32
    assert meta["saturated_at_center"] is True
    assert "OVERFLOW" in meta["center_flags"] and "BLOOM" in meta["center_flags"]
    assert meta["mjd"] == 60949.0 and meta["detector"] == 3
    assert 0.9 < meta["valid_fraction"] <= 1.0
    assert meta["flag_bits"]["SOURCE"] == 21
    # Centre pixel carries the saturation bits after nearest-neighbour reprojection.
    c = grid.n // 2
    assert res["flags"][c, c] & (1 << 1)
    json.dumps(meta, allow_nan=False)


def test_process_frame_rejects_metadata_mismatch():
    blob, truth = synthetic_mef()
    row = dict(truth["row"], obs_id="OTHER")
    cut = live.load_native_s3(row, 150.0, 2.0, 10, FakeClient(blob))
    with pytest.raises(ValueError, match="disagree"):
        live.process_frame(cut, live.make_grid(150.0, 2.0, 2.0))


def test_position_outside_frame_is_an_error_not_data():
    blob, truth = synthetic_mef()
    with pytest.raises(ValueError):
        live.load_native_s3(truth["row"], 160.0, 2.0, 10, FakeClient(blob))


def test_search_end_to_end_offline(monkeypatch):
    blob, truth = synthetic_mef()
    rows = []
    for i, mjd in enumerate((60949.0, 61100.0)):
        r = dict(truth["row"], obs_id=f"2025W40_1A_000{i}_1", t_min=str(mjd),
                 access_url=f"https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/x/3/f{i}.fits")
        rows.append(r)

    def fake_discover(ra, dec, collections, **_):
        return rows, ["https://irsa.ipac.caltech.edu/SIA?test"], False

    def fake_load(row, ra, dec, half_px, client=None):
        cut = live.load_native_s3(truth["row"], ra, dec, half_px, FakeClient(blob))
        cut.row = row
        cut.header["OBSID"] = row["obs_id"]
        cut.header["MJD-OBS"] = float(row["t_min"])
        from astropy.time import Time
        cut.header["DATE-OBS"] = Time(float(row["t_min"]), format="mjd").isot
        return cut

    monkeypatch.setattr(live, "discover", fake_discover)
    monkeypatch.setattr(live, "load_native", fake_load)
    events = []
    res = live.search(150.0, 2.0, 4.0, 10, progress=events.append)
    assert res["cache"] == "live" and len(res["frames"]) == 2
    assert [f["season"] for f in res["frames"]] == [0, 1]
    assert len(res["seasons"]) == 2 and res["detectors"][0]["detector"] == 3
    n = res["grid"]["n"]
    px = live.decode_pixels(res["frames"][0]["pixels_b64"], n)
    fl = live.decode_flags_array(res["frames"][0]["flags_b64"], n)
    assert px.shape == (n, n) and fl.dtype == np.dtype("<u4")
    assert res["provenance"]["real_data"] is True and res["provenance"]["citation"]
    assert events[0]["stage"] == "discovery" and events[-1]["stage"] == "done"
    json.dumps(res, allow_nan=False)
    # Second call is served from the frame cache.
    again = live.search(150.0, 2.0, 4.0, 10)
    assert again["provenance"]["transfer_bytes"] == 0
    np.testing.assert_array_equal(
        live.decode_pixels(again["frames"][0]["pixels_b64"], n), px)


def test_search_reports_total_failure_transparently(monkeypatch):
    monkeypatch.setattr(live, "discover", lambda *a, **k: ([_row("o1", 2, 60000)], ["q"], False))

    def boom(*a, **k):
        raise RuntimeError("S3 down")

    monkeypatch.setattr(live, "load_native", boom)
    with pytest.raises(live.LiveError) as err:
        live.search(150.0, 2.0)
    assert err.value.status_code == 502 and "S3 down" in json.dumps(err.value.to_dict())


def test_no_coverage_is_404(monkeypatch):
    monkeypatch.setattr(live, "discover", lambda *a, **k: ([], ["q"], False))
    with pytest.raises(live.LiveError) as err:
        live.search(150.0, 2.0)
    assert err.value.status_code == 404 and err.value.error_type == "no_coverage"


@pytest.mark.parametrize("kwargs", [dict(fov=0.5), dict(fov=25), dict(max_frames=0),
                                    dict(max_frames=500)])
def test_search_parameter_bounds(kwargs):
    with pytest.raises(live.LiveError) as err:
        live.search(150.0, 2.0, **kwargs)
    assert err.value.status_code == 422


def test_discover_caches_and_surfaces_archive_errors(monkeypatch):
    xml = (b'<?xml version="1.0"?><VOTABLE><RESOURCE><INFO name="QUERY_STATUS" value="OK"/>'
           b'<TABLE><FIELD name="obs_id"/><FIELD name="access_url"/><FIELD name="t_min"/>'
           b'<FIELD name="energy_bandpassname"/><FIELD name="obs_collection"/><DATA><TABLEDATA>'
           b'<TR><TD>a</TD><TD>u</TD><TD>60000</TD><TD>SPHEREx-D1</TD><TD>spherex_dr1</TD></TR>'
           b'</TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>')
    calls = []

    def fetch(url, limit, timeout):
        calls.append(url)
        return xml

    rows, urls, cached = live.discover(1.0, 2.0, ("spherex_dr1",), fetch=fetch)
    assert len(rows) == 1 and not cached and len(calls) == 1
    rows, urls, cached = live.discover(1.0, 2.0, ("spherex_dr1",), fetch=fetch)
    assert cached and len(calls) == 1

    def fail(url, limit, timeout):
        raise RuntimeError("HTTP 502")

    with pytest.raises(live.LiveError) as err:
        live.discover(3.0, 4.0, ("spherex_dr1",), fetch=fail)
    assert err.value.status_code == 502
    with pytest.raises(live.LiveError):
        live.discover(3.0, 4.0, ("spherex_qr2",), fetch=fetch)


def test_prune_cache_respects_limit(tmp_path):
    root = tmp_path / "c"
    root.mkdir()
    for i in range(5):
        (root / f"f{i}.bin").write_bytes(b"x" * 100)
    freed = live.prune_cache(root, limit=250)
    assert freed == 300 and sum(p.stat().st_size for p in root.iterdir()) == 200


def test_b64_encoding_is_little_endian():
    arr = np.array([[1.5, np.nan]], dtype=np.float32)
    raw = base64.b64decode(live._b64(arr, "<f4"))
    assert raw[:4] == np.float32(1.5).tobytes() if np.little_endian else True
    back = np.frombuffer(raw, "<f4")
    assert back[0] == 1.5 and np.isnan(back[1])
