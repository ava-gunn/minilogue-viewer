"""py2app build for the minilogue xd MIDI bridge.

    pip install py2app
    python setup.py py2app          # -> dist/bridge.app  (menu-bar only, no Dock icon)

Un-notarized: on first launch macOS Gatekeeper will block it — right-click the app > Open once.
"""

from setuptools import setup

setup(
    app=["bridge.py"],
    setup_requires=["py2app"],
    options={
        "py2app": {
            "argv_emulation": False,
            "packages": ["rtmidi", "websockets"],
            "plist": {
                "CFBundleName": "minilogue xd bridge",
                "CFBundleIdentifier": "com.minilogue-xd.bridge",
                "LSUIElement": True,  # menu-bar agent: no Dock icon, no main window
                "LSMinimumSystemVersion": "11.0",
            },
        }
    },
)
