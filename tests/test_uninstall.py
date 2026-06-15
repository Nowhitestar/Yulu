import json
import os
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def write_file(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_uninstall_dry_run_json_reports_pkg_payload_and_backups(tmp_path):
    install_dir = tmp_path / ".yulu"
    script_dir = install_dir / "yulu" / "scripts"
    script_dir.mkdir(parents=True)
    shutil.copy2(ROOT / "yulu" / "scripts" / "uninstall.sh", script_dir / "uninstall.sh")

    home = tmp_path / "home"
    config = home / ".config" / "yulu"
    write_file(
        config / "config.json",
        json.dumps({"audio": {"output_dir": str(home / "Recordings")}}),
    )
    (tmp_path / ".yulu.backup-old").mkdir()

    visible_app = tmp_path / "Applications" / "Yulu.app"
    pkg_runtime = tmp_path / "Library" / "Application Support" / "Yulu" / "runtime"
    visible_app.mkdir(parents=True)
    pkg_runtime.mkdir(parents=True)

    bin_dir = tmp_path / "bin"
    write_file(
        bin_dir / "pkgutil",
        "#!/usr/bin/env bash\n"
        "if [[ \"$1\" == \"--pkg-info\" ]]; then exit 0; fi\n"
        "exit 2\n",
    )
    (bin_dir / "pkgutil").chmod(0o755)

    env = os.environ.copy()
    env.update(
        {
            "HOME": str(home),
            "PATH": f"{bin_dir}:{env['PATH']}",
            "YULU_VISIBLE_APP": str(visible_app),
            "YULU_PKG_RUNTIME_ROOT": str(pkg_runtime),
            "YULU_PKG_IDENTIFIER": "com.example.yulu",
        }
    )

    result = subprocess.run(
        ["bash", str(script_dir / "uninstall.sh"), "--dry-run", "--json", "--purge-backups"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    data = json.loads(result.stdout)
    assert data["dry_run"] is True
    assert data["remove"]["visible_app"] == str(visible_app)
    assert data["remove"]["pkg_runtime"] == str(pkg_runtime)
    assert data["remove"]["pkg_receipt"] == "com.example.yulu"
    assert data["detected"]["visible_app_present"] is True
    assert data["detected"]["pkg_runtime_present"] is True
    assert data["detected"]["pkg_receipt_present"] is True
    assert data["optional"]["runtime_backups"]["count"] == 1
    assert data["optional"]["runtime_backups"]["remove"] is True


def test_uninstall_help_documents_agent_safe_options():
    text = (ROOT / "yulu" / "scripts" / "uninstall.sh").read_text(encoding="utf-8")

    assert "--dry-run, --plan" in text
    assert "--json" in text
    assert "--purge-backups" in text
    assert "PKG_RUNTIME_ROOT" in text
    assert "pkgutil --forget" in text
