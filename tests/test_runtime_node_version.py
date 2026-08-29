import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "packaging" / "scripts" / "runtime_node_version.py"


def run_reader(tmp_path: Path, version) -> subprocess.CompletedProcess[str]:
    lock = tmp_path / "runtime-lock.json"
    lock.write_text(json.dumps({"schema": 1, "node": {"version": version}}), encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(SCRIPT), str(lock)],
        capture_output=True,
        text=True,
        check=False,
    )


def test_runtime_node_version_emits_only_an_exact_release_semver(tmp_path: Path):
    result = run_reader(tmp_path, "24.20.0")

    assert result.returncode == 0, result.stderr
    assert result.stdout == "24.20.0\n"
    assert result.stderr == ""


def test_runtime_node_version_rejects_output_injection_metacharacters_and_shorthand(tmp_path: Path):
    invalid_versions = (
        "24.20.0\nmalicious=true",
        "24.20.0; touch /tmp/pwned",
        "$(touch /tmp/pwned)",
        "v24.20.0",
        "24.20",
        "024.20.0",
        24,
    )

    for version in invalid_versions:
        result = run_reader(tmp_path, version)
        assert result.returncode != 0, version
        assert result.stdout == ""
        assert "strict release semver" in result.stderr
