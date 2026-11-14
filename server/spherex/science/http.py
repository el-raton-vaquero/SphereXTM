"""Bounded HTTP GET with TLS verification and a small JSON disk cache.

TLS verification is never disabled. If the platform trust store lacks a root
(seen on Windows for ssp.imcce.fr), the certifi CA bundle is used instead, which
is still full certificate verification.
"""

from __future__ import annotations

from collections.abc import Callable
import hashlib
import json
import os
from pathlib import Path
import ssl
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

USER_AGENT = "PRISM-SPHEREx-science/0.1 (NASA Space Apps 2026)"
MAX_BYTES = 32 * 1024**2

Fetch = Callable[[str, float], bytes]

_lock = threading.Lock()


def _contexts() -> list[ssl.SSLContext]:
    ctxs = [ssl.create_default_context()]
    try:
        import certifi

        ctxs.append(ssl.create_default_context(cafile=certifi.where()))
    except ImportError:  # pragma: no cover - certifi is normally present
        pass
    return ctxs


def http_get(url: str, timeout: float = 30.0, limit: int = MAX_BYTES) -> bytes:
    """GET with size limit; tries the default trust store, then certifi's."""
    last: Exception | None = None
    for ctx in _contexts():
        for _attempt in range(2):
            try:
                started = time.monotonic()
                req = Request(url, headers={"User-Agent": USER_AGENT})
                with urlopen(req, timeout=timeout, context=ctx) as resp:
                    chunks, size = [], 0
                    while chunk := resp.read(65536):
                        size += len(chunk)
                        if size > limit:
                            raise ValueError(f"Response exceeds {limit} bytes")
                        if time.monotonic() - started > timeout * 2:
                            raise TimeoutError("Response exceeded elapsed deadline")
                        chunks.append(chunk)
                    return b"".join(chunks)
            except HTTPError as exc:  # server answered
                exc.close()
                last = RuntimeError(f"HTTP {exc.code} from {url.split('?')[0]}")
                if exc.code < 500:
                    raise last from exc
                time.sleep(1.0)  # 5xx: one retry on the same trust store
                continue
            except URLError as exc:
                last = exc
                if isinstance(exc.reason, ssl.SSLCertVerificationError):
                    break  # try next trust store
            except (TimeoutError, OSError) as exc:
                last = exc
    raise RuntimeError(f"Request failed: {url.split('?')[0]}: {last}")


def default_cache_dir() -> Path:
    base = os.environ.get("PRISM_SCIENCE_CACHE")
    path = Path(base) if base else Path(tempfile.gettempdir()) / "prism-science-cache"
    path.mkdir(parents=True, exist_ok=True)
    return path


def cache_key(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode()).hexdigest()[:32]


def cache_read(cache_dir: Path | None, key: str, max_age_s: float | None) -> dict | None:
    if cache_dir is None:
        return None
    path = Path(cache_dir) / f"{key}.json"
    if not path.exists():
        return None
    if max_age_s is not None and time.time() - path.stat().st_mtime > max_age_s:
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def cache_write(cache_dir: Path | None, key: str, data: dict) -> None:
    if cache_dir is None:
        return
    path = Path(cache_dir) / f"{key}.json"
    tmp = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
    with _lock:
        tmp.write_text(json.dumps(data, allow_nan=False))
        os.replace(tmp, path)
