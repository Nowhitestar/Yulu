"""Wave-0 conformance + precedence scaffold for the macOS ``yulu_platform`` arm.

Darwin-gated: the macOS impls shell out to ``launchctl`` and read macOS-shaped
paths, so the behavioral assertions only run on Darwin. On every other OS the
module still imports and collects — the tests just skip — so CI on Linux never
errors at collection time.

This is the Wave-0 scaffold (RESEARCH §544-546): RED now (impls don't exist),
GREEN after Tasks 2-3 land ``MacOSPathResolver`` / ``MacOSDaemonManager``.
"""

import platform
import plistlib
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "yulu" / "scripts"))

from yulu_platform import base  # noqa: E402

pytestmark = pytest.mark.skipif(
    platform.system() != "Darwin", reason="macOS arm requires Darwin"
)


def test_daemon_manager_conformance():
    from yulu_platform.macos import MacOSDaemonManager

    assert issubclass(MacOSDaemonManager, base.DaemonManager)
    mgr = MacOSDaemonManager()  # every abstractmethod implemented → no TypeError
    assert mgr.status("com.yulu.nonexistent.xyz") in {"running", "stopped", "unknown"}


def test_daemon_manager_install_writes_plist(tmp_path, monkeypatch):
    from yulu_platform.macos import MacOSDaemonManager

    # Redirect LaunchAgents into a tmp dir so the test never touches the real one.
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    mgr = MacOSDaemonManager()
    spec = base.ServiceSpec(
        name="com.yulu.testjob",
        program=["python3", "-m", "stt_daemon"],
        keep_alive=True,
    )
    mgr.install(spec)
    written = tmp_path / "Library/LaunchAgents/com.yulu.testjob.plist"
    assert written.is_file()
    with written.open("rb") as fh:
        rendered = plistlib.load(fh)
    assert rendered["Label"] == "com.yulu.testjob"


def test_path_resolver_conformance():
    from yulu_platform.macos import MacOSPathResolver

    assert issubclass(MacOSPathResolver, base.PathResolver)
    resolver = MacOSPathResolver()
    assert isinstance(resolver.config_dir(), Path)
    assert isinstance(resolver.data_dir(), Path)
    assert isinstance(resolver.runtime_dir(), Path)


def test_path_resolver_precedence(tmp_path, monkeypatch):
    from yulu_platform.macos import MacOSPathResolver

    resolver = MacOSPathResolver()

    # --- config_dir / runtime_dir: env beats default ---
    env_config = tmp_path / "envconfig"
    monkeypatch.setenv("YULU_CONFIG_DIR", str(env_config))
    monkeypatch.delenv("YULU_OUTPUT_DIR", raising=False)
    assert resolver.config_dir() == env_config
    assert resolver.runtime_dir() == env_config

    monkeypatch.delenv("YULU_CONFIG_DIR", raising=False)
    # default config dir (no env) — must be ~/.config/yulu
    assert resolver.config_dir() == Path.home() / ".config/yulu"

    # --- data_dir precedence: env → config.json → default ---
    # 1. env wins
    env_out = tmp_path / "envout"
    monkeypatch.setenv("YULU_OUTPUT_DIR", str(env_out))
    assert resolver.data_dir() == env_out
    monkeypatch.delenv("YULU_OUTPUT_DIR", raising=False)

    # 2. config.json audio.output_dir wins over default (point config_dir at tmp)
    cfg_home = tmp_path / "cfghome"
    cfg_dir = cfg_home / ".config/yulu"
    cfg_dir.mkdir(parents=True)
    monkeypatch.setenv("YULU_CONFIG_DIR", str(cfg_dir))
    custom_out = tmp_path / "custom_recordings"
    (cfg_dir / "config.json").write_text(
        '{"audio": {"output_dir": "%s"}}' % custom_out, encoding="utf-8"
    )
    assert resolver.data_dir() == custom_out

    # config.json with ~/ prefix expands against home
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: cfg_home))
    (cfg_dir / "config.json").write_text(
        '{"audio": {"output_dir": "~/MyMovies/Yulu"}}', encoding="utf-8"
    )
    assert resolver.data_dir() == cfg_home / "MyMovies/Yulu"

    # 3. empty output_dir → default ~/Movies/Yulu (no raise)
    (cfg_dir / "config.json").write_text(
        '{"audio": {"output_dir": ""}}', encoding="utf-8"
    )
    assert resolver.data_dir() == cfg_home / "Movies/Yulu"


def test_path_resolver_missing_config_falls_back(tmp_path, monkeypatch):
    """A missing/unparseable config.json must yield the default, never raise."""
    from yulu_platform.macos import MacOSPathResolver

    resolver = MacOSPathResolver()
    fake_home = tmp_path / "nohome"
    fake_home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))
    monkeypatch.delenv("YULU_CONFIG_DIR", raising=False)
    monkeypatch.delenv("YULU_OUTPUT_DIR", raising=False)
    # No config.json on disk → default.
    assert resolver.data_dir() == fake_home / "Movies/Yulu"


# --- Wave-2 seams: PermissionModel + DependencyManager (PLAT-05 / D-08) ---

_NEUTRAL_STATUS = {"granted", "denied", "unknown"}


def test_permission_model_conformance(tmp_path, monkeypatch):
    """MacOSPermissionModel subclasses the frozen ABC, constructs, and returns
    only neutral status strings — for known tokens AND an unknown one (never raises)."""
    from yulu_platform.macos import MacOSPermissionModel

    assert issubclass(MacOSPermissionModel, base.PermissionModel)
    model = MacOSPermissionModel()  # every abstractmethod implemented → no TypeError

    # Point the socket at a path that does not exist so the probe fails cleanly
    # (no live daemon required in CI) → must degrade to "unknown", never raise.
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))

    for token in ("microphone", "system-audio-capture", "bogus-token"):
        status = model.check(token)
        assert isinstance(status, str)
        assert status in _NEUTRAL_STATUS, f"{token!r} → {status!r} not neutral"


def test_dependency_manager_conformance():
    """MacOSDependencyManager subclasses the frozen ABC, constructs, and
    is_available returns a bool without raising even for an absent formula."""
    from yulu_platform.macos import MacOSDependencyManager

    assert issubclass(MacOSDependencyManager, base.DependencyManager)
    mgr = MacOSDependencyManager()  # every abstractmethod implemented → no TypeError

    result = mgr.is_available("definitely-not-a-formula-xyz")
    assert isinstance(result, bool)  # absent formula → False, never an exception


# --- Task 2: read-side callers route through the seams (source-static gate) ---
# These assertions run on every OS (not Darwin-gated) — they read the caller
# source text and prove the inline TCC/brew coupling has moved behind the seam,
# without shelling out to launchctl/brew (mirrors tests/test_status_agent_config.py).

_SCRIPTS = ROOT / "yulu" / "scripts"


def test_repair_permissions_routes_reset_through_seam():
    """repair_permissions.py no longer carries the inline ``tccutil reset
    ScreenCapture`` list-form call — it routes through MacOSPermissionModel.reset."""
    src = (_SCRIPTS / "repair_permissions.py").read_text(encoding="utf-8")
    # The inline list-form subprocess call with the TCC scope literal must be gone.
    assert '"tccutil", "reset", "ScreenCapture"' not in src, (
        "repair_permissions still calls tccutil reset ScreenCapture inline; "
        "it must route through MacOSPermissionModel().reset(...)"
    )
    # And it must actually consume the seam.
    assert "MacOSPermissionModel" in src, (
        "repair_permissions must route the reset through MacOSPermissionModel"
    )


def test_doctor_routes_dependency_presence_through_seam():
    """doctor.py references the DependencyManager seam for dependency presence."""
    src = (_SCRIPTS / "doctor.py").read_text(encoding="utf-8")
    assert "MacOSDependencyManager" in src and "is_available" in src, (
        "doctor.py must route brew-managed dependency presence through "
        "MacOSDependencyManager.is_available"
    )


def test_install_pipeline_untouched_by_seam_routing():
    """The macOS-only install pipeline stays intact (coexist, not rip-out):
    neither caller imports/rewires dev_install, and setup.sh is not referenced."""
    repair = (_SCRIPTS / "repair_permissions.py").read_text(encoding="utf-8")
    doctor = (_SCRIPTS / "doctor.py").read_text(encoding="utf-8")
    for src, who in ((repair, "repair_permissions.py"), (doctor, "doctor.py")):
        assert "dev_install" not in src, (
            f"{who} must not rewire dev_install this milestone (coexist, not rip-out)"
        )
