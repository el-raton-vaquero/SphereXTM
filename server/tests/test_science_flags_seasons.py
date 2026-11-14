from astropy.io import fits
import numpy as np
import pytest

from spherex.science import flags as fl
from spherex.science.seasons import assign_seasons, season_table


def dr1_header():
    h = fits.Header()
    for bit, (name, desc) in fl.DR1_FLAG_DEFINITIONS.items():
        h[f"MSKN{bit:04d}"] = name
        h[f"MSKM{bit:04d}"] = 1 << bit
        h[f"MSKD{bit:04d}"] = desc
    return h


def test_header_parsing_matches_transcription():
    defs = fl.definitions_from_header(dr1_header())
    assert defs == fl.default_definitions()
    assert defs[1] == "OVERFLOW" and defs[22] == "GHOST" and defs[21] == "SOURCE"


def test_inconsistent_mask_rejected():
    h = dr1_header()
    h["MSKM0001"] = 4
    with pytest.raises(ValueError):
        fl.definitions_from_header(h)
    with pytest.raises(ValueError):
        fl.definitions_from_header(fits.Header())


def test_decode_and_categories():
    v = (1 << 1) | (1 << 22) | (1 << 21) | (1 << 30)
    assert fl.decode(v) == ["OVERFLOW", "SOURCE", "GHOST", "BIT30"]
    masks = fl.masks_by_category()
    assert masks["saturation"] & (1 << 1)
    assert masks["artifact"] & (1 << 22)
    assert masks["informational"] & (1 << 21)
    assert masks["bad"] & (1 << 30)  # unknown bit -> bad (conservative)
    assert fl.category("NONFUNC") == "bad"


def test_summarize_counts_with_weights():
    flags = np.array([[2, 0], [2 | (1 << 20), 1 << 29]], np.uint32)
    counts = fl.summarize(flags, weights=np.array([[1, 1], [1, 0]]))
    assert counts == {"OVERFLOW": 2, "CROSSTALK": 1}


def test_seasons_split_on_gaps():
    mjds = [60800, 60801, 60990, 60805, 61170, 60991]
    assert assign_seasons(mjds) == [0, 0, 1, 0, 2, 1]
    table = season_table(mjds)
    assert [s["n_frames"] for s in table] == [3, 2, 1]
    assert table[1]["start_mjd"] == 60990
    assert assign_seasons([]) == []
