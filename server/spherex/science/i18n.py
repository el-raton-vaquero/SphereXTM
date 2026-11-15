"""English/Spanish rendering of the human-readable sentences in /v2/verdict and /v2/spectrum.

The science code writes its check details, caveats and methods in English from a finite set
of templates (``verdict.py``, ``classify.py``, ``centroid.py``, ``variability.py``). This module
maps each template to Spanish with ordered regular expressions, so it also localizes cached
payloads and saved snapshots that were produced before language support existed.

``localize_verdict`` / ``localize_spectrum`` never mutate their input (providers memoise their
results). They keep the response shape and only ADD fields:

- every check gets ``label_en``/``label_es``, ``detail_en``/``detail_es`` and
  ``evidence_source_en``/``evidence_source_es``; ``label``/``detail``/``evidence_source`` carry
  the requested language;
- the verdict gets ``summary_en`` (``summary_es`` already existed) and ``summary`` in the
  requested language, plus ``lang``;
- spectrum classification gets ``caveats_en``/``caveats_es`` and ``method_en``/``method_es``.

A sentence with no known template (for example an upstream error message) stays in English:
its ``*_en`` field is set and its ``*_es`` field is omitted, so clients can tell it is untranslated.
"""

from __future__ import annotations

import re
from collections.abc import Callable

LANGS = ("en", "es")
DEFAULT_LANG = "en"

CHECK_LABELS_ES = {
    "saturation": "Saturación (OVERFLOW/NONLINEAR/BLOOM)",
    "artifacts": "Fantasmas, diafonía, persistencia, transitorios",
    "detection": "Detección (S/N ≥ 5)",
    "gaia": "Contrapartida en Gaia DR3",
    "confusion": "Mezcla con vecinas conocidas",
    "skybot": "Objeto conocido del sistema solar",
    "registry": "Registro de objetivos de la literatura",
    "motion": "Movimiento medido vs. predicho",
    "variability": "Variabilidad entre temporadas",
    "spectrum": "Clase espectral",
}

# Fixed sentences (evidence sources, methods, fixed caveats).
FIXED_ES = {
    "SPHEREx L2 FLAGS (MSKN header definitions) at the aperture":
        "FLAGS de SPHEREx L2 (definiciones de la cabecera MSKN) en la apertura",
    "Forced aperture photometry": "Fotometría forzada de apertura",
    "Forced aperture photometry with VARIANCE errors": "Fotometría forzada de apertura con errores de VARIANCE",
    "Gaia DR3 (propagated with PM + parallax to the frame epoch)":
        "Gaia DR3 (propagada con movimiento propio y paralaje a la época del cuadro)",
    "Gaia DR3 neighbours (propagated) within the blend radius":
        "Vecinas de Gaia DR3 (propagadas) dentro del radio de mezcla",
    "IMCCE SkyBoT cone search (geocentric ephemerides)": "Búsqueda cónica de IMCCE SkyBoT (efemérides geocéntricas)",
    "PRISM target registry (literature astrometry)": "Registro de objetivos de Listar (astrometría de la literatura)",
    "Listar target registry (literature astrometry)": "Registro de objetivos de Listar (astrometría de la literatura)",
    "Season centroids (pixel-integrated Gaussian fit) vs Gaia prediction":
        "Centroides por temporada (ajuste gaussiano integrado en píxel) vs. predicción de Gaia",
    "Season-to-season photometry at matched wavelengths":
        "Fotometría entre temporadas a longitudes de onda emparejadas",
    "Template chi2 fit (Beiler+2024 JWST brown dwarfs, blackbodies, asteroid toy)":
        "Ajuste chi² a plantillas (enanas marrones JWST de Beiler+2024, cuerpos negros, modelo simple de asteroide)",
    "No frame covers the position.": "Ningún cuadro cubre la posición.",
    "Not evaluated.": "No evaluado.",
    "SkyBoT not queried.": "SkyBoT no consultado.",
    "not computed": "no calculado",
    "template chi2 with scale fit": "chi² a plantillas con ajuste de escala",
    "Relative preference among a small template set; the true class may be absent.":
        "Preferencia relativa entre un conjunto pequeño de plantillas; la clase real puede no estar entre ellas.",
    "Points from different epochs are combined: variability or motion distorts the spectrum.":
        "Se combinan puntos de distintas épocas: la variabilidad o el movimiento distorsionan el espectro.",
    "Star templates are idealized blackbodies, not stellar atmospheres.":
        "Las plantillas estelares son cuerpos negros idealizados, no atmósferas estelares.",
    "The asteroid model is a toy (reflected 5778 K + thermal blackbody).":
        "El modelo de asteroide es simplificado (luz reflejada a 5778 K + cuerpo negro térmico).",
    "Too few points inside the common template coverage.":
        "Muy pocos puntos dentro de la cobertura común de las plantillas.",
    "forced circular aperture, sigma-clipped median annulus background, VARIANCE errors, EPSF aperture "
    "correction; forced PSF fit with Gaia neighbours at fixed positions when blended (flux_method per point)":
        "apertura circular forzada, fondo por mediana con recorte sigma en un anillo, errores de VARIANCE, "
        "corrección de apertura con EPSF; ajuste PSF forzado con vecinas de Gaia en posiciones fijas cuando "
        "hay mezcla (flux_method por punto)",
    # Snapshot-only spectrum caveats (frontend/scripts/prism_snapshot.py).
    "Each frame samples ONE wavelength at this position (linear variable filter).":
        "Cada cuadro mide UNA longitud de onda en esta posición (filtro lineal variable).",
    "No aperture/PSF correction: fluxes are aperture-limited, not total.":
        "Sin corrección de apertura/PSF: los flujos están limitados por la apertura, no son totales.",
    "Saturated (OVERFLOW) points are not reliable fluxes.": "Los puntos saturados (OVERFLOW) no son flujos fiables.",
    "Template classification is not computed in cached snapshots.":
        "La clasificación por plantillas no se calcula en las instantáneas guardadas.",
}


# English sentences renamed since older payloads/snapshots were produced (project renamed
# PRISM -> Listar). Applied to the English output only.
EN_RENAMES = {
    "PRISM target registry (literature astrometry)": "Listar target registry (literature astrometry)",
}


def _en(text: str) -> str:
    return EN_RENAMES.get(text, text)


def _epoch_tail(m: re.Match, group: int) -> str:
    n = m.group(group)
    return f" ({n} consultas de época fallaron)" if n else ""


def _amp(m: re.Match, group: int) -> str:
    a = m.group(group)
    return f", amplitud ~{a}" if a else ""


_MOTION_TAILS = (
    (re.compile(r" Predicted ([\d.]+) arcsec\."), lambda m: f" Predicho: {m.group(1)} arcsec."),
    (re.compile(r" Consistent within 3 sigma\."), lambda m: " Compatible dentro de 3 sigma."),
    (re.compile(r" Discrepant at > 3 sigma\."), lambda m: " Discrepante a más de 3 sigma."),
    (re.compile(r" Significant motion with no catalog prediction\."), lambda m: " Movimiento significativo sin predicción de catálogo."),
    (re.compile(r" No significant motion\."), lambda m: " Sin movimiento significativo."),
)


def _motion(m: re.Match) -> str | None:
    head = (f"Medido {m.group(1)} arcsec ({m.group(2)} px) entre las temporadas {m.group(3)} y {m.group(4)} "
            f"(sigma {m.group(5)}/{m.group(6)} arcsec).")
    tail = m.group(7)
    out = []
    while tail:
        for rx, fn in _MOTION_TAILS:
            mm = rx.match(tail)
            if mm:
                out.append(fn(mm))
                tail = tail[mm.end():]
                break
        else:
            return None  # unknown tail: leave the sentence untranslated
    return head + "".join(out)


_Rule = tuple[re.Pattern, Callable[[re.Match], "str | None"]]
_RULES: list[_Rule] = [(re.compile(p), f) for p, f in (
    (r"^(\d+)/(\d+) frames saturated at the aperture; photometry and centroids there are unreliable\.$",
     lambda m: f"{m.group(1)}/{m.group(2)} cuadros saturados en la apertura; ahí la fotometría y los centroides no son fiables."),
    (r"^(\d+)/(\d+) frames saturated at the aperture\.$",
     lambda m: f"{m.group(1)}/{m.group(2)} cuadros saturados en la apertura."),
    (r"^(\d+)/(\d+) frames carry artifact flags: (.*)$",
     lambda m: f"{m.group(1)}/{m.group(2)} cuadros tienen marcas de artefacto: {m.group(3)}"),
    (r"^No artifact flags in (\d+) frames\.$", lambda m: f"Sin marcas de artefacto en {m.group(1)} cuadros."),
    (r"^Detected at S/N >= ([\d.]+) in (\d+) clean frames of (\d+)\.$",
     lambda m: f"Detectada con S/N ≥ {m.group(1)} en {m.group(2)} cuadros limpios de {m.group(3)}."),
    (r"^Gaia query failed: (.*)$", lambda m: f"Falló la consulta a Gaia: {m.group(1)}"),
    (r"^No Gaia DR3 source within ([\d.]+) arcsec of the predicted positions\. Gaia misses very red/faint objects "
     r"\(e\.g\. Y dwarfs\)\.$",
     lambda m: (f"Ninguna fuente de Gaia DR3 a menos de {m.group(1)} arcsec de las posiciones predichas. Gaia no ve "
                "objetos muy rojos o débiles (p. ej., enanas Y).")),
    (r"^Gaia DR3 (\S+)( \(G = [\d.]+ mag\))?: predicted position ([\d.]+) arcsec from the query position "
     r"\(prediction, not detection\)\.$",
     lambda m: (f"Gaia DR3 {m.group(1)}{m.group(2) or ''}: posición predicha a {m.group(3)} arcsec de la posición "
                "consultada (predicción, no detección).")),
    (r"^No other Gaia DR3 source within ([\d.]+) arcsec\.$",
     lambda m: f"Ninguna otra fuente de Gaia DR3 a menos de {m.group(1)} arcsec."),
    (r"^(\d+) Gaia neighbour\(s\) within ([\d.]+) arcsec: (.*)\. Photometry deblends them with a forced PSF fit and "
     r"centroids fit them at fixed \(predicted\) positions; residual contamination is possible\.$",
     lambda m: (f"{m.group(1)} vecina(s) de Gaia a menos de {m.group(2)} arcsec: "
                f"{re.sub(r' at ([0-9.]+) arcsec', r' a \1 arcsec', m.group(3))}. La fotometría las separa con un "
                "ajuste PSF forzado y los centroides las ajustan en posiciones fijas (predichas); puede quedar "
                "contaminación residual.")),
    (r"^SkyBoT failed: (.*)$", lambda m: f"SkyBoT falló: {m.group(1)}"),
    (r"^No known SSO within (\d+) arcsec at (\d+) queried epochs( \((\d+) epoch queries failed\))?\.$",
     lambda m: (f"Ningún objeto conocido del sistema solar a menos de {m.group(1)} arcsec en {m.group(2)} épocas "
                f"consultadas{_epoch_tail(m, 4)}.")),
    (r"^(.+) \((.+), V=(.+)\) predicted ([\d.]+) arcsec from the position at MJD ([\d.]+)"
     r"( \((\d+) epoch queries failed\))?\.$",
     lambda m: (f"{m.group(1)} ({m.group(2)}, V={m.group(3)}) predicho a {m.group(4)} arcsec de la posición en "
                f"MJD {m.group(5)}{_epoch_tail(m, 7)}.")),
    (r"^Matches (.+) \((.+)\) at ([\d.]+) arcsec of its predicted position\.$",
     lambda m: f"Coincide con {m.group(1)} ({m.group(2)}) a {m.group(3)} arcsec de su posición predicha."),
    (r"^Measured ([\d.]+) arcsec \(([\d.]+) px\) between seasons (\S+) and (\S+) \(sigma ([\d.]+)/([\d.]+) arcsec\)\.(.*)$",
     _motion),
    (r"^(\d+) season\(s\) with usable centroids; need 2$",
     lambda m: f"{m.group(1)} temporada(s) con centroides utilizables; se necesitan 2"),
    (r"^(\d+) season\(s\) with usable photometry; need 2$",
     lambda m: f"{m.group(1)} temporada(s) con fotometría utilizable; se necesitan 2"),
    (r"^fewer than (\d+) wavelength-matched pairs between seasons$",
     lambda m: f"menos de {m.group(1)} pares emparejados en longitud de onda entre temporadas"),
    (r"^Flux changes between seasons \(p_constant = ([^,)]+)(, amplitude ~(\d+%))?\)\.$",
     lambda m: f"El flujo cambia entre temporadas (p_constante = {m.group(1)}{_amp(m, 3)})."),
    (r"^Consistent with constant flux \(p = ([^,)]+)(, amplitude ~(\d+%))?\)\.$",
     lambda m: f"Compatible con flujo constante (p = {m.group(1)}{_amp(m, 3)})."),
    (r"^Best: (.+) \(relative weight (\d+%), reduced chi2 ([\d.]+)\)\.$",
     lambda m: f"Mejor ajuste: {m.group(1)} (peso relativo {m.group(2)}, chi² reducido {m.group(3)})."),
    (r"^A (\d+%) fractional calibration error is added in quadrature \(assumed\)\.$",
     lambda m: f"Se suma en cuadratura un error de calibración fraccional del {m.group(1)} (supuesto)."),
    (r"^(\d+) point\(s\) excluded \(saturated, artifact-flagged, or not measured\)\.$",
     lambda m: f"{m.group(1)} punto(s) excluido(s) (saturados, con marcas de artefacto o sin medir)."),
    (r"^(\d+) point\(s\) without EPSF aperture correction excluded \(aperture flux, not total; would bias the fit\)\.$",
     lambda m: (f"{m.group(1)} punto(s) sin corrección de apertura EPSF excluido(s) (flujo de apertura, no total; "
                "sesgaría el ajuste).")),
    (r"^Source not significantly detected at this position: (\d+) usable point\(s\) at S/N >= ([\d.]+) on (\d+) "
     r"detector\(s\); classification needs >= (\d+) on >= (\d+) detectors\. No classification\.$",
     lambda m: (f"La fuente no se detecta de forma significativa en esta posición: {m.group(1)} punto(s) utilizable(s) "
                f"con S/N ≥ {m.group(2)} en {m.group(3)} detector(es); la clasificación necesita ≥ {m.group(4)} en "
                f"≥ {m.group(5)} detectores. Sin clasificación.")),
    (r"^Only (\d+) usable points \(< (\d+)\); no classification\.$",
     lambda m: f"Solo {m.group(1)} puntos utilizables (< {m.group(2)}); sin clasificación."),
    (r"^(\d+) point\(s\) outside common template coverage \(([\d.]+)-([\d.]+) um used\)\.$",
     lambda m: (f"{m.group(1)} punto(s) fuera de la cobertura común de las plantillas (se usan "
                f"{m.group(2)}-{m.group(3)} µm).")),
    (r"^Best template still fits poorly \(reduced chi2 = ([\d.]+)\)\.$",
     lambda m: f"La mejor plantilla aún ajusta mal (chi² reducido = {m.group(1)})."),
)]


def translate_es(text: str | None) -> str | None:
    """Spanish version of one English sentence from the science templates, or None if unknown."""
    if not isinstance(text, str) or not text:
        return None
    if text in FIXED_ES:
        return FIXED_ES[text]
    for rx, fn in _RULES:
        m = rx.match(text)
        if m:
            return fn(m)
    # A detail made of several known sentences joined by "; " (e.g. the spectrum check).
    if "; " in text:
        parts = [translate_es(p) for p in text.split("; ")]
        if all(parts):
            return "; ".join(parts)  # type: ignore[arg-type]
    return None


def normalize_lang(lang: str | None) -> str:
    return lang if lang in LANGS else DEFAULT_LANG


def _localize_check(check: dict, lang: str) -> dict:
    c = dict(check)
    label_en = check.get("label_en") or check.get("label") or ""
    detail_en = check.get("detail_en") or check.get("detail") or ""
    src_en = _en(check.get("evidence_source_en") or check.get("evidence_source") or "")
    c["label_en"], c["detail_en"], c["evidence_source_en"] = label_en, detail_en, src_en
    label_es = CHECK_LABELS_ES.get(check.get("id", "")) or translate_es(label_en)
    detail_es = check.get("detail_es") or translate_es(detail_en)
    src_es = check.get("evidence_source_es") or translate_es(src_en)
    for key, val in (("label_es", label_es), ("detail_es", detail_es), ("evidence_source_es", src_es)):
        if val:
            c[key] = val
    if lang == "es":
        c["label"] = label_es or label_en
        c["detail"] = detail_es or detail_en
        c["evidence_source"] = src_es or src_en
    else:
        c["label"], c["detail"], c["evidence_source"] = label_en, detail_en, src_en
    return c


def localize_verdict(payload: dict, lang: str | None = DEFAULT_LANG) -> dict:
    """Copy of a /v2/verdict payload with sentences in ``lang`` and both-language fields added."""
    if not isinstance(payload, dict) or "checks" not in payload:
        return payload
    lang = normalize_lang(lang)
    out = dict(payload)
    out["checks"] = [_localize_check(c, lang) for c in payload.get("checks") or [] if isinstance(c, dict)]
    summary_en = payload.get("summary_en") or payload.get("summary") or ""
    summary_es = payload.get("summary_es") or translate_es(summary_en)
    out["summary_en"] = summary_en
    if summary_es:
        out["summary_es"] = summary_es
    out["summary"] = (summary_es or summary_en) if lang == "es" else summary_en
    out["lang"] = lang
    return out


def _localize_list(items: list | None) -> tuple[list[str], list[str] | None]:
    en = [str(x) for x in (items or [])]
    es = [translate_es(x) for x in en]
    return en, ([e for e in es if e] if all(es) else None)


def _localize_block(block: dict, lang: str) -> dict:
    b = dict(block)
    if isinstance(block.get("caveats"), list):
        en, es = _localize_list(block.get("caveats_en") or block["caveats"])
        b["caveats_en"] = en
        if es is not None:
            b["caveats_es"] = es
        b["caveats"] = es if (lang == "es" and es is not None) else en
    if isinstance(block.get("method"), str):
        m_en = block.get("method_en") or block["method"]
        m_es = translate_es(m_en)
        b["method_en"] = m_en
        if m_es:
            b["method_es"] = m_es
        b["method"] = m_es if (lang == "es" and m_es) else m_en
    return b


def localize_spectrum(payload: dict, lang: str | None = DEFAULT_LANG) -> dict:
    """Copy of a /v2/spectrum payload with caveats/methods in ``lang`` (both languages kept)."""
    if not isinstance(payload, dict):
        return payload
    lang = normalize_lang(lang)
    out = _localize_block(payload, lang)
    if isinstance(payload.get("classification"), dict):
        out["classification"] = _localize_block(payload["classification"], lang)
    if isinstance(payload.get("provenance"), dict):
        out["provenance"] = _localize_block(payload["provenance"], lang)
    out["lang"] = lang
    return out
