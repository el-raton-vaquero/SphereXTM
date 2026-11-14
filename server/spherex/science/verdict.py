"""Evidence-based verdict: explicit checks -> one of six labels.

Status semantics (shared by every check):
- data-quality checks (saturation, artifacts, detection): pass = clean / measurable,
  warn = some frames affected, fail = the measurement is invalidated;
- identification checks (gaia, skybot, registry): pass = a known counterpart was
  found, warn = none found (unexplained by THIS catalog), na = could not run;
- measurement checks (motion, variability, spectrum): pass = consistent / clear,
  warn = discrepant or ambiguous, na = not enough data.

'candidate' means "detected and not explained by the checked catalogs or flags".
It is NOT a discovery claim. ``confidence`` is a documented heuristic, not a probability.
"""

from __future__ import annotations

from collections.abc import Sequence

from spherex.science.photometry import usable

VERDICTS = ("known_star", "known_asteroid", "artifact", "variable", "candidate", "inconclusive")
DETECTION_SNR = 5.0


def _check(id_, label, status, detail, evidence_source, /, **data):
    return {"id": id_, "label": label, "status": status, "detail": detail,
            "evidence_source": evidence_source, "data": data}


def quality_checks(points: Sequence[dict]) -> tuple[list[dict], dict]:
    measured = [p for p in points if p.get("status") in ("ok", "incomplete", "no_background")]
    n = len(measured)
    sat = [p for p in measured if p.get("saturated")]
    art = [p for p in measured if p.get("artifact_flags")]
    det = [p for p in points if usable(p) and (p.get("snr") or 0) >= DETECTION_SNR]
    names: dict[str, int] = {}
    for p in art:
        for a in p["artifact_flags"]:
            names[a] = names.get(a, 0) + 1
    src = "SPHEREx L2 FLAGS (MSKN header definitions) at the aperture"
    stats = {"n_frames": n, "n_saturated": len(sat), "n_artifact": len(art), "n_detected": len(det),
             "sat_frac": len(sat) / n if n else 0.0, "art_frac": len(art) / n if n else 0.0}
    if n == 0:
        return [_check("saturation", "Saturation (OVERFLOW/NONLINEAR/BLOOM)", "na", "No frame covers the position.", src),
                _check("artifacts", "Ghosts, crosstalk, persistence, transients", "na", "No frame covers the position.", src),
                _check("detection", "Detection (S/N >= 5)", "na", "No frame covers the position.", "Forced aperture photometry")], stats
    sf, af = stats["sat_frac"], stats["art_frac"]
    checks = [
        _check("saturation", "Saturation (OVERFLOW/NONLINEAR/BLOOM)",
               "fail" if sf >= 0.5 else "warn" if sat else "pass",
               f"{len(sat)}/{n} frames saturated at the aperture" + (
                   "; photometry and centroids there are unreliable." if sat else "."), src,
               n_saturated=len(sat), n_frames=n),
        _check("artifacts", "Ghosts, crosstalk, persistence, transients",
               "fail" if af >= 0.5 else "warn" if art else "pass",
               (f"{len(art)}/{n} frames carry artifact flags: " + ", ".join(f"{k}x{v}" for k, v in sorted(names.items())))
               if art else f"No artifact flags in {n} frames.", src, counts=names),
        _check("detection", "Detection (S/N >= 5)",
               "pass" if len(det) >= 3 else "warn" if det else "fail",
               f"Detected at S/N >= {DETECTION_SNR:g} in {len(det)} clean frames of {n}.",
               "Forced aperture photometry with VARIANCE errors", n_detected=len(det)),
    ]
    return checks, stats


def gaia_check(match: dict | None, error: str | None, radius_arcsec: float) -> dict:
    src = "Gaia DR3 (propagated with PM + parallax to the frame epoch)"
    if error:
        return _check("gaia", "Gaia DR3 counterpart", "na", f"Gaia query failed: {error}", src)
    if match is None:
        return _check("gaia", "Gaia DR3 counterpart", "warn",
                      f"No Gaia DR3 source within {radius_arcsec:.1f} arcsec of the predicted positions. "
                      "Gaia misses very red/faint objects (e.g. Y dwarfs).", src)
    s = match["source"]
    g = s.get("phot_g_mean_mag")
    return _check("gaia", "Gaia DR3 counterpart", "pass",
                  f"Gaia DR3 {s['source_id']} (G = {g:.2f} mag) at {match['separation_arcsec']:.2f} arcsec "
                  f"of its predicted position (prediction, not detection)." if g is not None else
                  f"Gaia DR3 {s['source_id']} at {match['separation_arcsec']:.2f} arcsec (predicted).",
                  src, source_id=s["source_id"], separation_arcsec=match["separation_arcsec"],
                  pmra=s.get("pmra"), pmdec=s.get("pmdec"), parallax=s.get("parallax"))


def skybot_check(result: dict | None, radius_arcsec: float) -> tuple[dict, dict | None]:
    src = "IMCCE SkyBoT cone search (geocentric ephemerides)"
    if result is None:
        return _check("skybot", "Known solar-system object", "na", "SkyBoT not queried.", src), None
    epochs = result.get("epochs", [])
    ok = [e for e in epochs if not e.get("error")]
    if not ok:
        errs = "; ".join(sorted({e.get("error", "")[:80] for e in epochs})) or "no epochs"
        return _check("skybot", "Known solar-system object", "na", f"SkyBoT failed: {errs}", src), None
    hits = []
    for e in ok:
        for o in e["objects"]:
            if o.get("separation_arcsec") is not None and o["separation_arcsec"] <= radius_arcsec:
                hits.append({"mjd": e["mjd"], **o})
    failed = len(epochs) - len(ok)
    tail = f" ({failed} epoch queries failed)" if failed else ""
    if hits:
        h = min(hits, key=lambda o: o["separation_arcsec"])
        return _check("skybot", "Known solar-system object", "pass",
                      f"{h['name']} ({h['class']}, V={h['vmag']}) predicted {h['separation_arcsec']:.1f} arcsec "
                      f"from the position at MJD {h['mjd']:.3f}{tail}.", src, hits=hits[:20]), h
    return _check("skybot", "Known solar-system object", "warn",
                  f"No known SSO within {radius_arcsec:.0f} arcsec at {len(ok)} queried epochs{tail}.",
                  src, n_epochs=len(ok)), None


def registry_check(match: dict | None) -> dict | None:
    if match is None:
        return None
    return _check("registry", "Literature target registry", "pass",
                  f"Matches {match['name']} ({match.get('reference', 'registry')}) at "
                  f"{match['separation_arcsec']:.1f} arcsec of its predicted position.",
                  "PRISM target registry (literature astrometry)", **match)


def motion_check(result: dict | None) -> dict:
    src = "Season centroids (pixel-integrated Gaussian fit) vs Gaia prediction"
    if not result or result.get("status") != "ok":
        reason = (result or {}).get("reason", "not computed")
        return _check("motion", "Measured vs predicted motion", "na", reason, src)
    m = result["measured"]
    txt = (f"Measured {m['total_arcsec']:.2f} arcsec ({m['total_pixels']:.2f} px) between seasons "
           f"{result['season_a']} and {result['season_b']} (sigma {m['err_ra_arcsec']:.2f}/{m['err_dec_arcsec']:.2f} arcsec).")
    if result.get("predicted"):
        p = result["predicted"]
        txt += f" Predicted {p['total_arcsec']:.2f} arcsec."
        status = "pass" if result["consistent_with_prediction"] else "warn"
        txt += " Consistent within 3 sigma." if status == "pass" else " Discrepant at > 3 sigma."
    else:
        status = "warn" if result["significant_motion"] else "pass"
        txt += " Significant motion with no catalog prediction." if status == "warn" else " No significant motion."
    return _check("motion", "Measured vs predicted motion", status, txt, src, **result)


def variability_check(result: dict | None) -> dict:
    src = "Season-to-season photometry at matched wavelengths"
    if not result or result.get("status") != "ok":
        return _check("variability", "Variability between seasons", "na",
                      (result or {}).get("reason", "not computed"), src)
    amp = result.get("amplitude_fraction")
    amp_txt = f", amplitude ~{amp:.0%}" if amp is not None else ""
    if result["variable"]:
        return _check("variability", "Variability between seasons", "warn",
                      f"Flux changes between seasons (p_constant = {result['p_constant']:.1e}{amp_txt}).", src, **result)
    return _check("variability", "Variability between seasons", "pass",
                  f"Consistent with constant flux (p = {result['p_constant']:.2g}{amp_txt}).", src, **result)


def spectrum_check(result: dict | None) -> dict:
    src = "Template chi2 fit (Beiler+2024 JWST brown dwarfs, blackbodies, asteroid toy)"
    if not result or not result.get("best"):
        why = "; ".join((result or {}).get("caveats", [])[-1:]) or "not computed"
        return _check("spectrum", "Spectral class", "na", why, src)
    b = result["best"]
    p = result["ranking"][0]["prob"]
    clear = p >= 0.6 and b["chi2_red"] <= 5
    return _check("spectrum", "Spectral class", "pass" if clear else "warn",
                  f"Best: {b['label']} (relative weight {p:.0%}, reduced chi2 {b['chi2_red']:.1f}).", src,
                  best=b, by_class=result.get("by_class"))


def evaluate(*, points: Sequence[dict], gaia_match: dict | None = None, gaia_error: str | None = None,
             skybot: dict | None = None, motion: dict | None = None, variability: dict | None = None,
             classification: dict | None = None, registry_match: dict | None = None,
             match_radius_arcsec: float = 9.0, skybot_radius_arcsec: float = 12.3) -> dict:
    """Combine evidence into the V2 /verdict payload."""
    checks, q = quality_checks(points)
    checks.append(gaia_check(gaia_match, gaia_error, match_radius_arcsec))
    sb_check, sb_hit = skybot_check(skybot, skybot_radius_arcsec)
    checks.append(sb_check)
    reg = registry_check(registry_match)
    if reg:
        checks.append(reg)
    checks += [motion_check(motion), variability_check(variability), spectrum_check(classification)]

    detected = q["n_detected"] > 0
    is_variable = bool(variability and variability.get("status") == "ok" and variability.get("variable"))
    known = gaia_match is not None or registry_match is not None
    motion_bad = bool(motion and motion.get("consistent_with_prediction") is False)

    if q["n_frames"] == 0:
        verdict, conf = "inconclusive", 0.1
    elif sb_hit is not None and (not known or q["n_detected"] <= 2):
        verdict, conf = "known_asteroid", 0.75 if sb_hit["separation_arcsec"] <= match_radius_arcsec else 0.55
    elif known:
        sep = (gaia_match or registry_match)["separation_arcsec"]
        verdict = "variable" if is_variable else "known_star"
        conf = 0.9 if sep <= match_radius_arcsec / 2 else 0.75
        if q["sat_frac"] >= 0.5:
            conf -= 0.15
        if motion_bad:
            conf -= 0.2
    elif q["art_frac"] >= 0.5 or (detected and all(p.get("artifact_flags") for p in points if p.get("status") == "ok")):
        verdict, conf = "artifact", 0.6 + 0.3 * q["art_frac"]
    elif is_variable:
        verdict, conf = "variable", 0.5
    elif detected:
        verdict, conf = "candidate", 0.35 if q["n_detected"] >= 3 else 0.2
    else:
        verdict, conf = "inconclusive", 0.2
    conf = float(min(1.0, max(0.0, conf)))
    summary, summary_es = _summary(verdict, checks, gaia_match, registry_match, sb_hit, q)
    return {"checks": checks, "verdict": verdict, "confidence": conf, "summary": summary,
            "summary_es": summary_es, "stats": q,
            "confidence_method": "heuristic from check outcomes (see spherex/science/verdict.py), not a probability"}


def _summary(verdict, checks, gaia_match, registry_match, sb_hit, q):
    sat = f" Saturated in {q['n_saturated']}/{q['n_frames']} frames." if q["n_saturated"] else ""
    if verdict == "known_asteroid":
        return (f"A known solar-system object ({sb_hit['name']}) is predicted here at MJD {sb_hit['mjd']:.3f}.",
                f"Un objeto conocido del Sistema Solar ({sb_hit['name']}) pasa por aquí según efemérides (MJD {sb_hit['mjd']:.3f}).")
    if verdict in ("known_star", "variable") and (gaia_match or registry_match):
        name = (f"Gaia DR3 {gaia_match['source']['source_id']}" if gaia_match else registry_match["name"])
        if verdict == "variable":
            return (f"Known source ({name}) with flux changes between seasons.{sat}",
                    f"Fuente conocida ({name}) con cambios de flujo entre temporadas.{sat}")
        return (f"Consistent with a known source ({name}).{sat}",
                f"Compatible con una fuente conocida ({name}).{sat}")
    if verdict == "artifact":
        return ("Signal dominated by flagged instrumental artifacts (ghost/crosstalk/persistence/transient).",
                "Señal dominada por artefactos instrumentales marcados (fantasma/crosstalk/persistencia/transitorio).")
    if verdict == "variable":
        return ("Flux changes between seasons; no catalog counterpart found.",
                "El flujo cambia entre temporadas; sin contrapartida en catálogos.")
    if verdict == "candidate":
        return ("Detected source not explained by Gaia DR3, SkyBoT or quality flags. Needs follow-up; not a discovery claim.",
                "Fuente detectada que no explican Gaia DR3, SkyBoT ni las marcas de calidad. Requiere seguimiento; no es un descubrimiento.")
    return ("Not enough clean evidence to decide.", "No hay evidencia limpia suficiente para decidir.")
