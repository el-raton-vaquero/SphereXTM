"""Cross-platform, non-blocking advisory process lock (POSIX flock / Windows msvcrt)."""
from __future__ import annotations

from contextlib import contextmanager
import os
from pathlib import Path

if os.name == "nt":  # pragma: no cover - exercised on Windows only
    import msvcrt

    def _try_lock(handle) -> None:
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)

    def _unlock(handle) -> None:
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
else:  # pragma: no cover - exercised on POSIX only
    import fcntl

    def _try_lock(handle) -> None:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def _unlock(handle) -> None:
        fcntl.flock(handle, fcntl.LOCK_UN)


class LockBusyError(RuntimeError):
    """Raised when another handle already holds the lock."""


@contextmanager
def exclusive_lock(path: Path):
    """Hold an exclusive lock on ``path`` or raise LockBusyError immediately."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as handle:
        try:
            _try_lock(handle)
        except OSError as exc:  # BlockingIOError (POSIX) / PermissionError (Windows)
            raise LockBusyError(f"Lock is held: {path}") from exc
        try:
            yield
        finally:
            _unlock(handle)
