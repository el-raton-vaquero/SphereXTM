"""'Molecular goggles': band-depth indices from frames binned by wavelength.

Recipes live in recipes/goggles.json (see its ``definition`` field). Works on
(a) a stack of images already reprojected onto a common grid (per-pixel maps) or
(b) a list of photometry points (one index for a source).
"""

from __future__ import annotations

from collections.abc import Sequence
import json
from pathlib import Path

import numpy as np

RECIPES_PATH = Path(__file__).with_name("recipes") / "goggles.json"


def load_recipes() -> dict:
    data = json.loads(RECIPES_PATH.read_text())
    for r in data["recipes"]:
        lo, hi = r["band_um"]
        if not lo < hi:
            raise ValueError(f"Bad band window in {r['id']}")
        for c in r["continuum_um"]:
            if not c[0] < c[1] or (c[1] > lo and c[0] < hi):
                raise ValueError(f"Continuum window overlaps band in {r['id']}")
    return data


def recipe(recipe_id: str) -> dict:
    for r in load_recipes()["recipes"]:
        if r["id"] == recipe_id:
            return r
    raise KeyError(recipe_id)


def _window_mean(values: np.ndarray, weights: np.ndarray, sel: np.ndarray):
    """Weighted mean along axis 0 of values restricted to sel (bool, same shape)."""
    w = np.where(sel, weights, 0.0)
    wsum = w.sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(wsum > 0, (np.where(sel, values, 0.0) * w).sum(axis=0) / wsum, np.nan)
        err = np.where(wsum > 0, 1 / np.sqrt(wsum), np.nan)
    return mean, err, sel.sum(axis=0)


def band_depth(lambdas: np.ndarray, values: np.ndarray, variances: np.ndarray | None, rec: dict) -> dict:
    """Core computation. ``lambdas``/``values``/``variances`` have shape (N, ...).

    Pixels or entries with NaN value are ignored. Without variances, equal weights
    are used and the error is NaN (cannot be estimated honestly).
    """
    lambdas = np.asarray(lambdas, float)
    values = np.asarray(values, float)
    if lambdas.shape != values.shape:
        lambdas = np.broadcast_to(lambdas.reshape(lambdas.shape + (1,) * (values.ndim - lambdas.ndim)), values.shape)
    finite = np.isfinite(values) & np.isfinite(lambdas)
    if variances is None:
        weights = np.ones_like(values)
    else:
        variances = np.asarray(variances, float)
        finite &= np.isfinite(variances) & (variances > 0)
        weights = np.where(finite, 1 / np.where(finite, variances, 1.0), 0.0)
    lo, hi = rec["band_um"]
    band, band_err, n_band = _window_mean(values, weights, finite & (lambdas >= lo) & (lambdas <= hi))
    conts = []
    for c_lo, c_hi in rec["continuum_um"]:
        mean, err, n = _window_mean(values, weights, finite & (lambdas >= c_lo) & (lambdas <= c_hi))
        conts.append(((c_lo + c_hi) / 2, mean, err, n))
    centre = (lo + hi) / 2
    if len(conts) == 1:
        cont, cont_err = conts[0][1], conts[0][2]
        n_cont = conts[0][3]
    else:
        (l1, m1, e1, n1), (l2, m2, e2, n2) = conts[0], conts[-1]
        t = (centre - l1) / (l2 - l1)
        cont = (1 - t) * m1 + t * m2
        cont_err = np.sqrt(((1 - t) * e1) ** 2 + (t * e2) ** 2)
        n_cont = np.minimum(n1, n2)
    with np.errstate(invalid="ignore", divide="ignore"):
        depth = 1 - band / cont
        depth_err = np.abs(band / cont) * np.sqrt((band_err / band) ** 2 + (cont_err / cont) ** 2)
    depth = np.where((n_band > 0) & (n_cont > 0) & (cont > 0), depth, np.nan)
    if variances is None:
        depth_err = np.full_like(depth, np.nan)
    return {"depth": depth, "err": depth_err, "n_band": n_band, "n_cont": n_cont,
            "band": band, "continuum": cont}


def band_depth_maps(stack: Sequence[dict], recipe_ids: Sequence[str] | None = None) -> dict:
    """Per-pixel indices from a common-grid stack.

    Each stack entry: {'image': (ny,nx) array, 'lambda_um': float or (ny,nx) map,
    optional 'variance': (ny,nx)}. Returns {recipe_id: {depth, err, n_band, n_cont}} (numpy arrays).
    """
    if not stack:
        raise ValueError("Empty stack")
    images = np.stack([np.asarray(s["image"], float) for s in stack])
    lams = np.stack([np.broadcast_to(np.asarray(s["lambda_um"], float), images.shape[1:]) for s in stack])
    var = None
    if all(s.get("variance") is not None for s in stack):
        var = np.stack([np.asarray(s["variance"], float) for s in stack])
    data = load_recipes()
    out = {}
    for rec in data["recipes"]:
        if recipe_ids and rec["id"] not in recipe_ids:
            continue
        res = band_depth(lams, images, var, rec)
        out[rec["id"]] = res | {"recipe": rec}
    return out


SYS_DEPTH_FRAC = 0.03  # same fractional calibration error as the classifier


def band_depth_points(points: Sequence[dict], recipe_ids: Sequence[str] | None = None) -> list[dict]:
    """Indices from photometry points (uses only 'usable' points)."""
    from spherex.science.photometry import fit_points

    pts = fit_points(points)
    data = load_recipes()
    results = []
    for rec in data["recipes"]:
        if recipe_ids and rec["id"] not in recipe_ids:
            continue
        if not pts:
            results.append({"id": rec["id"], "molecule": rec["molecule"], "depth": None, "err": None,
                            "n_band": 0, "n_cont": 0, "status": "na"})
            continue
        lam = np.array([p["lambda_um"] for p in pts])
        val = np.array([p["flux"] for p in pts])
        var = np.array([p["err"] for p in pts]) ** 2
        res = band_depth(lam, val, var, rec)
        d = float(res["depth"])
        e = float(res["err"])
        ok = np.isfinite(d)
        if ok and np.isfinite(e):
            e = float(np.hypot(e, SYS_DEPTH_FRAC * (1 - d) * np.sqrt(2)))  # calibration term on band/continuum
        status = "ok" if ok else "insufficient_coverage"
        if ok and (abs(d) > 1 or not np.isfinite(e) or e <= 0 or abs(d) < 3 * e):
            status = "not_significant"
        results.append({"id": rec["id"], "molecule": rec["molecule"], "label_es": rec["label_es"],
                        "label_en": rec["label_en"],
                        "depth": d if ok else None,
                        "err": e if ok and np.isfinite(e) else None,
                        "n_band": int(res["n_band"]), "n_cont": int(res["n_cont"]),
                        "status": status, "sys_frac_assumed": SYS_DEPTH_FRAC})
    return results
