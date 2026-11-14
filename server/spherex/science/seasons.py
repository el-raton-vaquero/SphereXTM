"""Grouping of observation epochs into survey "seasons".

SPHEREx maps each sky position in visits clustered in time (roughly every ~6
months). A season is a cluster of frames whose consecutive gaps are <= gap_days.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

DEFAULT_GAP_DAYS = 60.0


def assign_seasons(mjds: Sequence[float], gap_days: float = DEFAULT_GAP_DAYS) -> list[int]:
    """Season index (0-based, chronological) for each MJD, in input order."""
    mjds = np.asarray(mjds, float)
    if mjds.size == 0:
        return []
    if not np.isfinite(mjds).all():
        raise ValueError("Non-finite MJD")
    order = np.argsort(mjds, kind="stable")
    labels = np.empty(mjds.size, int)
    season = 0
    labels[order[0]] = 0
    for prev, cur in zip(order[:-1], order[1:]):
        if mjds[cur] - mjds[prev] > gap_days:
            season += 1
        labels[cur] = season
    return labels.tolist()


def season_table(mjds: Sequence[float], gap_days: float = DEFAULT_GAP_DAYS) -> list[dict]:
    """[{index, start_mjd, end_mjd, mid_mjd, n_frames}] as in the V2 contract (+mid_mjd)."""
    labels = assign_seasons(mjds, gap_days)
    mjds = np.asarray(mjds, float)
    out = []
    for s in sorted(set(labels)):
        sel = mjds[np.asarray(labels) == s]
        out.append({"index": s, "start_mjd": float(sel.min()), "end_mjd": float(sel.max()),
                    "mid_mjd": float(np.median(sel)), "n_frames": int(sel.size)})
    return out
