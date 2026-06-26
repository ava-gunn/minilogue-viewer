"""Reusable hardware interface to the Minilogue XD over a MIDI + audio interface (the
Volt 276): load a patch via SysEx, play a gated note, record the output.

Shared by the recording rig and the eval loop. The note is gated off before the
recording ends so the full envelope — including release — is captured, and the
returned audio is trimmed to start exactly at note-on so onsets align across samples.
"""

from __future__ import annotations

import time

import mido
import numpy as np
import sounddevice as sd

from training import korg


class XdInterface:
    def __init__(
        self,
        midi_port: str = "Volt 276",
        audio_device: str = "Volt 276",
        midi_in: str = "Volt 276",
        sample_rate: int = 44100,
        channel: int = 1,
    ) -> None:
        self.sr = sample_rate
        self.channel = channel
        self._out = self._in = None
        try:
            self._out = mido.open_output(midi_port)
            self._in = mido.open_input(midi_in)  # kept open; reopening per-read drops replies
            self._dev = self._find_input(audio_device)
        except BaseException:  # don't leak a half-open port if a later open/lookup fails
            if self._out is not None:
                self._out.close()
            if self._in is not None:
                self._in.close()
            raise

    @staticmethod
    def _find_input(name: str) -> int:
        for i, d in enumerate(sd.query_devices()):
            if d["name"] == name and d["max_input_channels"] >= 2:
                return i
        raise RuntimeError(f"audio input device {name!r} (>=2ch) not found")

    def send_patch(self, prog_bin: bytes, settle_s: float = 0.5) -> None:
        """Load a 1024-byte prog_bin into the edit buffer; wait for it to settle. The
        ~1.2 kB dump takes ~0.4 s to clock out over DIN MIDI, so settle must exceed that."""
        self._out.send(mido.Message("sysex", data=korg.program_dump(prog_bin, self.channel)))
        time.sleep(settle_s)

    def record(
        self,
        note: int = 60,
        gate_s: float = 0.6,
        duration_s: float = 1.0,
        velocity: int = 100,
        lead_s: float = 0.05,
    ) -> np.ndarray:
        """Play a gated note and return mono audio of length duration_s*sr, trimmed so
        note-on is at sample 0."""
        n = int(duration_s * self.sr)
        lead = int(lead_s * self.sr)
        rec = sd.rec(n + lead, samplerate=self.sr, channels=2, dtype="float32", device=self._dev)
        ch = self.channel - 1
        try:
            time.sleep(lead_s)  # let the stream spin up + capture a hair of pre-note
            self._out.send(mido.Message("note_on", note=note, velocity=velocity, channel=ch))
            time.sleep(gate_s)
        finally:
            # Always release the note, even if interrupted between on and off.
            self._out.send(mido.Message("note_off", note=note, channel=ch))
        sd.wait()
        return rec[lead : lead + n].mean(axis=1)

    def panic(self) -> None:
        """All Sound Off + All Notes Off on every channel — kill any stuck notes."""
        for ch in range(16):
            self._out.send(mido.Message("control_change", channel=ch, control=120, value=0))
            self._out.send(mido.Message("control_change", channel=ch, control=123, value=0))

    def read_current_program(self, timeout_s: float = 3.0) -> bytes | None:
        """Request the edit-buffer program and return its decoded prog_bin (None on timeout)."""
        for _ in self._in.iter_pending():  # flush stale messages
            pass
        self._out.send(mido.Message("sysex", data=korg.program_request(self.channel)))
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            for msg in self._in.iter_pending():
                if msg.type == "sysex":
                    prog_bin = korg.parse_program_dump(list(msg.data))
                    if prog_bin is not None:
                        return prog_bin
            time.sleep(0.01)
        return None

    def close(self) -> None:
        try:
            self.panic()
        finally:
            self._out.close()
            self._in.close()
