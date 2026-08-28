import importlib.util
import json
import os
from pathlib import Path
import subprocess
from urllib.error import URLError

ROOT = Path(__file__).resolve().parents[1]
DOCTOR = ROOT / "yulu" / "scripts" / "doctor.py"


def load_doctor():
    spec = importlib.util.spec_from_file_location("doctor", DOCTOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _JsonResponse:
    def __init__(self, payload):
        self.payload = payload
        self.status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, *_args):
        return json.dumps(self.payload).encode("utf-8")


def test_agent_connection_diagnostics_whitelist_current_history_and_remediation(monkeypatch):
    doctor = load_doctor()
    host_view = {
        "result": {"data": {
            "connections": [{
                "id": "codex",
                "kind": "supported-agent",
                "adapter": "codex",
                "label": "Codex",
                "lifecycle": "connected",
                "authorization": {
                    "connected": True,
                    "credentialSource": "runtime-oauth",
                    "authorizationClass": "chatgpt",
                    "runtimeVersion": "0.144.4",
                    "minimumVersion": "0.144.0",
                    "supported": True,
                    "features": ["account/read", "model/list", "thread/start"],
                    "remediation": "Run codex login; api_key=never-report-this",
                    "rawToken": "never-report-this",
                },
                "capabilities": [{
                    "capability": "summary",
                    "declared": True,
                    "selected": True,
                    "currentReadiness": {
                        "status": "untested",
                        "model": "gpt-5.6-sol",
                        "testedAt": None,
                        "detail": "Not tested in this Host process",
                        "credentialSource": None,
                        "prompt": "never-report-this",
                    },
                    "readinessHistory": [{
                        "status": "ready",
                        "model": "gpt-5.6-sol",
                        "credentialSource": "runtime-oauth",
                        "reason": None,
                        "testedAt": "2026-08-28T01:00:00.000Z",
                        "runtimeEvidence": {
                            "adapter": "codex",
                            "transport": "codex-app-server-stdio",
                            "runtimeVersion": "0.144.4",
                            "authorizationClass": "chatgpt",
                            "requestedProvider": "openai",
                            "requestedModel": "gpt-5.6-sol",
                            "actualProvider": "openai",
                            "actualModel": "gpt-5.6-sol",
                            "terminalStatus": "ready",
                            "fallbackOccurred": False,
                            "token": "never-report-this",
                            "responseBody": "never-report-this",
                        },
                    }],
                    "remediation": {"href": "/settings/llm?connection=codex&capability=summary"},
                }],
                "settings": {"executablePath": "/private/user/bin/codex", "token": "never-report-this"},
            }],
            "candidates": [],
            "legacyConnections": [],
        }},
    }
    monkeypatch.setattr(
        "urllib.request.urlopen",
        lambda *_args, **_kwargs: _JsonResponse(host_view),
    )

    report = doctor.check_agent_connections()

    assert report["ok"] is True
    assert report["source"] == "host-public-projection"
    assert report["connections"] == [{
        "id": "codex",
        "kind": "supported-agent",
        "adapter": "codex",
        "label": "Codex",
        "lifecycle": "connected",
        "authorization": {
            "connected": True,
            "credential_source": "runtime-oauth",
            "authorization_class": "chatgpt",
        },
        "compatibility": {
            "runtime_version": "0.144.4",
            "minimum_version": "0.144.0",
            "target_version": None,
            "version_source": None,
            "supported": True,
            "features": ["account/read", "model/list", "thread/start"],
        },
        "capabilities": [{
            "capability": "summary",
            "declared": True,
            "selected": True,
            "current_readiness": {
                "status": "untested",
                "model": "gpt-5.6-sol",
                "tested_at": None,
                "credential_source": None,
                "reason": None,
            },
            "readiness_history": [{
                "status": "ready",
                "model": "gpt-5.6-sol",
                "credential_source": "runtime-oauth",
                "reason": None,
                "tested_at": "2026-08-28T01:00:00.000Z",
                "runtime_evidence": {
                    "adapter": "codex",
                    "transport": "codex-app-server-stdio",
                    "runtime_version": "0.144.4",
                    "authorization_class": "chatgpt",
                    "requested_provider": "openai",
                    "requested_model": "gpt-5.6-sol",
                    "actual_provider": "openai",
                    "actual_model": "gpt-5.6-sol",
                    "terminal_status": "ready",
                    "fallback_occurred": False,
                    "tools_enabled": None,
                    "cancellation_requested": None,
                    "cancellation_confirmed": None,
                },
            }],
            "remediation": "/settings/llm?connection=codex&capability=summary",
        }],
        "remediation": "/settings/llm?connection=codex",
    }]
    serialized = json.dumps(report)
    assert "never-report-this" not in serialized
    assert "executablePath" not in serialized
    assert "rawToken" not in serialized


def test_agent_connection_diagnostics_projects_adapter_contracts_and_history_source(monkeypatch):
    doctor = load_doctor()
    host_view = {
        "result": {"data": {
            "connections": [
                {
                    "id": "direct-xai",
                    "kind": "direct-provider",
                    "adapter": "direct-xai",
                    "label": "secret-looking-label-must-not-pass-through",
                    "lifecycle": "connected",
                    "authorization": {
                        "connected": True,
                        "credentialSource": "oauth",
                        "runtimeVersion": None,
                        "minimumVersion": None,
                        "compatibilityTarget": "xai-api",
                        "versionSource": "not-applicable",
                        "supported": True,
                        "features": ["transcription", "summary", "conversation", "no-provider-fallback"],
                    },
                    "capabilities": [],
                },
            ],
            "candidates": [],
            "legacyConnections": [],
        }},
    }
    monkeypatch.setattr("urllib.request.urlopen", lambda *_args, **_kwargs: _JsonResponse(host_view))

    report = doctor.check_agent_connections()

    [direct] = report["connections"]
    assert direct["label"] == "xAI"
    assert direct["compatibility"] == {
        "runtime_version": None,
        "minimum_version": None,
        "target_version": "xai-api",
        "version_source": "not-applicable",
        "supported": True,
        "features": ["transcription", "summary", "conversation", "no-provider-fallback"],
    }
    serialized = json.dumps(report)
    assert "secret-looking-label" not in serialized


def test_agent_connection_diagnostics_rejects_unrecognized_authorization_classes():
    doctor = load_doctor()

    evidence = doctor._runtime_evidence_projection({
        "authorizationClass": "chatgpt;token=never-report-this",
    })
    connection = doctor._connection_projection({
        "id": "codex",
        "kind": "supported-agent",
        "adapter": "codex",
        "authorization": {
            "connected": False,
            "credentialSource": "runtime-oauth",
            "authorizationClass": "api-key:never-report-this",
        },
        "capabilities": [],
    })

    assert "authorization_class" not in evidence
    assert "authorization_class" not in connection["authorization"]
    assert "never-report-this" not in json.dumps({"evidence": evidence, "connection": connection})


def test_agent_connection_diagnostics_fail_closed_without_host(monkeypatch):
    doctor = load_doctor()
    monkeypatch.setattr(
        "urllib.request.urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(URLError("offline token=never-report-this")),
    )

    report = doctor.check_agent_connections()

    assert report == {
        "ok": False,
        "source": "host-public-projection",
        "connections": [],
        "candidates": [],
        "legacy_connections": [],
        "error": "Agent Connection diagnostics are unavailable from the local Host",
        "remediation": "/settings/llm",
    }
    assert "never-report-this" not in json.dumps(report)


def test_agent_connection_diagnostics_allow_runtime_status_inspection_budget(monkeypatch):
    doctor = load_doctor()
    observed = {}

    def fake_urlopen(_url, *, timeout):
        observed["timeout"] = timeout
        return _JsonResponse({
            "result": {"data": {
                "connections": [],
                "candidates": [],
                "legacyConnections": [],
            }},
        })

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    assert doctor.check_agent_connections()["ok"] is True
    assert observed["timeout"] == 30.0


def test_doctor_process_projection_never_returns_command_arguments():
    doctor = load_doctor()
    raw = [
        "user 123 0.0 0.1 1 2 ?? S 10:00AM 0:00.01 /Users/user/.yulu/yulu/scripts/server --mcp-token never-report-this",
        "user 456 0.0 0.1 1 2 ?? S 10:00AM 0:00.01 /Users/user/legacy/yulu/server --api-key never-report-this",
    ]

    projected = doctor._safe_process_projection(
        raw,
        runtime_root=Path("/Users/user/.yulu"),
        legacy_root=Path("/Users/user/legacy/yulu"),
    )

    assert projected == [
        {"pid": 123, "executable": "server", "scope": "runtime"},
        {"pid": 456, "executable": "server", "scope": "legacy"},
    ]
    assert "never-report-this" not in json.dumps(projected)


def test_collect_report_includes_host_agent_connection_diagnostics(tmp_path, monkeypatch):
    doctor = load_doctor()
    expected = {
        "ok": True,
        "source": "host-public-projection",
        "connections": [],
        "candidates": [],
        "legacy_connections": [],
        "error": None,
        "remediation": None,
    }
    monkeypatch.setattr(doctor, "_yulu_processes", lambda: [])
    monkeypatch.setattr(doctor, "_git_info", lambda _root: {"is_repo": True})
    monkeypatch.setattr(doctor, "_install_info", lambda _root: {"present": False})
    monkeypatch.setattr(doctor, "_check_command", lambda name, args=None: {
        "name": name, "ok": False, "path": "",
    })
    monkeypatch.setattr(doctor, "_socket_status", lambda _path: {"exists": False})
    monkeypatch.setattr(doctor, "check_search_index", lambda _config: {"ok": False})
    monkeypatch.setattr(doctor, "check_yulu_ui", lambda *_args: {"healthz_ok": True})
    monkeypatch.setattr(doctor, "check_agent_connections", lambda: expected)
    monkeypatch.setattr(doctor, "_host_capabilities", lambda *_args: {})

    report = doctor.collect_report(
        source_root=ROOT,
        runtime_root=tmp_path,
        legacy_root=tmp_path / "legacy",
        config_dir=tmp_path / "config",
    )

    assert report["agent_connections"] == expected


def test_human_doctor_distinguishes_current_readiness_from_history(capsys):
    doctor = load_doctor()
    report = {
        "source_root": "/runtime",
        "source_git": {"is_repo": False},
        "source_install": {"present": True, "version": "0.23.0", "source": "dev", "asset": None},
        "runtime_exists": True,
        "runtime_root": "/runtime",
        "legacy_root": "/legacy",
        "legacy_root_exists": False,
        "legacy_processes": [],
        "config_exists": True,
        "config_dir": "/config",
        "host_tasks": {},
        "socket": {"path": "/config/audio.sock", "exists": True, "ok": True},
        "checks": [],
        "agent_connections": {
            "ok": True,
            "connections": [{
                "adapter": "codex",
                "label": "Codex",
                "lifecycle": "connected",
                "compatibility": {
                    "runtime_version": "0.144.4",
                    "supported": True,
                    "features": ["model/list"],
                },
                "capabilities": [{
                    "capability": "summary",
                    "declared": True,
                    "selected": True,
                    "current_readiness": {"status": "untested"},
                    "readiness_history": [{"status": "ready"}],
                    "remediation": "/settings/llm?connection=codex&capability=summary",
                }],
                "remediation": None,
            }],
            "candidates": [],
        },
    }

    doctor.print_human(report)
    output = capsys.readouterr().out

    assert "Codex: adapter=codex actual=0.144.4 target=n/a version_source=unverified supported=True" in output
    assert "summary: declared=True selected=True current=untested history=1" in output
    assert "repair: /settings/llm?connection=codex&capability=summary" in output


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


def test_release_runtime_without_git_is_recognized_but_host_unavailability_fails_health(tmp_path, capsys):
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

    assert code == 1
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
    assert report["privacy_opt_in"]["transcription"]["owner"] == "yulu"
    assert report["privacy_opt_in"]["transcription"]["provider"] == "local"
    assert report["privacy_opt_in"]["transcription"]["yulu_executor"] is True


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
    assert report["privacy_opt_in"]["transcription"]["ok"] is True


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


def test_overall_health_fails_closed_for_unavailable_or_unverified_agent_connections():
    doctor = load_doctor()
    base = {
        "checks": [{"name": "python3", "ok": True}],
        "legacy_processes": [],
        "source_git": {"is_repo": True},
        "source_install": {"present": False},
        "agent_pipeline": {"enabled": False, "ok": True},
    }

    assert doctor._overall_ok({
        **base,
        "agent_connections": {"ok": False, "connections": []},
    }) is False
    for supported in (False, None):
        assert doctor._overall_ok({
            **base,
            "agent_connections": {
                "ok": True,
                "connections": [{"compatibility": {"supported": supported}}],
            },
        }) is False
    assert doctor._overall_ok({
        **base,
        "agent_connections": {
            "ok": True,
            "connections": [{"compatibility": {"supported": True}}],
        },
    }) is True


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
