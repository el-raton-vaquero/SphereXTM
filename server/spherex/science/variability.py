"""Photometric variability between seasons at MATCHED wavelengths.

Every SPHEREx frame samples a source at a different wavelength, so fluxes from
two seasons are only compared when both points come from the same detector and
their wavelengths differ by less than ``max_offset_bw`` times the bandwidth.
A spectrum with steep features would otherwise mimic variability.
"""

from __future__ import annotations

from collections.abc import Sequence
from itertools import combinations

import numpy as np
from scipy.stats import chi2 as chi2_dist

from spherex.science.photometry import fit_points


def matched_pairs(points: Sequence[dict], season_a: int, season_b: int, max_offset_bw: float = 0.5) -> list[tuple[dict, dict]]:
    good = fit_points(points)
    a = [p for p in good if p.get("season") == season_a]
    b = [p for p in good if p.get("season") == season_b]
    pairs, used = [], set()
    for pa in a:
        best, best_d = None, np.inf
        for j, pb in enumerate(b):
            if j in used or pb["detector"] != pa["detector"]:
                continue
            bw = min(pa.get("bandwidth_um") or np.inf, pb.get("bandwidth_um") or np.inf)
            if not np.isfinite(bw) or bw <= 0:
                continue
            d = abs(pa["lambda_um"] - pb["lambda_um"]) / bw
            if d <= max_offset_bw and d < best_d:
                best, best_d = j, d
        if best is not None:
            used.add(best)
            pairs.append((pa, b[best]))
    return pairs


def compare_seasons(points: Sequence[dict], *, max_offset_bw: float = 0.5, min_pairs: int = 3,
                    sys_frac: float = 0.02) -> dict:
    """Chi-square test of constant flux across all season pairs (matched wavelengths).

    ``sys_frac``: fractional calibration error added in quadrature per point (assumed 2%).
    Reports the weighted mean flux ratio last/first season for the largest pair set.
    """
    seasons = sorted({p["season"] for p in fit_points(points) if "season" in p})
    if len(seasons) < 2:
        return {"status": "na", "reason": f"{len(seasons)} season(s) with usable photometry; need 2"}
    chi2_tot, dof, per_pair = 0.0, 0, []
    for sa, sb in combinations(seasons, 2):
        pairs = matched_pairs(points, sa, sb, max_offset_bw)
        if len(pairs) < min_pairs:
            continue
        f1 = np.array([p[0]["flux"] for p in pairs])
        f2 = np.array([p[1]["flux"] for p in pairs])
        e1 = np.hypot([p[0]["err"] for p in pairs], sys_frac * np.abs(f1))
        e2 = np.hypot([p[1]["err"] for p in pairs], sys_frac * np.abs(f2))
        c2 = float((((f2 - f1) ** 2) / (e1 ** 2 + e2 ** 2)).sum())
        chi2_tot += c2
        dof += len(pairs)
        ok = (f1 > 0) & (f2 > 0)
        ratio = ratio_err = None
        if ok.sum() >= min_pairs:
            r = f2[ok] / f1[ok]
            re = r * np.hypot(e1[ok] / f1[ok], e2[ok] / f2[ok])
            w = 1 / re ** 2
            ratio, ratio_err = float((w * r).sum() / w.sum()), float(1 / np.sqrt(w.sum()))
        per_pair.append({"season_a": sa, "season_b": sb, "n_pairs": len(pairs), "chi2": c2,
                         "flux_ratio_b_over_a": ratio, "flux_ratio_err": ratio_err})
    if dof == 0:
        return {"status": "na", "reason": f"fewer than {min_pairs} wavelength-matched pairs between seasons"}
    p = float(chi2_dist.sf(chi2_tot, dof))
    biggest = max(per_pair, key=lambda d: d["n_pairs"])
    amp = None
    if biggest["flux_ratio_b_over_a"] is not None:
        amp = abs(biggest["flux_ratio_b_over_a"] - 1)
    # Amplitude must exceed 3x the (assumed) calibration repeatability and 3x its own error.
    variable = bool(p < 1e-3 and amp is not None and amp > max(0.05, 3 * sys_frac)
                    and amp > 3 * (biggest["flux_ratio_err"] or np.inf))
    return {"status": "ok", "chi2": chi2_tot, "dof": dof, "p_constant": p, "variable": variable,
            "amplitude_fraction": amp, "pairs": per_pair, "sys_frac_assumed": sys_frac,
            "n_pairs_total": dof,
            "method": "chi2 of matched-wavelength flux differences between seasons"}
