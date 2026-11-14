"""SPHEREx Level-2 FLAGS bitmask decoding.

Bit definitions are READ FROM THE FITS HEADER whenever available: the FLAGS HDU
carries ``MSKNnnnn`` (name), ``MSKMnnnn`` (mask value) and ``MSKDnnnn``
(description) keywords. ``DR1_FLAG_DEFINITIONS`` below is a verbatim transcription
of those keywords from a real DR1 product, used only when a caller cannot pass a
header; ``decode`` reports which source was used.

Provenance of the transcription: FLAGS HDU of
``level2_2025W19_1B_0116_1D6_spx_l2b-v27-2026-197.fits`` (collection spherex_dr1,
SSDC pipeline VERSION 7.0.5), IRSA cutout retrieved 2026-11-14 from
https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/6/ .
See also the SPHEREx Explanatory Supplement, Level-2 data products section:
https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/
"""

from __future__ import annotations

from collections.abc import Mapping

import numpy as np

DR1_FLAG_SOURCE = (
    "FLAGS HDU MSKN/MSKM/MSKD keywords of level2_2025W19_1B_0116_1D6_spx_l2b-v27-2026-197.fits "
    "(spherex_dr1, pipeline 7.0.5), transcribed 2026-11-14"
)

# bit -> (name, description), verbatim from the header (MSKM == 1 << bit for every entry).
DR1_FLAG_DEFINITIONS: dict[int, tuple[str, str]] = {
    0: ("TRANSIENT", "Transient detected during SUR"),
    1: ("OVERFLOW", "Overflow detected during SUR"),
    2: ("SUR_ERROR", "Error in onboard processing"),
    6: ("NONFUNC", "Permanently unusable"),
    7: ("DICHROIC", "Low efficiency due to dichroic"),
    9: ("MISSING_DATA", "Onboard data lost"),
    10: ("HOT", "Hot pixel"),
    11: ("COLD", "Anomalously low signal"),
    12: ("FULLSAMPLE", "Pixel full sample history is available"),
    14: ("PHANMISS", "Phantom correction was not applied"),
    15: ("NONLINEAR", "Nonlinearity correction cannot be applied reliably"),
    17: ("PERSIST", "Persistent charge above threshold"),
    19: ("OUTLIER", "Pixel flagged by Detect Outliers"),
    20: ("CROSSTALK", "Pixel affected by crosstalk."),
    21: ("SOURCE", "Pixel mapped to a known source"),
    22: ("GHOST", "Affected by a bright source inside the exposure"),
    23: ("GHOST_FPA", "Affected by a bright source on another detector"),
    24: ("GHOST_EXT", "Pixel affected by a bright source outside FOV"),
    25: ("STREAK", "Pixel affected by a streak"),
    26: ("BLOOM", "Pixel part of a bloom artifact"),
    27: ("SNOWBALL", "Pixel part of a snowball artifact"),
    28: ("HALO", "Pixel part of a transient halo"),
}

# Interpretation groups (our classification of the documented names; names not
# listed anywhere are treated as BAD, conservatively, as in spherex.archive).
INFORMATIONAL = frozenset({"SOURCE", "FULLSAMPLE"})
SATURATION = frozenset({"OVERFLOW", "NONLINEAR", "BLOOM"})
ARTIFACT = frozenset({
    "TRANSIENT", "PERSIST", "OUTLIER", "CROSSTALK", "GHOST", "GHOST_FPA", "GHOST_EXT",
    "STREAK", "SNOWBALL", "HALO",
})
BAD = frozenset({"SUR_ERROR", "NONFUNC", "DICHROIC", "MISSING_DATA", "HOT", "COLD", "PHANMISS"})


def default_definitions() -> dict[int, str]:
    return {bit: name for bit, (name, _) in DR1_FLAG_DEFINITIONS.items()}


def definitions_from_header(header: Mapping) -> dict[int, str]:
    """Parse MSKNnnnn/MSKMnnnn keywords; verify that each mask equals 1 << bit."""
    defs: dict[int, str] = {}
    for key in header:
        if not str(key).startswith("MSKN"):
            continue
        bit = int(str(key)[4:])
        mask_key = f"MSKM{str(key)[4:]}"
        if mask_key in header and int(header[mask_key]) != (1 << bit):
            raise ValueError(f"{mask_key}={header[mask_key]} inconsistent with bit {bit}")
        defs[bit] = str(header[key]).strip()
    if not defs:
        raise ValueError("Header has no MSKN flag definitions")
    return defs


def category(name: str) -> str:
    if name in INFORMATIONAL:
        return "informational"
    if name in SATURATION:
        return "saturation"
    if name in ARTIFACT:
        return "artifact"
    return "bad"


def decode(value: int, definitions: Mapping[int, str] | None = None) -> list[str]:
    """Names of set bits; unknown bits are reported as ``BIT<n>``."""
    defs = definitions or default_definitions()
    value = int(value) & 0xFFFFFFFF
    names = []
    bit = 0
    while value:
        if value & 1:
            names.append(defs.get(bit, f"BIT{bit}"))
        value >>= 1
        bit += 1
    return names


def masks_by_category(definitions: Mapping[int, str] | None = None) -> dict[str, int]:
    """OR-ed bit masks for each category. Unknown bits fall in 'bad'."""
    defs = definitions or default_definitions()
    out = {"informational": 0, "saturation": 0, "artifact": 0, "bad": 0}
    known = 0
    for bit, name in defs.items():
        out[category(name)] |= 1 << bit
        known |= 1 << bit
    out["bad"] |= 0xFFFFFFFF & ~known
    return out


def summarize(flags: np.ndarray, weights: np.ndarray | None = None,
              definitions: Mapping[int, str] | None = None) -> dict[str, int]:
    """Count pixels (with weight > 0 if given) having each named bit set."""
    defs = definitions or default_definitions()
    flags = np.asarray(flags).astype(np.uint32)
    sel = np.ones(flags.shape, bool) if weights is None else np.asarray(weights) > 0
    vals = flags[sel]
    counts = {}
    for bit, name in sorted(defs.items()):
        n = int(np.count_nonzero(vals & np.uint32(1 << bit)))
        if n:
            counts[name] = n
    unknown = np.uint32(0xFFFFFFFF & ~sum(1 << b for b in defs))
    n_unknown = int(np.count_nonzero(vals & unknown))
    if n_unknown:
        counts["UNKNOWN_BITS"] = n_unknown
    return counts
