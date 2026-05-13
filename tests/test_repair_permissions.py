import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPAIR = ROOT / "yulu" / "scripts" / "repair_permissions.py"


def load_repair():
    spec = importlib.util.spec_from_file_location("repair_permissions", REPAIR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_screen_capture_settings_url_targets_privacy_pane():
    repair = load_repair()
    url = repair.screen_capture_settings_url()

    assert url.startswith("x-apple.systempreferences:")
    assert "Privacy" in url or "Screen" in url


def test_plan_describes_reset_open_and_restart_steps(tmp_path):
    repair = load_repair()
    data = repair.plan(
        app_path=tmp_path / "Yulu.app",
        plist_path=tmp_path / "com.yulu.audiodaemon.plist",
        bundle_id="com.yulu.audiodaemon",
        reset=True,
    )

    assert data["bundle_id"] == "com.yulu.audiodaemon"
    assert data["reset"] is True
    assert any("tccutil reset ScreenCapture" in step for step in data["steps"])
    assert any("System Settings" in step for step in data["steps"])
    assert any("restart" in step.lower() for step in data["steps"])
