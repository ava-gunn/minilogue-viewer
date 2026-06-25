"""Emergency silence for the Minilogue XD. Sends All Sound Off + All Notes Off on every
channel AND loads a clean patch — the latter is needed because a high-resonance patch can
leave the analog filter *self-oscillating* (a continuous tone with no note), which
notes-off alone won't stop. Run any time the Korg won't go quiet:

    python -m training.panic
"""

from __future__ import annotations

from pathlib import Path

import mido

from training import korg

PORTS = ["minilogue xd SOUND", "Volt 276", "minilogue xd MIDI OUT"]
_CLEAN_PATCH = Path(__file__).resolve().parent.parent / "web" / "replicant-example.mnlgxdprog"


def main() -> None:
    clean = korg.extract_prog_bins(_CLEAN_PATCH)[0]
    for name in PORTS:
        try:
            out = mido.open_output(name)
        except OSError:
            continue
        for ch in range(16):
            out.send(mido.Message("control_change", channel=ch, control=120, value=0))
            out.send(mido.Message("control_change", channel=ch, control=123, value=0))
        out.send(mido.Message("sysex", data=korg.program_dump(clean)))  # reset filter/engine
        out.close()
        print(f"silenced via {name!r}")


if __name__ == "__main__":
    main()
