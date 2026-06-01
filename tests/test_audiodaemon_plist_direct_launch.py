"""Validate the com.yulu.audiodaemon.plist direct-launch shape (D-05 / PLAT-03).

The audio daemon plist must launch the binary DIRECTLY
(__SCRIPT_DIR__/Yulu.app/Contents/MacOS/audio_daemon) rather than via
`/usr/bin/open -W Yulu.app`. The `open -W` form leaves launchd supervising the
`open` helper instead of the daemon, so `launchctl unload` orphans the child —
the exact fragility Phase 7's migration depends on being gone. Mirrors the
static-assert style of test_status_agent_plist_template.py.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLIST = ROOT / "yulu" / "scripts" / "com.yulu.audiodaemon.plist"


def _text() -> str:
    return PLIST.read_text(encoding="utf-8")


def test_plist_exists():
    assert PLIST.exists()


def test_plist_has_required_keys():
    text = _text()
    for needle in (
        "<key>Label</key>",
        "<string>com.yulu.audiodaemon</string>",
        "<key>ProgramArguments</key>",
        "<key>RunAtLoad</key>",
        "<key>KeepAlive</key>",
        "<key>StandardOutPath</key>",
        "<key>StandardErrorPath</key>",
    ):
        assert needle in text, f"missing {needle}"


def test_plist_launches_binary_directly():
    """ProgramArguments must point at the in-bundle binary (D-05)."""
    text = _text()
    assert "MacOS/audio_daemon" in text, (
        "plist must launch Yulu.app/Contents/MacOS/audio_daemon directly"
    )
    assert "__SCRIPT_DIR__/Yulu.app/Contents/MacOS/audio_daemon" in text, (
        "direct-launch path must be rooted at __SCRIPT_DIR__"
    )


def test_plist_no_open_W_orphan_vector():
    """The `open -W` orphan vector must be removed at its root (D-05)."""
    text = _text()
    assert "/usr/bin/open" not in text, "plist still invokes /usr/bin/open"
    assert "<string>-W</string>" not in text, "plist still passes the -W flag to open"


def test_plist_has_script_dir_placeholder():
    """setup.sh substitutes __SCRIPT_DIR__ with the live path."""
    assert "__SCRIPT_DIR__" in _text()


def test_plist_has_home_placeholder_for_logs():
    assert "__HOME__" in _text()
