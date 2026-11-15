"""StarChord v2 API router (mounted by ``spherex.api``; Next.js proxies ``/api/v2/*`` here).

Implemented here: ``/v2/targets``, ``/v2/search`` and ``/v2/search/stream`` (SSE).

``/v2/gaia``, ``/v2/skybot``, ``/v2/spectrum`` and ``/v2/verdict`` dispatch to pure
functions registered with :func:`register_provider` (owned by other workstreams).
Until a provider is registered they answer HTTP 501 ``not_implemented`` — never a
placeholder or synthetic result. A module ``spherex.v2_providers`` (if present) is
imported at startup so that it can register its functions.

Provider call signatures (keyword arguments; return a JSON-serialisable dict, raise
``spherex.live.LiveError`` for transparent failures):

- ``gaia(ra, dec, radius_arcmin, mjd: list[float])``
- ``skybot(ra, dec, radius_arcmin, mjd: float)``
- ``spectrum(ra, dec, aperture_arcsec)``
- ``verdict(ra, dec, fov)``

``/v2/spectrum`` and ``/v2/verdict`` accept ``lang=en|es`` (default ``en``) for their
human-readable sentences; see :mod:`spherex.science.i18n`.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import queue
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Callable

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from spherex import live, targets_v2
from spherex.archive import COLLECTIONS
from spherex.science.i18n import localize_spectrum, localize_verdict

router = APIRouter(prefix="/v2", tags=["prism-v2"])

PROVIDER_NAMES = ("gaia", "skybot", "spectrum", "verdict")
PROVIDERS: dict[str, Callable[..., dict]] = {}


def register_provider(name: str, fn: Callable[..., dict]) -> None:
    if name not in PROVIDER_NAMES:
        raise ValueError(f"Unknown provider {name!r}; expected one of {PROVIDER_NAMES}")
    PROVIDERS[name] = fn


def _autodiscover() -> None:
    try:
        importlib.import_module("spherex.v2_providers")
    except ModuleNotFoundError as exc:
        if exc.name != "spherex.v2_providers":
            raise


_autodiscover()


def _error(exc: live.LiveError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content=exc.to_dict())


def _not_implemented(name: str) -> JSONResponse:
    return JSONResponse(status_code=501, content={
        "detail": f"/v2/{name} is not available in this build (no provider registered). "
                  "No placeholder data is returned.",
        "error_type": "not_implemented"})


def parse_collections(value: str) -> tuple[str, ...]:
    items = tuple(dict.fromkeys(c.strip() for c in value.split(",") if c.strip()))
    if not items:
        raise live.LiveError(422, "invalid_collections", "collections must not be empty")
    bad = [c for c in items if c not in COLLECTIONS]
    if bad:
        raise live.LiveError(422, "unsupported_collection",
                             f"Unsupported collections {bad}; allowed: {list(COLLECTIONS)}")
    return items


def parse_mjd_list(value: str) -> list[float]:
    try:
        mjds = [float(v) for v in value.split(",") if v.strip()]
    except ValueError as exc:
        raise live.LiveError(422, "invalid_mjd", "mjd must be a comma-separated list of numbers") from exc
    if not mjds or len(mjds) > 400 or not all(40000 < m < 80000 for m in mjds):
        raise live.LiveError(422, "invalid_mjd", "mjd list must have 1..400 values in (40000, 80000)")
    return mjds


# --------------------------------------------------------------------------- targets
@router.get("/targets")
def get_targets():
    try:
        return targets_v2.public_targets()
    except (OSError, ValueError) as exc:
        return JSONResponse(status_code=503, content={
            "detail": f"Target registry unavailable: {exc}", "error_type": "registry_unavailable"})


# --------------------------------------------------------------------------- search
_COMMON = dict(
    ra=Query(..., ge=0.0, lt=360.0, description="ICRS right ascension, degrees"),
    dec=Query(..., ge=-90.0, le=90.0, description="ICRS declination, degrees"),
)


# One live.search per (position, fov, frames, collections) at a time: the plain /search
# fallback (or a second tab) joins the download already running instead of doubling it.
_INFLIGHT: dict[tuple, Future] = {}
_INFLIGHT_LOCK = threading.Lock()


def shared_search(ra, dec, fov, max_frames, cols, progress=None) -> dict:
    key = (round(ra, 6), round(dec, 6), round(float(fov), 3), int(max_frames), tuple(cols))
    with _INFLIGHT_LOCK:
        fut = _INFLIGHT.get(key)
        owner = fut is None
        if owner:
            fut = Future()
            _INFLIGHT[key] = fut
    if not owner:
        if progress:
            progress({"stage": "query", "message": "joining a search already in progress"})
        return fut.result()
    try:
        result = live.search(ra, dec, fov, max_frames, cols, progress=progress)
        fut.set_result(result)
        return result
    except BaseException as exc:
        fut.set_exception(exc)
        raise
    finally:
        with _INFLIGHT_LOCK:
            _INFLIGHT.pop(key, None)


@router.get("/search")
def get_search(
    ra: float = _COMMON["ra"],
    dec: float = _COMMON["dec"],
    fov: float = Query(live.FOV_DEFAULT, ge=live.FOV_MIN, le=live.FOV_MAX, description="arcmin"),
    max_frames: int = Query(live.MAX_FRAMES_DEFAULT, ge=1, le=live.MAX_FRAMES_LIMIT),
    collections: str = Query(",".join(COLLECTIONS)),
):
    try:
        return shared_search(ra, dec, fov, max_frames, parse_collections(collections))
    except live.LiveError as exc:
        return _error(exc)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, allow_nan=False)}\n\n"


@router.get("/search/stream")
def get_search_stream(
    ra: float = _COMMON["ra"],
    dec: float = _COMMON["dec"],
    fov: float = Query(live.FOV_DEFAULT, ge=live.FOV_MIN, le=live.FOV_MAX),
    max_frames: int = Query(live.MAX_FRAMES_DEFAULT, ge=1, le=live.MAX_FRAMES_LIMIT),
    collections: str = Query(",".join(COLLECTIONS)),
):
    """Server-sent events: ``progress`` (stage/done/total), then ``result`` or ``error``."""
    try:
        cols = parse_collections(collections)
    except live.LiveError as exc:
        return _error(exc)
    events: queue.Queue = queue.Queue()

    def worker():
        try:
            result = shared_search(ra, dec, fov, max_frames, cols, progress=lambda e: events.put(("progress", e)))
            events.put(("result", result))
        except live.LiveError as exc:
            events.put(("error", {"status_code": exc.status_code, **exc.to_dict()}))
        except Exception as exc:  # noqa: BLE001 - surfaced, never replaced by fake data
            events.put(("error", {"status_code": 500, "error_type": "internal_error",
                                  "detail": f"{type(exc).__name__}: {exc}"}))
        finally:
            events.put(None)

    threading.Thread(target=worker, daemon=True).start()

    def stream():
        # A named event right away: comments do not reset the browser's silence timer.
        yield _sse("progress", {"stage": "query", "message": "SIA2 query started"})
        while True:
            try:
                item = events.get(timeout=15)
            except queue.Empty:
                yield ": keep-alive\n\n"
                continue
            if item is None:
                return
            yield _sse(*item)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             # no-transform: proxies (incl. Next's rewrite) must not gzip/buffer SSE.
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no",
                                      "Content-Encoding": "identity"})


# --------------------------------------------------------------------------- providers
def _call(name: str, **kwargs):
    fn = PROVIDERS.get(name)
    if fn is None:
        return _not_implemented(name)
    try:
        return fn(**kwargs)
    except live.LiveError as exc:
        return _error(exc)


# Spectrum/verdict take tens of seconds (80 frame downloads + photometry). They run on their
# own small executor (at most HEAVY_SLOTS at a time), so /v2/search keeps the default
# threadpool and stays fast. A request whose client goes away while it is still queued is
# dropped before it starts; a running job finishes and its result is memoised by the provider.
HEAVY_SLOTS = 2
_HEAVY_POOL = ThreadPoolExecutor(max_workers=HEAVY_SLOTS, thread_name_prefix="prism-heavy")


async def _call_heavy(request: Request, name: str, **kwargs):
    if PROVIDERS.get(name) is None:
        return _not_implemented(name)
    abandoned = threading.Event()

    def job():
        if abandoned.is_set():
            return None
        return _call(name, **kwargs)

    fut = asyncio.wrap_future(_HEAVY_POOL.submit(job))
    while True:
        done, _ = await asyncio.wait({fut}, timeout=1.0)
        if done:
            return fut.result()
        if await request.is_disconnected():
            abandoned.set()
            return JSONResponse(status_code=499, content={"detail": "client disconnected",
                                                          "error_type": "client_closed"})


@router.get("/gaia")
def get_gaia(ra: float = _COMMON["ra"], dec: float = _COMMON["dec"],
             radius_arcmin: float = Query(3.0, gt=0, le=15.0),
             mjd: str = Query(..., description="comma-separated MJD list")):
    try:
        mjds = parse_mjd_list(mjd)
    except live.LiveError as exc:
        return _error(exc)
    return _call("gaia", ra=ra, dec=dec, radius_arcmin=radius_arcmin, mjd=mjds)


@router.get("/skybot")
def get_skybot(ra: float = _COMMON["ra"], dec: float = _COMMON["dec"],
               radius_arcmin: float = Query(3.0, gt=0, le=30.0),
               mjd: float = Query(..., gt=40000, lt=80000)):
    return _call("skybot", ra=ra, dec=dec, radius_arcmin=radius_arcmin, mjd=mjd)


# Human-readable sentences (check labels/details, summary, caveats, methods) follow ``lang``;
# responses always also carry *_en and *_es copies (see spherex.science.i18n), so a client
# can switch language without a new request. Default English; the shape only gains fields.
_LANG = Query("en", pattern="^(en|es)$", description="language of human-readable sentences: en or es")


@router.get("/spectrum")
async def get_spectrum(request: Request, ra: float = _COMMON["ra"], dec: float = _COMMON["dec"],
                       aperture_arcsec: float = Query(9.0, gt=0, le=60.0), lang: str = _LANG):
    result = await _call_heavy(request, "spectrum", ra=ra, dec=dec, aperture_arcsec=aperture_arcsec)
    return localize_spectrum(result, lang) if isinstance(result, dict) else result


@router.get("/verdict")
async def get_verdict(request: Request, ra: float = _COMMON["ra"], dec: float = _COMMON["dec"],
                      fov: float = Query(live.FOV_DEFAULT, ge=live.FOV_MIN, le=live.FOV_MAX), lang: str = _LANG):
    result = await _call_heavy(request, "verdict", ra=ra, dec=dec, fov=fov)
    return localize_verdict(result, lang) if isinstance(result, dict) else result
