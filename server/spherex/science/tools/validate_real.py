"""Run the science router end-to-end against REAL IRSA/Gaia/SkyBoT services.

From server/ (network required; downloads ~4 MB per cutout into --cache):

    uv run --locked python -m spherex.science.tools.validate_real --cache <dir> \
        --target wise0855 --max-frames 36

Prints a compact, honest summary of what was measured. Nothing is fabricated:
failures are printed as failures.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
from astropy.time import Time

from spherex.science.routes import build_router
from spherex.targets import load_targets, predict


def target_position(tid: str, mjd: float) -> tuple[float, float]:
    c = predict(load_targets()[tid], mjd)
    return float(c.ra.deg), float(c.dec.deg)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", required=True)
    ap.add_argument("--target", default="wise0855")
    ap.add_argument("--max-frames", type=int, default=36)
    ap.add_argument("--mjd", type=float, default=61000.0, help="epoch for the query position")
    ap.add_argument("--endpoint", choices=["verdict", "spectrum", "both"], default="both")
    ap.add_argument("--dump", help="write raw JSON responses here")
    args = ap.parse_args()
    app = FastAPI()
    app.include_router(build_router(cache_dir=Path(args.cache)))
    client = TestClient(app)
    ra, dec = target_position(args.target, args.mjd)
    print(f"target {args.target}: query position (registry prediction @MJD {args.mjd}) "
          f"RA {ra:.6f} Dec {dec:.6f} ({Time(args.mjd, format='mjd').iso[:10]})")
    dump = {}
    if args.endpoint in ("spectrum", "both"):
        t = time.time()
        r = client.get("/v2/spectrum", params={"ra": ra, "dec": dec, "max_frames": args.max_frames})
        print(f"/v2/spectrum HTTP {r.status_code} in {time.time() - t:.1f} s")
        body = r.json()
        dump["spectrum"] = body
        if r.status_code == 200:
            fr = body["provenance"]["frames"]
            print(f"  frames: available {fr.get('n_available')} selected {fr.get('n_selected')} loaded "
                  f"{fr.get('n_loaded')} cached {fr.get('n_cached')} failures {len(fr.get('failures', []))}")
            print(f"  tracking: {body['tracking']}")
            print("  date        det  lambda_um  flux_mJy    err_mJy   snr    sat  flags")
            for p in sorted(body["points"], key=lambda p: (p["detector"], p["lambda_um"] or 0)):
                if p["status"] != "ok":
                    print(f"  {Time(p['mjd'], format='mjd').iso[:10]}  D{p['detector']}  {p['lambda_um'] or 0:8.4f}  "
                          f"status={p['status']}  flags={','.join(p['flags'])}")
                    continue
                print(f"  {Time(p['mjd'], format='mjd').iso[:10]}  D{p['detector']}  {p['lambda_um']:8.4f}  "
                      f"{p['flux']:9.4f}  {p['err']:9.4f}  {p['snr']:6.1f}  {'Y' if p['saturated'] else '.'}    "
                      f"{','.join(p['flags'])}")
            cls = body["classification"]
            print(f"  classification best: {cls.get('best')}")
            for row in cls.get("ranking", [])[:5]:
                print(f"     {row['template']:22s} p={row['prob']:.3f} chi2_red={row['chi2_red']:.2f}")
            print(f"  caveats: {cls.get('caveats')}")
            print(f"  goggles: {[(g['id'], g['depth'], g['err']) for g in body['goggles']]}")
        else:
            print("  ", body)
    if args.endpoint in ("verdict", "both"):
        t = time.time()
        r = client.get("/v2/verdict", params={"ra": ra, "dec": dec, "max_frames": args.max_frames})
        print(f"/v2/verdict HTTP {r.status_code} in {time.time() - t:.1f} s")
        body = r.json()
        dump["verdict"] = body
        if r.status_code == 200:
            print(f"  verdict={body['verdict']} confidence={body['confidence']:.2f}")
            print(f"  summary: {body['summary']}")
            for c in body["checks"]:
                print(f"   [{c['status']:4s}] {c['id']:11s} {c['detail']}")
            print(f"  season positions: {body['evidence']['season_positions']}")
        else:
            print("  ", body)
    if args.dump:
        Path(args.dump).write_text(json.dumps(dump, indent=1))


if __name__ == "__main__":
    main()
