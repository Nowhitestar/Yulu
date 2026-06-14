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


# --- Phase 5 DATA-02: runtime_dir locked + assert_runtime_not_synced guard ---


def test_runtime_dir_locked_ignores_output_dir(tmp_path, monkeypatch):
    """runtime_dir() is machine-local and NEVER reads audio.output_dir.

    Setting audio.output_dir in config.json moves data_dir() but must NOT move
    runtime_dir() — the two diverge precisely here (D-01: runtime is locked,
    content is configurable). runtime_dir() stays == config_dir() (~/.config/yulu).
    """
    from yulu_platform.macos import MacOSPathResolver

    resolver = MacOSPathResolver()
    cfg_home = tmp_path / "cfghome"
    cfg_dir = cfg_home / ".config/yulu"
    cfg_dir.mkdir(parents=True)
    monkeypatch.setenv("YULU_CONFIG_DIR", str(cfg_dir))
    monkeypatch.delenv("YULU_OUTPUT_DIR", raising=False)

    synced_out = tmp_path / "iCloudish" / "recordings"
    (cfg_dir / "config.json").write_text(
        '{"audio": {"output_dir": "%s"}}' % synced_out, encoding="utf-8"
    )

    # data_dir() follows config; runtime_dir() does NOT.
    assert resolver.data_dir() == synced_out
    assert resolver.runtime_dir() == cfg_dir
    assert resolver.runtime_dir() == resolver.config_dir()


def _cloud_detect_or_skip():
    """Import the sibling Plan-03 detector or skip — cloud_detect.py is a
    same-wave deliverable (Plan 03); the non-degraded guard path can only be
    exercised once it lands. The degrade-to-no-op contract (Plan 01's own) is
    tested separately and does NOT need it."""
    try:
        from yulu_platform.macos import cloud_detect
    except Exception:  # pragma: no cover - sibling plan not landed yet
        pytest.skip("yulu_platform.macos.cloud_detect (Plan 03) not landed yet")
    return cloud_detect


def test_assert_runtime_not_synced_local_is_noop(tmp_path, monkeypatch):
    """A normal machine-local runtime dir → assert returns None (no raise)."""
    from yulu_platform.macos import MacOSPathResolver

    _cloud_detect_or_skip()
    resolver = MacOSPathResolver()
    local_runtime = tmp_path / "localcfg"
    local_runtime.mkdir()
    monkeypatch.setenv("YULU_CONFIG_DIR", str(local_runtime))
    # is_cloud_root on a plain tmp path → not cloud → no raise.
    assert resolver.assert_runtime_not_synced() is None


def test_assert_runtime_not_synced_rejects_cloud_root(tmp_path, monkeypatch):
    """When runtime_dir() resolves under a detected cloud-sync root, the guard
    raises RuntimeError whose message names the cloud reason (D-01 hard lock)."""
    from yulu_platform.macos import MacOSPathResolver

    cloud_detect = _cloud_detect_or_skip()
    resolver = MacOSPathResolver()
    # Point the runtime dir under a faked iCloud Drive root and force the
    # detector to classify that prefix as cloud (independent of real on-disk
    # cloud state, so the test is hermetic on any Mac).
    fake_home = tmp_path / "home"
    icloud = fake_home / "Library/Mobile Documents/com~apple~CloudDocs/yulu"
    icloud.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))
    monkeypatch.setenv("YULU_CONFIG_DIR", str(icloud))

    def fake_is_cloud_root(path):
        return cloud_detect.CloudRootResult(
            True, "icloud", "iCloud Drive (test)", False
        )

    monkeypatch.setattr(cloud_detect, "is_cloud_root", fake_is_cloud_root)

    with pytest.raises(RuntimeError) as exc:
        resolver.assert_runtime_not_synced()
    msg = str(exc.value)
    assert "iCloud" in msg or "cloud" in msg.lower()
    # Framed as machine-local corruption/eviction safety, never "impossible".
    assert "machine-local" in msg.lower()
    assert "impossible" not in msg.lower()


def test_assert_runtime_not_synced_noop_when_detector_unimportable(
    tmp_path, monkeypatch
):
    """If yulu_platform.macos.cloud_detect cannot be imported (sibling Plan 03
    not landed / off-platform), the guard degrades to a no-op — never raises.

    Simulated by making the lazy `import cloud_detect` fail via a meta-path
    finder that blocks just that module.
    """
    import builtins

    from yulu_platform.macos import MacOSPathResolver

    resolver = MacOSPathResolver()
    local_runtime = tmp_path / "cfg"
    local_runtime.mkdir()
    monkeypatch.setenv("YULU_CONFIG_DIR", str(local_runtime))

    real_import = builtins.__import__

    def blocked_import(name, *args, **kwargs):
        if "cloud_detect" in name:
            raise ImportError("simulated: cloud_detect unavailable")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked_import)
    # Must not raise even though the detector import fails.
    assert resolver.assert_runtime_not_synced() is None


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


def test_dependency_manager_is_available_brew_timeout_falls_back(monkeypatch):
    """A slow Homebrew read must not hang doctor.py; fall back to PATH lookup."""
    from yulu_platform.macos import dependency_manager as dm

    calls = []

    def fake_which(name):
        return "/opt/homebrew/bin/brew" if name == dm._BREW else None

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        raise dm.subprocess.TimeoutExpired(cmd, kwargs["timeout"])

    monkeypatch.setattr(dm.shutil, "which", fake_which)
    monkeypatch.setattr(dm.subprocess, "run", fake_run)

    assert dm.MacOSDependencyManager().is_available("swiftc") is False
    assert calls == [
        (
            [dm._BREW, "list", "swiftc"],
            {
                "capture_output": True,
                "text": True,
                "check": False,
                "timeout": dm._BREW_DETECT_TIMEOUT_SECONDS,
            },
        )
    ]


def test_dependency_manager_is_available_path_hit_skips_brew(monkeypatch):
    """PATH-visible tools should not pay a Homebrew probe."""
    from yulu_platform.macos import dependency_manager as dm

    def fake_which(name):
        return f"/usr/bin/{name}" if name == "swiftc" else "/opt/homebrew/bin/brew"

    def fail_run(*args, **kwargs):
        raise AssertionError("brew list should not run when PATH already finds the tool")

    monkeypatch.setattr(dm.shutil, "which", fake_which)
    monkeypatch.setattr(dm.subprocess, "run", fail_run)

    assert dm.MacOSDependencyManager().is_available("swiftc") is True


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
