import importlib.util
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
DOCTOR = ROOT / "yulu" / "scripts" / "doctor.py"


def load_doctor():
    spec = importlib.util.spec_from_file_location("doctor", DOCTOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_collect_report_identifies_source_runtime_and_legacy_paths():
    doctor = load_doctor()

    report = doctor.collect_report(
        source_root=ROOT,
        runtime_root=ROOT,
        legacy_root=ROOT / "does-not-exist",
        config_dir=ROOT / "does-not-exist-config",
    )

    assert report["source_root"] == str(ROOT)
    assert report["source_git"]["is_repo"] is True
    assert report["runtime_root"] == str(ROOT)
    assert report["runtime_exists"] is True
    assert report["legacy_root_exists"] is False
    assert "checks" in report
    assert "agent_pipeline" in report
    assert any(check["name"] == "python3" for check in report["checks"])
    assert any(check["name"] == "hermes" for check in report["checks"])


def test_collect_report_does_not_run_swiftc_version(tmp_path, monkeypatch):
    doctor = load_doctor()
    calls = []

    def fake_check_command(name, args=None):
        calls.append((name, args))
        return {"name": name, "ok": True, "path": f"/usr/bin/{name}"}

    monkeypatch.setattr(doctor, "_yulu_processes", lambda: [])
    monkeypatch.setattr(doctor, "_git_info", lambda root: {"is_repo": True})
    monkeypatch.setattr(doctor, "_install_info", lambda root: {"present": False})
    monkeypatch.setattr(doctor, "_check_command", fake_check_command)
    monkeypatch.setattr(doctor, "_socket_status", lambda path: {"exists": False})
    monkeypatch.setattr(doctor, "check_search_index", lambda config_dir: {"ok": False})
    monkeypatch.setattr(doctor, "check_yulu_ui", lambda script_dir, config_dir: {"ok": False})
    monkeypatch.setattr(doctor, "_host_capabilities", lambda config_dir, runtime_root: {"schema_version": 1, "capabilities": {}})

    doctor.collect_report(
        source_root=ROOT,
        runtime_root=tmp_path,
        legacy_root=tmp_path / "missing-legacy",
        config_dir=tmp_path / "cfg",
    )

    assert ("swiftc", None) in calls
    assert all(not (name == "swiftc" and args) for name, args in calls)


def test_main_prints_json_report(capsys):
    doctor = load_doctor()

    code = doctor.main([
        "--json",
        "--source-root", str(ROOT),
        "--runtime-root", str(ROOT),
        "--legacy-root", str(ROOT / "missing-legacy"),
        "--config-dir", str(ROOT / "missing-config"),
    ])

    assert code in (0, 1)
    data = json.loads(capsys.readouterr().out)
    assert data["source_root"] == str(ROOT)
    assert data["legacy_root_exists"] is False


def test_yulu_wrapper_passes_doctor_args(tmp_path):
    env = os.environ.copy()
    env["HOME"] = str(tmp_path / "home")
    result = subprocess.run(
        [
            "bash",
            str(ROOT / "yulu" / "scripts" / "yulu"),
            "doctor",
            "--json",
            "--source-root", str(ROOT),
            "--runtime-root", str(ROOT),
            "--legacy-root", str(tmp_path / "missing-legacy"),
            "--config-dir", str(tmp_path / "missing-config"),
        ],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode in (0, 1), result.stderr + result.stdout
    data = json.loads(result.stdout)
    assert data["source_root"] == str(ROOT)
    assert data["legacy_root_exists"] is False


def test_release_runtime_without_git_is_healthy_source(tmp_path, capsys):
    doctor = load_doctor()
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / ".yulu-install.json").write_text(
        json.dumps({"schema": 1, "source": "release", "version": "v9.9.9", "asset": "yulu.zip"}),
        encoding="utf-8",
    )

    code = doctor.main([
        "--json",
        "--source-root", str(runtime),
        "--runtime-root", str(runtime),
        "--legacy-root", str(tmp_path / "missing-legacy"),
        "--config-dir", str(tmp_path / "missing-config"),
    ])

    assert code == 0
    data = json.loads(capsys.readouterr().out)
    assert data["source_git"]["is_repo"] is False
    assert data["source_install"]["present"] is True
    assert data["source_install"]["version"] == "v9.9.9"


def test_retired_stt_daemon_section_is_absent(tmp_path):
    doctor = load_doctor()
    report = doctor.collect_report(
        source_root=ROOT,
        runtime_root=ROOT,
        legacy_root=ROOT / "missing-legacy",
        config_dir=tmp_path,
    )
    assert "stt_daemon" not in report
    assert report["privacy_opt_in"]["transcription"]["owner"] == "agent"
    assert report["privacy_opt_in"]["transcription"]["yulu_executor"] is False


def test_privacy_opt_in_section_flags_disabled_agent_pipeline(tmp_path):
    doctor = load_doctor()
    (tmp_path / "config.json").write_text(
        '{"agent_pipeline": {"enabled": false}}',
        encoding="utf-8",
    )

    report = doctor.collect_report(
        source_root=ROOT,
        runtime_root=ROOT,
        legacy_root=ROOT / "missing-legacy",
        config_dir=tmp_path,
    )

    assert report["privacy_opt_in"]["ok"] is False
    assert report["privacy_opt_in"]["transcription"]["ok"] is False


def test_agent_pipeline_health_is_ok_when_required_runtime_is_ready(tmp_path):
    doctor = load_doctor()
    (tmp_path / "config.json").write_text(
        '{"agent_pipeline": {"enabled": true}}', encoding="utf-8"
    )
    token = tmp_path / "mcp-token.json"
    token.write_text('{"token": "abcdefghijklmnopqrstuvwxyz012345"}', encoding="utf-8")
    token.chmod(0o600)

    report = doctor.check_agent_pipeline(
        tmp_path,
        [
            {"name": "hermes", "ok": True, "path": "/bin/hermes", "version": "1"},
            {"name": "ffmpeg", "ok": True, "path": "/bin/ffmpeg", "version": "1"},
        ],
        {"healthz_ok": True, "port": 7777},
    )

    assert report["enabled"] is True
    assert report["ok"] is True
    assert report["reasons"] == []
    assert report["components"]["mcp_token"]["mode"] == "0600"


def test_enabled_agent_pipeline_fails_closed_when_runtime_is_unavailable(tmp_path):
    doctor = load_doctor()
    (tmp_path / "config.json").write_text(
        '{"agent_pipeline": {"enabled": true}}', encoding="utf-8"
    )

    pipeline = doctor.check_agent_pipeline(
        tmp_path,
        [
            {"name": "hermes", "ok": False, "path": ""},
            {"name": "ffmpeg", "ok": True, "path": "/bin/ffmpeg"},
        ],
        {"healthz_ok": False, "port": 7777, "error": "down"},
    )

    assert pipeline["ok"] is False
    assert set(pipeline["reasons"]) == {"hermes_cli", "mcp_token", "ui_healthz"}
    assert doctor._overall_ok({
        "checks": [{"name": "python3", "ok": True}],
        "legacy_processes": [],
        "source_git": {"is_repo": True},
        "source_install": {"present": False},
        "agent_pipeline": pipeline,
    }) is False


def test_hermes_contract_probes_required_command_surfaces(monkeypatch):
    doctor = load_doctor()
    outputs = {
        ("serve", "--help"): "--port --host --skip-build",
        ("sessions", "export", "--help"): "--session-id output",
        ("config", "set", "--help"): "key value",
        ("--help",): "--toolsets",
    }

    def fake_run(cmd, timeout=5, cwd=None):
        return 0, outputs[tuple(cmd[1:])], ""

    monkeypatch.setattr(doctor, "_run", fake_run)

    contract = doctor.check_hermes_cli_contract("/opt/hermes/bin/hermes")

    assert contract["ok"] is True
    assert contract["required"] == ["serve", "sessions_export", "config_set", "toolsets"]
    assert all(probe["ok"] for probe in contract["probes"].values())


def test_hermes_contract_reports_incompatible_sessions_export(monkeypatch):
    doctor = load_doctor()

    def fake_run(cmd, timeout=5, cwd=None):
        if cmd[1:3] == ["sessions", "export"]:
            return 2, "", "unknown command"
        return 0, "--port --host --skip-build --session-id output key value --toolsets", ""

    monkeypatch.setattr(doctor, "_run", fake_run)

    contract = doctor.check_hermes_cli_contract("/opt/hermes/bin/hermes")

    assert contract["ok"] is False
    assert contract["missing"] == ["sessions_export"]


def test_hermes_phase_registration_requires_both_enabled_capability_servers(monkeypatch):
    doctor = load_doctor()
    output = """
      Name             Transport                      Tools        Status
      yulu_artifact    http://127.0.0.1:7777/mcp...   all          ✓ enabled
      yulu_delivery    http://127.0.0.1:7777/mcp...   all          ✓ enabled
    """
    monkeypatch.setattr(doctor, "_run", lambda *_a, **_k: (0, output, ""))
    assert doctor.check_hermes_phase_registration("/opt/hermes/bin/hermes")["ok"] is True

    missing_delivery = output.replace(
        "yulu_delivery    http://127.0.0.1:7777/mcp...   all          ✓ enabled",
        "yulu_delivery    http://127.0.0.1:7777/mcp...   all          disabled",
    )
    monkeypatch.setattr(doctor, "_run", lambda *_a, **_k: (0, missing_delivery, ""))
    result = doctor.check_hermes_phase_registration("/opt/hermes/bin/hermes")
    assert result["ok"] is False
    assert result["missing"] == ["yulu_delivery"]


def test_agent_pipeline_fails_when_hermes_contract_is_incompatible(tmp_path):
    doctor = load_doctor()
    (tmp_path / "config.json").write_text(
        '{"agent_pipeline": {"enabled": true}}', encoding="utf-8"
    )
    token = tmp_path / "mcp-token.json"
    token.write_text('{"token": "abcdefghijklmnopqrstuvwxyz012345"}', encoding="utf-8")
    token.chmod(0o600)

    pipeline = doctor.check_agent_pipeline(
        tmp_path,
        [
            {"name": "hermes", "ok": True, "path": "/bin/hermes"},
            {"name": "ffmpeg", "ok": True, "path": "/bin/ffmpeg"},
        ],
        {"healthz_ok": True, "port": 7777},
        hermes_contract={"ok": False, "probed": True, "missing": ["serve"]},
    )

    assert pipeline["ok"] is False
    assert pipeline["reasons"] == ["hermes_contract"]


def test_agent_pipeline_fails_when_phase_mcp_registration_is_missing(tmp_path):
    doctor = load_doctor()
    (tmp_path / "config.json").write_text(
        '{"agent_pipeline": {"enabled": true}}', encoding="utf-8"
    )
    token = tmp_path / "mcp-token.json"
    token.write_text('{"token": "abcdefghijklmnopqrstuvwxyz012345"}', encoding="utf-8")
    token.chmod(0o600)
    pipeline = doctor.check_agent_pipeline(
        tmp_path,
        [
            {"name": "hermes", "ok": True, "path": "/bin/hermes"},
            {"name": "ffmpeg", "ok": True, "path": "/bin/ffmpeg"},
        ],
        {"healthz_ok": True, "port": 7777},
        hermes_phase_registration={"ok": False, "probed": True, "missing": ["yulu_delivery"]},
    )
    assert pipeline["ok"] is False
    assert pipeline["reasons"] == ["hermes_phase_mcp"]


def test_disabled_agent_pipeline_does_not_fail_overall_health(tmp_path):
    doctor = load_doctor()
    (tmp_path / "config.json").write_text(
        '{"agent_pipeline": {"enabled": false}}', encoding="utf-8"
    )
    pipeline = doctor.check_agent_pipeline(tmp_path, [], {"healthz_ok": False})
    assert pipeline["enabled"] is False
    assert pipeline["ok"] is True


def test_search_index_section_absent_db_reports_missing(tmp_path):
    """Phase 6 F.2: doctor returns a clean 'not initialized' report when
    search.sqlite is missing rather than raising."""
    doctor = load_doctor()
    report = doctor.collect_report(
        source_root=ROOT, runtime_root=ROOT,
        legacy_root=ROOT / "missing-legacy",
        config_dir=tmp_path,
    )
    assert "search_index" in report
    si = report["search_index"]
    assert si["present"] is False
    assert si["ok"] is False
    assert "not initialized" in si.get("error", "")


def test_search_index_section_reports_health(tmp_path):
    """When search.sqlite exists and is healthy, doctor returns the
    full health dict (schema_version, total_docs, per_kind, ...)."""
    import sys as _sys
    _sys.path.insert(0, str(ROOT / "yulu" / "scripts"))
    from search.indexer import init_db, upsert_doc, KIND_MEETING_SUMMARY
    db = tmp_path / "search.sqlite"
    conn = init_db(db)
    p = tmp_path / "Plan_20260521_160000.summary.md"
    p.write_text("body", encoding="utf-8")
    upsert_doc(source_path=p, kind=KIND_MEETING_SUMMARY, conn=conn)
    conn.close()

    doctor = load_doctor()
    report = doctor.collect_report(
        source_root=ROOT, runtime_root=ROOT,
        legacy_root=ROOT / "missing-legacy",
        config_dir=tmp_path,
    )
    si = report["search_index"]
    assert si["present"] is True
    assert si["ok"] is True
    assert si["schema_version"] == "1"
    assert si["total_docs"] == 1
    assert KIND_MEETING_SUMMARY in si["per_kind"]


def test_check_yulu_ui_returns_required_keys_when_everything_missing(tmp_path, monkeypatch):
    """check_yulu_ui must always return a dict with the contract keys, even
    when nothing is installed. This lets the JSON consumer rely on the shape."""
    # Hermetic: the healthz probe hits 127.0.0.1:7777, so on a dev machine
    # where the real yulu_ui server is running it would flip healthz_ok True.
    # Stub urlopen to fail so this "nothing installed" case is deterministic.
    import urllib.error
    import urllib.request as _urllib_request
    monkeypatch.setattr(
        _urllib_request, "urlopen",
        lambda *a, **k: (_ for _ in ()).throw(urllib.error.URLError("no server (hermetic test)")),
    )
    doctor = load_doctor()
    script_dir = tmp_path / "scripts"   # contains no yulu_ui/
    config_dir = tmp_path / "config"    # contains no ui.log
    report = doctor.check_yulu_ui(script_dir, config_dir)
    for key in (
        "dist_server_present", "dist_web_present",
        "plist_installed", "launchctl_loaded",
        "port", "healthz_ok", "healthz_response",
        "log_path", "log_present", "log_size_bytes",
        "error",
    ):
        assert key in report, f"missing key {key} in {report.keys()}"
    assert report["dist_server_present"] is False
    assert report["dist_web_present"] is False
    assert report["healthz_ok"] is False
    assert report["log_present"] is False
    assert report["port"] == 7777


def test_check_yulu_ui_detects_built_artifacts(tmp_path):
    doctor = load_doctor()
    ui = tmp_path / "yulu_ui"
    (ui / "dist" / "web" / "assets").mkdir(parents=True)
    (ui / "dist" / "server.js").write_text("// built\n")
    (ui / "dist" / "web" / "index.html").write_text("<!doctype html>\n")
    report = doctor.check_yulu_ui(tmp_path, tmp_path / "config")
    assert report["dist_server_present"] is True
    assert report["dist_web_present"] is True


def test_check_yulu_ui_reads_log_size(tmp_path):
    doctor = load_doctor()
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    log = config_dir / "ui.log"
    log.write_text("line one\nline two\n")
    report = doctor.check_yulu_ui(tmp_path, config_dir)
    assert report["log_present"] is True
    assert report["log_size_bytes"] == len("line one\nline two\n")


def test_collect_report_includes_yulu_ui(tmp_path):
    """collect_report wires check_yulu_ui in. The key 'yulu_ui' must appear in the
    final report so doctor --json consumers (CI smoke) can branch on it."""
    doctor = load_doctor()
    report = doctor.collect_report(
        source_root=ROOT,
        runtime_root=ROOT,
        legacy_root=ROOT / "missing-legacy",
        config_dir=tmp_path,
    )
    assert "yulu_ui" in report
    assert "dist_server_present" in report["yulu_ui"]
