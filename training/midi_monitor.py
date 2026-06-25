"""Timestamped MIDI monitor — logs every message arriving on each MIDI input, so you can
see what the minilogue xd transmits and what any other app or bus is sending. Built to
answer "what keeps sending patch changes to the XD?": Program Change and Korg
CURRENT PROGRAM DATA DUMP messages are flagged loudly.

IMPORTANT — direction: a normal input monitor sees what a device *transmits* (its source),
NOT what an app sends *to* the XD (that goes to the XD's destination port and is invisible
to other listeners). To capture what a DAW like Ableton sends to the synth, run with
--virtual and re-route the DAW track's MIDI output to the "XD Monitor" port that appears;
everything it sends then shows up here.

Run from the repo root with the training venv (same convention as the daemon):

    PYTHONPATH=. training/.venv/bin/python -m training.midi_monitor            # watch every input
    PYTHONPATH=. training/.venv/bin/python -m training.midi_monitor --list     # list ports and exit
    PYTHONPATH=. training/.venv/bin/python -m training.midi_monitor --match xd # only matching ports
    PYTHONPATH=. training/.venv/bin/python -m training.midi_monitor --virtual  # + an "XD Monitor" destination to route a DAW into
    PYTHONPATH=. training/.venv/bin/python -m training.midi_monitor --patches-only --raw
"""

from __future__ import annotations

import argparse
import datetime
import queue
import sys
import time
from collections import Counter

import mido

from training import korg


def describe(msg: mido.Message) -> tuple[str, bool]:
    """Human-readable line for a message + whether it changes the patch."""
    if msg.type == "program_change":
        return f"PROGRAM CHANGE   ch={msg.channel + 1:<2} program={msg.program}", True

    if msg.type == "control_change":
        notes = {
            0: " (Bank Select MSB)",
            32: " (Bank Select LSB)",
            120: " (All Sound Off)",
            123: " (All Notes Off)",
        }
        note = notes.get(msg.control, "")
        # Bank Select precedes a Program Change to pick a patch bank.
        is_patch = msg.control in (0, 32)
        return (
            f"control_change   ch={msg.channel + 1:<2} cc={msg.control} val={msg.value}{note}",
            is_patch,
        )

    if msg.type == "sysex":
        data = list(msg.data)  # mido drops the F0/F7; data[0] is the Korg ID
        if korg.parse_program_dump(data) is not None:
            return f"SYSEX CURRENT PROGRAM DUMP ({len(data)} bytes) — overwrites the edit buffer", True
        is_korg = data[:1] == [korg.KORG_ID] and data[2:5] == korg.MODEL_ID
        if is_korg and len(data) >= 6 and data[5] == korg.FUNC_PROGRAM_REQUEST:
            return f"sysex            Korg dump request ({len(data)} bytes)", False
        return f"sysex            {len(data)} bytes", False

    if msg.type in ("note_on", "note_off"):
        return f"{msg.type:<16} ch={msg.channel + 1:<2} note={msg.note} vel={msg.velocity}", False

    return f"{msg.type:<16} {msg}", False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="store_true", help="list MIDI input/output ports and exit")
    ap.add_argument("--match", help="only open input ports whose name contains this (case-insensitive)")
    ap.add_argument("--virtual", action="store_true", help='also open a virtual "XD Monitor" destination to route a DAW into')
    ap.add_argument("--raw", action="store_true", help="also print raw message bytes")
    ap.add_argument("--patches-only", action="store_true", help="only log program changes / sysex program dumps")
    ap.add_argument("--seconds", type=float, default=0.0, help="auto-stop after N seconds (0 = run until Ctrl-C)")
    args = ap.parse_args()

    if args.list:
        print("inputs (sources — what devices transmit):")
        for n in mido.get_input_names():
            print(f"  • {n}")
        print("\noutputs (destinations — where apps send TO):")
        for n in mido.get_output_names():
            print(f"  • {n}")
        return 0

    names = mido.get_input_names()
    if args.match:
        names = [n for n in names if args.match.lower() in n.lower()]

    q: queue.Queue = queue.Queue()

    def make_cb(port_name: str):
        def cb(msg: mido.Message) -> None:
            q.put((time.time(), port_name, msg))
        return cb

    ports = []
    for n in names:
        try:
            ports.append(mido.open_input(n, callback=make_cb(n)))
        except (OSError, ValueError) as err:
            print(f"!! could not open input {n!r}: {err}", file=sys.stderr)

    if args.virtual:
        try:
            ports.append(mido.open_input("XD Monitor", virtual=True, callback=make_cb("XD Monitor (virtual)")))
        except (OSError, NotImplementedError, ValueError) as err:
            print(f"!! virtual port unavailable ({err}); needs python-rtmidi on CoreMIDI/ALSA", file=sys.stderr)

    if not ports:
        print("no MIDI input ports to watch.", file=sys.stderr)
        print("available inputs:", mido.get_input_names() or "(none)", file=sys.stderr)
        return 1

    print(f"monitoring {len(ports)} port(s) — Ctrl-C to stop:")
    for n in names:
        print(f"  • {n}")
    if args.virtual:
        print('  • XD Monitor (virtual destination — route a DAW track output here to capture what it sends)')
    print("  ‹‹ messages that change the patch are flagged with  ◀── PATCH CHANGE ››\n")

    counts: Counter = Counter()
    deadline = time.time() + args.seconds if args.seconds else None
    try:
        while True:
            if deadline and time.time() >= deadline:
                break
            try:
                ts, port_name, msg = q.get(timeout=0.2)
            except queue.Empty:
                continue
            counts[(port_name, msg.type)] += 1  # count everything, even when --patches-only hides the live line
            text, is_patch = describe(msg)
            if args.patches_only and not is_patch:
                continue
            stamp = datetime.datetime.fromtimestamp(ts).strftime("%H:%M:%S.%f")[:-3]
            flag = "  ◀── PATCH CHANGE" if is_patch else ""
            print(f"[{stamp}]  {port_name:30.30s}  {text}{flag}")
            if args.raw:
                print(f"               raw: {[hex(b) for b in msg.bytes()]}")
    except KeyboardInterrupt:
        pass
    finally:
        for p in ports:
            p.close()

    print("\n── totals ──")
    if not counts:
        print("  (no messages seen)")
    for (port_name, mtype), n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {n:6d}  {port_name:30.30s}  {mtype}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
