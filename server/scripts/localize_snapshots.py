"""Add English/Spanish copies of verdict and spectrum sentences to saved explorer snapshots.

The static deployment serves frontend/public/snapshots/*.json directly, without the science
server, so the localized fields that /v2/verdict and /v2/spectrum return (``*_en``/``*_es``,
see spherex.science.i18n) are written into the files here. Measured values, pixels and
provenance are untouched; only text fields are added (and English renames applied).

    cd server && uv run --locked python scripts/localize_snapshots.py [../frontend/public/snapshots]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # run from anywhere: server/ on the path

from spherex.science.i18n import localize_spectrum, localize_verdict  # noqa: E402

DEFAULT_DIR = Path(__file__).resolve().parents[2] / "frontend" / "public" / "snapshots"


def localize_file(path: Path) -> bool:
    raw = path.read_text(encoding="utf-8")
    snap = json.loads(raw)
    if isinstance(snap.get("verdict"), dict):
        snap["verdict"] = localize_verdict(snap["verdict"], "en")
    if isinstance(snap.get("spectrum"), dict):
        snap["spectrum"] = localize_spectrum(snap["spectrum"], "en")
    # Same compact ASCII encoding the snapshots were saved with (round-trips byte for byte).
    out = json.dumps(snap, allow_nan=False, separators=(",", ":"), ensure_ascii=True)
    if out == raw:
        return False
    path.write_text(out, encoding="utf-8")
    return True


def main(argv: list[str]) -> int:
    root = Path(argv[1]) if len(argv) > 1 else DEFAULT_DIR
    for p in sorted(root.glob("*.json")):
        if p.name == "index.json":
            continue
        print(f"{p.name}: {'updated' if localize_file(p) else 'unchanged'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
