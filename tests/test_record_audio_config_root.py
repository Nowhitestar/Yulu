import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"


def test_recording_commands_honor_isolated_config_root(tmp_path):
    config_dir = tmp_path / "isolated-config"
    env = {
        **os.environ,
        "PYTHONPATH": str(SCRIPTS),
        "YULU_CONFIG_DIR": str(config_dir),
    }
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import record_audio, recording_lock; "
            "print(record_audio.CONFIG_DIR); print(recording_lock.DEFAULT_LOCK_PATH)",
        ],
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    assert result.stdout.splitlines() == [
        str(config_dir),
        str(config_dir / ".recording.lock"),
    ]
