"""Precompute PRISM snapshots: REAL SPHEREx data fetched live from IRSA, cached as JSON.

Writes ``frontend/public/snapshots/<id>.json`` — ``{kind: 'prism-snapshot', search:
<GET /v2/search, cache='snapshot'>, target, gaia, spectrum, verdict, extras_absent}`` as
read by frontend/lib/prism/snapshot.ts — and ``index.json``. gaia/spectrum/verdict come
from the providers registered in ``spherex.v2`` (spherex.v2_providers).

Usage (from ``server/``)::

    uv run --locked python scripts/precompute_snapshots.py                 # all six presets
    uv run --locked python scripts/precompute_snapshots.py wise-0855 barnard
    uv run --locked python scripts/precompute_snapshots.py --max-frames 120 --fov 4

A failed target is reported and left out (never replaced by synthetic data); the
index records the failure. Exit code 0 only if every requested target succeeded.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time

SERVER = Path(__file__).resolve().parent.parent
if str(SERVER) not in sys.path:
    sys.path.insert(0, str(SERVER))

from spherex import live, targets_v2, v2  # noqa: E402

DEFAULT_OUT = SERVER.parent / "frontend" / "public" / "snapshots"
MAX_SNAPSHOT_BYTES = 4 * 1024**2


def _dump(obj) -> bytes:
    return json.dumps(obj, separators=(",", ":"), allow_nan=False).encode()


GAIA_FIELDS = ("source_id", "ra", "dec", "ref_epoch", "pmra", "pmdec", "parallax", "phot_g_mean_mag",
               "positions", "kind")


def gaia_epochs(response: dict) -> list[float]:
    """Start, middle and end of every season: enough for nearest-epoch overlays in a snapshot."""
    out = []
    for s in response["seasons"]:
        out += [s["start_mjd"], (s["start_mjd"] + s["end_mjd"]) / 2, s["end_mjd"]]
    return sorted({round(m, 5) for m in out}) or sorted({round(f["mjd"], 5) for f in response["frames"]})[:12]


def trim_gaia(payload: dict) -> dict:
    payload = dict(payload)
    payload["sources"] = [{k: s.get(k) for k in GAIA_FIELDS} for s in payload.get("sources", [])]
    return payload


def optional_extras(target: dict, response: dict, fov: float) -> dict:
    """Call registered providers only; record why an extra is absent."""
    extras, absent = {}, {}
    ra, dec = target["ra"], target["dec"]
    calls = {
        "gaia": dict(ra=ra, dec=dec, radius_arcmin=fov / 2 * 1.5, mjd=gaia_epochs(response)),
        "spectrum": dict(ra=ra, dec=dec, aperture_arcsec=9.0),
        "verdict": dict(ra=ra, dec=dec, fov=fov),
    }
    for name, kwargs in calls.items():
        fn = v2.PROVIDERS.get(name)
        if fn is None:
            absent[name] = "no provider registered in this build"
            continue
        t0 = time.monotonic()
        try:
            out = fn(**kwargs)
        except Exception as exc:  # noqa: BLE001 - recorded, not faked
            absent[name] = f"{type(exc).__name__}: {exc}"
            print(f"    {name}: FAILED {absent[name]}", flush=True)
            continue
        if not isinstance(out, dict):  # a JSONResponse error from the v2 dispatcher
            absent[name] = f"HTTP {getattr(out, 'status_code', '?')}: {getattr(out, 'body', b'')[:300]!r}"
            print(f"    {name}: FAILED {absent[name]}", flush=True)
            continue
        extras[name] = trim_gaia(out) if name == "gaia" else out
        print(f"    {name}: ok in {time.monotonic() - t0:.1f} s", flush=True)
    extras["extras_absent"] = absent
    return extras


SEARCH_KEYS = ("query", "grid", "frames", "seasons", "detectors", "pixel_encoding", "units",
               "provenance", "flag_bits")


def build_snapshot(target: dict, fov: float, max_frames: int, deadline: float,
                   workers: int) -> tuple[bytes, dict]:
    """Snapshot file = {kind:'prism-snapshot', search: <GET /v2/search>, gaia, spectrum, verdict}."""
    started = time.monotonic()
    frames = max_frames
    extras = None
    while True:
        response = live.search(target["ra"], target["dec"], fov, frames, workers=workers,
                               deadline_s=deadline,
                               progress=lambda e: print(f"    {e}", flush=True)
                               if e.get("stage") != "frames" or e.get("done", 0) % 40 == 0 else None)
        if extras is None:  # independent of the frame count used for the image sequence
            extras = optional_extras(target, response, fov)
        generated = datetime.now(timezone.utc).isoformat()
        search = {k: response[k] for k in SEARCH_KEYS if k in response}
        search["cache"] = "snapshot"
        snapshot = {
            "kind": "prism-snapshot", "version": 2, "id": target["id"], "name": target["name"],
            "generated_utc": generated, "target": target, "search": search,
            **{k: v for k, v in extras.items() if k != "extras_absent"},
            "extras_absent": extras.get("extras_absent", {}),
            "note": "Real SPHEREx Level 2 data retrieved live from NASA/IPAC IRSA and cached; not synthetic. "
                    "gaia/spectrum/verdict come from the same /v2 providers as the live API. "
                    "Regenerate with server/scripts/precompute_snapshots.py.",
            "parameters": {"fov": fov, "max_frames": frames},
        }
        blob = _dump(snapshot)
        if len(blob) <= MAX_SNAPSHOT_BYTES or frames <= 20:
            break
        frames = int(frames * MAX_SNAPSHOT_BYTES / len(blob) * 0.95)
        print(f"    snapshot {len(blob)} B > limit; retrying with max_frames={frames}")
    elapsed = time.monotonic() - started
    verdict = snapshot.get("verdict") or {}
    summary = {
        "id": target["id"], "name": target["name"], "file": f"{target['id']}.json",
        "bytes": len(blob), "ra": target["ra"], "dec": target["dec"], "fov": fov,
        "grid_n": response["grid"]["n"],
        "n_frames": len(response["frames"]), "n_available": response["provenance"]["n_available"],
        "n_failed": len(response["provenance"]["errors"]),
        "seasons": [{k: s[k] for k in ("index", "start_mjd", "end_mjd", "n_frames")}
                    for s in response["seasons"]],
        "detectors": response["detectors"],
        "saturated_frames": sum(1 for f in response["frames"] if f["saturated_at_center"]),
        "verdict": verdict.get("verdict"), "confidence": verdict.get("confidence"),
        "elapsed_s": round(elapsed, 1),
        "transfer_bytes": response["provenance"]["transfer_bytes"],
        "generated_utc": generated,
        "extras": sorted(k for k in ("gaia", "spectrum", "verdict") if k in snapshot),
        "extras_absent": snapshot["extras_absent"],
    }
    return blob, summary


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("targets", nargs="*", help="preset ids (default: all)")
    parser.add_argument("--fov", type=float, default=4.0)
    parser.add_argument("--max-frames", type=int, default=160)
    parser.add_argument("--deadline", type=float, default=600.0)
    parser.add_argument("--workers", type=int, default=10)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)
    registry = {t["id"]: t for t in targets_v2.load_registry()["targets"]}
    wanted = args.targets or list(registry)
    unknown = [t for t in wanted if t not in registry]
    if unknown:
        parser.error(f"unknown targets {unknown}; known: {list(registry)}")
    args.out.mkdir(parents=True, exist_ok=True)
    index_path = args.out / "index.json"
    index = {"snapshots": [], "failures": []}
    if index_path.exists():
        try:
            index = json.loads(index_path.read_text(encoding="utf-8"))
        except ValueError:
            pass
    entries = {e["id"]: e for e in index.get("snapshots", [])}
    failures = {f["id"]: f for f in index.get("failures", [])}
    ok = True
    for tid in wanted:
        target = registry[tid]
        print(f"[{tid}] {target['name']} ra={target['ra']:.6f} dec={target['dec']:+.6f}", flush=True)
        try:
            blob, summary = build_snapshot(target, args.fov, args.max_frames, args.deadline, args.workers)
        except live.LiveError as exc:
            ok = False
            failures[tid] = {"id": tid, "error": exc.to_dict(),
                             "utc": datetime.now(timezone.utc).isoformat()}
            print(f"[{tid}] FAILED: {exc.to_dict()}", flush=True)
            continue
        (args.out / summary["file"]).write_bytes(blob)
        entries[tid] = summary
        failures.pop(tid, None)
        print(f"[{tid}] {summary['n_frames']} frames ({summary['n_available']} available), "
              f"{len(summary['seasons'])} seasons, detectors "
              f"{[d['detector'] for d in summary['detectors']]}, {summary['bytes']/1e6:.2f} MB, "
              f"{summary['elapsed_s']} s", flush=True)
    order = list(registry)
    index = {
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "kind": "prism-snapshot-index",
        "schema": "{kind:'prism-snapshot', search: GET /v2/search (cache='snapshot'), gaia, spectrum, verdict}",
        "real_data": True,
        "citation": live.CITATION,
        "snapshots": sorted(entries.values(), key=lambda e: order.index(e["id"]) if e["id"] in order else 99),
        "failures": list(failures.values()),
    }
    index_path.write_text(json.dumps(index, indent=1, allow_nan=False) + "\n", encoding="utf-8")
    print(f"index -> {index_path}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
