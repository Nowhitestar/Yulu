import subprocess
from pathlib import Path

import yulu.scripts.dev_install as dev_install


def test_seed_prompt_defaults_uses_runtime_script_dir(monkeypatch, tmp_path):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, 0, stdout='{"inserted": 0}', stderr="")

    monkeypatch.setattr(dev_install.subprocess, "run", fake_run)

    dev_install._seed_prompt_defaults(tmp_path / "scripts", python_bin="/usr/bin/python3")

    assert calls[0][0] == ["/usr/bin/python3", "-m", "prompts.cli", "seed", "--from-current"]
    assert calls[0][1]["env"]["PYTHONPATH"] == str(tmp_path / "scripts")
