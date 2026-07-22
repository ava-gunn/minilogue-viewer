"""minilogue xd MIDI bridge — a macOS menu-bar app that relays raw MIDI between the Korg minilogue
xd and browser clients (the Ableton extension WebView / the web app) over a localhost WebSocket, so
they can reach the synth without Web MIDI (WKWebView has none).

Dumb relay: raw MIDI bytes both ways — clients do all the SysEx/CC parsing with the code they
already have. Nothing runs in the background: quitting from the menu bar closes the WebSocket and
every MIDI port and exits the single process. No LaunchAgent, no daemon.

    Run (dev):   python bridge.py
    Build .app:  python setup.py py2app     # then right-click > Open on first launch (un-notarized)
    Deps:        pip install rumps python-rtmidi websockets
"""

from __future__ import annotations

import asyncio
import re
import threading

import rtmidi
import rumps
import websockets

WS_HOST = "127.0.0.1"
WS_PORT = 8766
XD_RE = re.compile(r"minilogue\s*xd", re.I)
PREFERRED_OUT = "sound"  # the XD port that receives program loads / notes


def _xd_ports(io: rtmidi.MidiIn | rtmidi.MidiOut) -> list[tuple[int, str]]:
    return [(i, n) for i, n in enumerate(io.get_ports()) if XD_RE.search(n)]


class Bridge(rumps.App):
    def __init__(self) -> None:
        super().__init__("🎹", quit_button=None)  # custom Quit so we can tear down cleanly
        self._status = rumps.MenuItem("XD: …")
        self._clients_item = rumps.MenuItem(f"ws://{WS_HOST}:{WS_PORT}")
        self.menu = [
            self._status,
            self._clients_item,
            None,
            rumps.MenuItem("Quit", callback=self._quit),
        ]

        self._clients: set = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._server = None
        self._error = ""
        self._midi_out: rtmidi.MidiOut | None = None
        self._out_name = ""
        self._midi_ins: list[rtmidi.MidiIn] = []

        self._open_midi()
        threading.Thread(target=self._run_ws, daemon=True).start()

    # ── MIDI ────────────────────────────────────────────────────────────────
    def _open_midi(self) -> None:
        out = rtmidi.MidiOut()
        ports = _xd_ports(out)
        pick = next((p for p in ports if PREFERRED_OUT in p[1].lower()), ports[0] if ports else None)
        if pick is not None:
            out.open_port(pick[0])
            self._midi_out, self._out_name = out, pick[1]
        else:
            out.delete()

        probe = rtmidi.MidiIn()
        in_ports = _xd_ports(probe)
        probe.delete()
        for idx, _name in in_ports:
            mi = rtmidi.MidiIn()
            mi.open_port(idx)
            # relay SysEx dumps + Active Sensing (the client uses the heartbeat for liveness); drop clock
            mi.ignore_types(sysex=False, timing=True, active_sense=False)
            mi.set_callback(self._on_midi)
            self._midi_ins.append(mi)

    def _on_midi(self, event, _data=None) -> None:
        # rtmidi thread: forward raw bytes to every connected client.
        message, _delta = event
        loop = self._loop
        if loop and self._clients:
            asyncio.run_coroutine_threadsafe(self._broadcast(bytes(message)), loop)

    # ── WebSocket ─────────────────────────────────────────────────────────────
    def _run_ws(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        try:
            loop.run_until_complete(self._serve())
        except OSError as e:  # e.g. port already in use
            self._error = f"ws bind failed: {e}"
            return
        loop.run_forever()

    async def _serve(self) -> None:
        self._server = await websockets.serve(self._handler, WS_HOST, WS_PORT)

    async def _handler(self, ws, *_args) -> None:  # *_args tolerates older websockets (path arg)
        self._clients.add(ws)
        try:
            async for message in ws:
                if isinstance(message, (bytes, bytearray)) and self._midi_out:
                    self._midi_out.send_message(list(message))
        finally:
            self._clients.discard(ws)

    async def _broadcast(self, data: bytes) -> None:
        if self._clients:
            websockets.broadcast(self._clients, data)

    # ── UI + lifecycle ────────────────────────────────────────────────────────
    @rumps.timer(1)
    def _refresh(self, _timer) -> None:
        self.title = "🎹" if self._midi_out else "🎹⚠️"
        self._status.title = f"XD: {self._out_name}" if self._midi_out else "XD: not connected"
        self._clients_item.title = (
            self._error or f"Clients: {len(self._clients)}  ·  ws://{WS_HOST}:{WS_PORT}"
        )

    def _quit(self, _sender) -> None:
        # Explicit teardown, then exit — nothing survives the quit.
        if self._loop and self._server:
            self._loop.call_soon_threadsafe(self._server.close)
        if self._loop:
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._midi_out:
            self._midi_out.close_port()
            self._midi_out.delete()
        for mi in self._midi_ins:
            mi.close_port()
            mi.delete()
        rumps.quit_application()


if __name__ == "__main__":
    Bridge().run()
