"""Export small M4 evidence subsets for the runtime package, never image pixels.

Run from server/: uv run --locked python scripts/export_dataset_evidence.py
The original checked-in M4 manifest summary remains the scientific authority.
"""
import hashlib
import json
from pathlib import Path


def export():
    root = Path(__file__).resolve().parents[2]
    source = root / "docs/m4-evidence.json"
    registry = root / "server/spherex/data/datasets.json"
    evidence = json.loads(source.read_text())
    pairs = {}
    for entry in json.loads(registry.read_text()):
        if not entry["target_id"]:
            continue
        candidate = next(c for c in evidence["candidates"] if c["target"]["id"] == entry["target_id"])
        detector = next(d for d in candidate["detectors"] if d["detector"] == entry["detector"])
        pair = next(p for p in detector["accepted"] if p["obs_ids"] == entry["observationIds"])
        ids = entry["observationIds"]
        pairs[entry["id"]] = {
            "target": candidate["target"], "center": candidate["fixed_grid_center"],
            "pair": pair,
            "products": [next(p for p in detector["products"] if p["obs_id"] == id) for id in ids],
            "observations": [next(o for o in detector["observations"] if o["obs_id"] == id) for id in ids],
        }
    result = {"source": "docs/m4-evidence.json",
              "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "datasets": pairs}
    destination = registry.with_name("dataset-evidence.json")
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    print(destination)


if __name__ == "__main__":
    export()
