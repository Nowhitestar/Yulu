import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEV_INSTALL = ROOT / "yulu" / "scripts" / "dev_install.py"


def load_dev_install():
    spec = importlib.util.spec_from_file_location("dev_install", DEV_INSTALL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_render_plist_replaces_placeholders(tmp_path):
    dev_install = load_dev_install()
    source = tmp_path / "source.plist"
    source.write_text(
        "__PYTHON__|__NODE_BIN__|__HOME__|__SCRIPT_DIR__|__PATH__",
        encoding="utf-8",
    )

    rendered = dev_install.render_plist(
        source,
        script_dir=Path("/tmp/yulu/scripts"),
        python_bin="/usr/bin/python3",
        node_bin="/opt/homebrew/bin/node",
        home=Path("/Users/example"),
        launch_path="/opt/homebrew/bin:/usr/bin:/bin",
    )

    assert rendered == "/usr/bin/python3|/opt/homebrew/bin/node|/Users/example|/tmp/yulu/scripts|/opt/homebrew/bin:/usr/bin:/bin"


def test_plan_includes_launchagent_destinations(tmp_path):
    dev_install = load_dev_install()
    source_root = ROOT
    runtime_root = tmp_path / "runtime"
    config_dir = tmp_path / "config"

    data = dev_install.plan(source_root, runtime_root, config_dir)

    assert data["source_root"] == str(source_root)
    assert data["runtime_root"] == str(runtime_root)
    assert any(item["dest"].endswith("com.yulu.audiodaemon.plist") for item in data["launchagents"])
    assert any(item["dest"].endswith("com.yulu.ui.plist") for item in data["launchagents"])
    assert data["recording"] is False


def test_preferred_python_avoids_conda_when_homebrew_python_exists():
    dev_install = load_dev_install()
    preferred = dev_install.preferred_python()

    if Path("/opt/homebrew/bin/python3").exists():
        assert preferred == "/opt/homebrew/bin/python3"
    else:
        assert preferred.endswith("python3")


def test_preferred_node_uses_an_existing_binary_when_available():
    dev_install = load_dev_install()
    preferred = Path(dev_install.preferred_node())

    if any(Path(p).exists() for p in ("/opt/homebrew/bin/node", "/usr/local/bin/node")) or (Path.home() / ".nvm/versions/node").exists():
        assert preferred.exists()
    assert preferred.name == "node"


def test_apply_builds_ui_dist_before_copying_runtime(tmp_path, monkeypatch):
    dev_install = load_dev_install()
    calls = []

    monkeypatch.setattr(dev_install, "plan", lambda *args: {"recording": False})
    monkeypatch.setattr(dev_install, "_build_ui_dist", lambda source_root: calls.append("build"))
    monkeypatch.setattr(dev_install, "_copy_runtime_items", lambda source_root, runtime_root: calls.append("copy"))
    monkeypatch.setattr(dev_install, "_compile_helpers", lambda script_dir: calls.append("compile"))
    monkeypatch.setattr(dev_install, "_kill_legacy_processes", lambda legacy_root: calls.append("kill"))
    monkeypatch.setattr(dev_install, "_install_launchagents", lambda script_dir, *, python_bin: calls.append("launchagents"))
    monkeypatch.setattr(dev_install, "_install_cli", lambda script_dir: calls.append("cli"))

    dev_install.apply(
        tmp_path / "source",
        tmp_path / "runtime",
        tmp_path / "config",
        tmp_path / "legacy",
        "/usr/bin/python3",
    )

    assert calls[:2] == ["build", "copy"]
