"""Operational hardening for unattended hardware runs (xd_record, the active loop):
keep the machine awake, check disk headroom, write outputs atomically.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path


@contextlib.contextmanager
def keep_awake() -> Iterator[None]:
    """Hold a power assertion for the duration so display/system/disk sleep can't suspend
    MIDI/audio mid-run. macOS only; a warning (not an error) elsewhere."""
    proc = None
    if sys.platform == "darwin":
        try:
            proc = subprocess.Popen(["caffeinate", "-dimsu", "-w", str(os.getpid())])
        except FileNotFoundError:
            print("warning: caffeinate not found; machine may sleep mid-run", file=sys.stderr)
    else:
        print(f"warning: keep_awake is a no-op on {sys.platform}", file=sys.stderr)
    try:
        yield
    finally:
        if proc is not None:
            proc.terminate()


def preflight_disk(path: Path, need_gb: float) -> None:
    target = path if path.exists() else path.parent
    free = shutil.disk_usage(target).free
    if free < need_gb * 1e9:
        raise RuntimeError(
            f"insufficient disk at {path}: {free / 1e9:.1f} GB free, need ~{need_gb} GB"
        )


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write via a temp file + rename so an interrupted write never leaves a partial file."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)
