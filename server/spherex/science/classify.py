"""Template classifier: least-squares scale fit, reduced chi2, relative likelihoods.

For each template with k free non-negative amplitudes (k=1 except the asteroid
toy, k=2) we fit the SPHEREx points (band-averaged template, f_nu) and compute
chi2. Fairness: all templates are compared on the SAME set of points (those
inside every template's wavelength coverage). Relative likelihoods use Akaike
weights, exp(-dAIC/2), with chi2 divided by max(1, best reduced chi2) to account
for model inadequacy (standard error-inflation). These are relative preferences
among a small, non-exhaustive template set, NOT calibrated probabilities.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np
from scipy.optimize import nnls

from spherex.science.photometry import fit_points, usable
from spherex.science.templates import Template, band_average, default_templates

METHOD = "template chi2 with scale fit"
MIN_POINTS = 6
# Detection gate: a template "best fit" to noise is meaningless (a flat-zero spectrum with
# large errors gives reduced chi2 ~ 1 for any template). Require real signal first.
GATE_SNR = 3.0
GATE_MIN_POINTS = 6
GATE_MIN_DETECTORS = 3


def detection_gate(points: Sequence[dict]) -> tuple[bool, str]:
    det = [p for p in points if usable(p) and (p.get("snr") or 0) >= GATE_SNR]
    n_det = len({p.get("detector") for p in det})
    ok = len(det) >= GATE_MIN_POINTS and n_det >= GATE_MIN_DETECTORS
    txt = (f"{len(det)} usable point(s) at S/N >= {GATE_SNR:g} on {n_det} detector(s); "
           f"classification needs >= {GATE_MIN_POINTS} on >= {GATE_MIN_DETECTORS} detectors.")
    return ok, txt


def _fit(t: Template, lam, bw, flux, err):
    cols = np.stack([band_average(c, lam, bw) for c in t.components], axis=1)
    A = cols / err[:, None]
    b = flux / err
    if t.n_params == 1:
        num, den = float((A[:, 0] * b).sum()), float((A[:, 0] ** 2).sum())
        amps = np.array([max(num / den, 0.0)]) if den > 0 else np.array([0.0])
    else:
        scale = np.where(np.abs(A).max(axis=0) > 0, np.abs(A).max(axis=0), 1.0)
        amps, _ = nnls(A / scale, b)
        amps = amps / scale
    model = cols @ amps
    chi2 = float((((flux - model) / err) ** 2).sum())
    return chi2, amps, model


def classify(points: Sequence[dict], templates: Sequence[Template] | None = None, *,
             sys_frac: float = 0.03) -> dict:
    """Classify a set of photometry points (V2 /spectrum ``classification`` block)."""
    templates = list(templates) if templates is not None else default_templates()
    caveats = [
        "Relative preference among a small template set; the true class may be absent.",
        "Points from different epochs are combined: variability or motion distorts the spectrum.",
        "Star templates are idealized blackbodies, not stellar atmospheres.",
        "The asteroid model is a toy (reflected 5778 K + thermal blackbody).",
        f"A {sys_frac:.0%} fractional calibration error is added in quadrature (assumed).",
    ]
    n_usable = sum(1 for p in points if usable(p))
    pts = fit_points(points)
    n_excluded = len(points) - n_usable
    if n_excluded:
        caveats.append(f"{n_excluded} point(s) excluded (saturated, artifact-flagged, or not measured).")
    if n_usable - len(pts):
        caveats.append(f"{n_usable - len(pts)} point(s) without EPSF aperture correction excluded "
                       "(aperture flux, not total; would bias the fit).")
    gate_ok, gate_txt = detection_gate(points)
    if not gate_ok:
        return {"best": None, "ranking": [], "method": METHOD, "n_points": len(pts), "detected": False,
                "caveats": caveats + ["Source not significantly detected at this position: " + gate_txt
                                      + " No classification."]}
    if len(pts) < MIN_POINTS:
        return {"best": None, "ranking": [], "method": METHOD, "n_points": len(pts),
                "caveats": caveats + [f"Only {len(pts)} usable points (< {MIN_POINTS}); no classification."]}
    lam = np.array([p["lambda_um"] for p in pts])
    bw = np.array([p.get("bandwidth_um") or 0.0 for p in pts])
    flux = np.array([p["flux"] for p in pts])
    err = np.hypot([p["err"] for p in pts], sys_frac * np.abs(flux))
    # Common point set: inside every template's coverage.
    covered = np.ones(lam.size, bool)
    for t in templates:
        for c in t.components:
            covered &= np.isfinite(band_average(c, lam, bw))
    if covered.sum() < MIN_POINTS:
        return {"best": None, "ranking": [], "method": METHOD, "n_points": int(covered.sum()),
                "caveats": caveats + ["Too few points inside the common template coverage."]}
    if (~covered).any():
        caveats.append(f"{int((~covered).sum())} point(s) outside common template coverage "
                       f"({lam[covered].min():.2f}-{lam[covered].max():.2f} um used).")
    lam, bw, flux, err = lam[covered], bw[covered], flux[covered], err[covered]
    n = lam.size
    fits = []
    for t in templates:
        chi2, amps, _ = _fit(t, lam, bw, flux, err)
        dof = max(1, n - t.n_params)
        fits.append({"t": t, "chi2": chi2, "dof": dof, "chi2_red": chi2 / dof, "amps": amps})
    best_red = min(f["chi2_red"] for f in fits)
    inflate = max(1.0, best_red)
    aic = np.array([f["chi2"] / inflate + 2 * f["t"].n_params for f in fits])
    w = np.exp(-(aic - aic.min()) / 2)
    probs = w / w.sum()
    order = np.argsort(-probs)
    ranking = [{
        "class": fits[i]["t"].cls, "template": fits[i]["t"].id, "label": fits[i]["t"].label,
        "kind": fits[i]["t"].kind, "teff": fits[i]["t"].teff, "spectral_type": fits[i]["t"].spectral_type,
        "prob": float(probs[i]), "chi2": fits[i]["chi2"], "chi2_red": fits[i]["chi2_red"], "n_points": n,
    } for i in order]
    by_class: dict[str, float] = {}
    for r in ranking:
        by_class[r["class"]] = by_class.get(r["class"], 0.0) + r["prob"]
    top = ranking[0]
    if top["chi2_red"] > 10:
        caveats.append(f"Best template still fits poorly (reduced chi2 = {top['chi2_red']:.1f}).")
    return {
        "best": {"class": top["class"], "template": top["template"], "label": top["label"],
                 "teff": top["teff"], "spectral_type": top["spectral_type"], "chi2_red": top["chi2_red"]},
        "ranking": ranking, "by_class": by_class, "method": METHOD, "n_points": n, "detected": True,
        "chi2_inflation": inflate, "weighting": "Akaike weights with chi2 scaled by max(1, best reduced chi2)",
        "caveats": caveats,
    }
