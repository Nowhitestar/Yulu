import importlib.util
import json
from pathlib import Path

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
    assert any(check["name"] == "python3" for check in report["checks"])


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
