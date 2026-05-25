"""Validate the com.yulu.statusagent.plist template shape."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLIST = ROOT / "yulu" / "scripts" / "com.yulu.statusagent.plist"


def test_plist_exists():
    assert PLIST.exists()


def test_plist_has_required_keys():
    text = PLIST.read_text(encoding="utf-8")
    for needle in (
        "<key>Label</key>",
        "<string>com.yulu.statusagent</string>",
        "<key>ProgramArguments</key>",
        "<key>RunAtLoad</key>",
        "<key>KeepAlive</key>",
        "<key>ThrottleInterval</key>",
        "<key>StandardOutPath</key>",
        "<key>StandardErrorPath</key>",
    ):
        assert needle in text, f"missing {needle}"


def test_plist_uses_open_W_pattern():
    text = PLIST.read_text(encoding="utf-8")
    assert "/usr/bin/open" in text
    assert "-W" in text
    assert "StatusAgent.app" in text


def test_plist_has_script_dir_placeholder():
    """setup.sh substitutes __SCRIPT_DIR__ with the live path."""
    text = PLIST.read_text(encoding="utf-8")
    assert "__SCRIPT_DIR__" in text


def test_plist_has_home_placeholder_for_logs():
    text = PLIST.read_text(encoding="utf-8")
    assert "__HOME__" in text
