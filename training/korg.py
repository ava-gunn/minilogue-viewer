"""Korg minilogue xd SysEx: 7-bit data codec, program load/request, and
.mnlgxdprog/.mnlgxdlib extraction.

Verified against the hardware: model id 00 01 51, CURRENT PROGRAM DATA DUMP func 0x40,
and a 1024-byte 'PROG' program-data blob — the same prog_bin web/src/parser reads.
"""

from __future__ import annotations

import zipfile
from pathlib import Path

KORG_ID = 0x42
MODEL_ID = [0x00, 0x01, 0x51]  # minilogue xd
FUNC_PROGRAM_DUMP = 0x40
FUNC_PROGRAM_REQUEST = 0x10
PROG_BIN_SIZE = 1024


def channel_byte(channel: int = 1) -> int:
    return 0x30 | ((channel - 1) & 0x0F)


def encode_7bit(data: bytes) -> list[int]:
    """8-bit -> Korg 7-bit: each group of 7 bytes is prefixed by a byte holding their MSBs."""
    out: list[int] = []
    for i in range(0, len(data), 7):
        group = data[i : i + 7]
        msb = 0
        for j, b in enumerate(group):
            if b & 0x80:
                msb |= 1 << j
        out.append(msb)
        out.extend(b & 0x7F for b in group)
    return out


def decode_7bit(data: list[int]) -> bytes:
    out = bytearray()
    i = 0
    while i < len(data):
        msb = data[i]
        i += 1
        for j in range(7):
            if i >= len(data):
                break
            b = data[i]
            i += 1
            out.append(b | 0x80 if (msb >> j) & 1 else b)
    return bytes(out)


def program_dump(prog_bin: bytes, channel: int = 1) -> list[int]:
    """SysEx body (excl. F0/F7) that loads prog_bin into the XD's edit buffer."""
    return [KORG_ID, channel_byte(channel), *MODEL_ID, FUNC_PROGRAM_DUMP, *encode_7bit(prog_bin)]


def program_request(channel: int = 1) -> list[int]:
    return [KORG_ID, channel_byte(channel), *MODEL_ID, FUNC_PROGRAM_REQUEST]


def parse_program_dump(sysex_data: list[int]) -> bytes | None:
    """If sysex_data (a received SysEx body) is a current-program dump, return its prog_bin."""
    if (
        len(sysex_data) >= 6
        and sysex_data[0] == KORG_ID
        and sysex_data[2:5] == MODEL_ID
        and sysex_data[5] == FUNC_PROGRAM_DUMP
    ):
        return decode_7bit(sysex_data[6:])
    return None


def extract_prog_bins(path: Path) -> list[bytes]:
    """All .prog_bin blobs from a .mnlgxdprog / .mnlgxdlib (both are ZIP archives)."""
    with zipfile.ZipFile(path) as z:
        names = sorted(n for n in z.namelist() if n.endswith(".prog_bin"))
        return [z.read(n) for n in names]
