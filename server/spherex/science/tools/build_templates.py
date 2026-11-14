"""Rebuild the small brown-dwarf template CSVs from Beiler et al. (2024) JWST spectra.

Source: Zenodo record 10.5281/zenodo.14976898 (CC-BY-4.0), data behind Figs. 5-7 of
Beiler et al. 2024, ApJ 973, 107 (doi:10.3847/1538-4357/ad6301). Spectral types and
T_eff (1 R_Jup nominal-radius column) are copied from Table 4 of that paper
(arXiv:2407.08518v2).

The rows are copied verbatim (no resampling, no smoothing); only wavelengths
<= 5.3 um are kept because SPHEREx covers 0.75-5.0 um. Usage, from server/:

    uv run --locked python -m spherex.science.tools.build_templates <download_dir>

where <download_dir> holds the *.mrt files downloaded from the Zenodo record.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

from astropy.table import Table

ZENODO = "https://doi.org/10.5281/zenodo.14976898"
PAPER = "Beiler et al. 2024, ApJ 973, 107, doi:10.3847/1538-4357/ad6301"

# file -> (template id, display name, SpT, Teff_RJup [K]) from Beiler et al. 2024 Table 4.
SELECTION = {
    "SDSSpJ1346-00JWSTspectrum.mrt": ("bd_t6p5_sdss1346", "SDSSp J1346-00", "T6.5", 1011),
    "WISEPAJ1959-33JWSTspectrum.mrt": ("bd_t8_wise1959", "WISEPA J1959-33", "T8", 734),
    "WISEJ2102-44JWSTspectrum.mrt": ("bd_t9_wise2102", "WISE J2102-44", "T9", 552),
    "WISEJ0359-54JWSTspectrum.mrt": ("bd_y0_wise0359", "WISE J0359-54", "Y0", 453),
    "CWISEPJ1446-23JWSTspectrum.mrt": ("bd_y1_cwise1446", "CWISEP J1446-23", "Y1", 364),
}
LAMBDA_MAX_UM = 5.3


def main(download_dir: str) -> None:
    out = Path(__file__).resolve().parents[2] / "data" / "templates"
    out.mkdir(parents=True, exist_ok=True)
    for name, (tid, display, spt, teff) in SELECTION.items():
        path = Path(download_dir) / name
        md5 = hashlib.md5(path.read_bytes()).hexdigest()
        table = Table.read(path, format="ascii.cds")
        keep = table["lambda"] <= LAMBDA_MAX_UM
        lines = [
            f"# template_id: {tid}",
            f"# object: {display}",
            f"# spectral_type: {spt}",
            f"# teff_k: {teff}",
            "# teff_definition: T_eff assuming 1 R_Jup (Beiler et al. 2024 Table 4)",
            f"# source_file: {name} (md5 {md5})",
            f"# source: {ZENODO}",
            f"# reference: {PAPER}",
            "# licence: CC-BY-4.0",
            "# instrument: JWST NIRSpec PRISM (merged with MIRI LRS beyond 5 um, cut here)",
            f"# processing: rows copied verbatim, lambda <= {LAMBDA_MAX_UM} um",
            "lambda_um,flux_jy,err_jy,resolving_power",
        ]
        for row in table[keep]:
            lines.append(f"{row['lambda']:.5g},{row['S']:.5g},{row['e_S']:.5g},{row['R']:.5g}")
        (out / f"{tid}.csv").write_text("\n".join(lines) + "\n")
        print(tid, int(keep.sum()), "rows")


if __name__ == "__main__":
    main(sys.argv[1])
