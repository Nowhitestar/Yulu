import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TRANSCRIBE = ROOT / "yulu" / "scripts" / "transcribe.py"


def load_transcribe():
    spec = importlib.util.spec_from_file_location("transcribe", TRANSCRIBE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_transcribe_runtime_files_share_resolved_runtime_dir():
    mod = load_transcribe()

    assert mod.CONFIG_PATH == mod.RUNTIME_DIR / "config.json"
    assert mod.PROMPTS_DB == mod.RUNTIME_DIR / "prompts.sqlite"
    assert mod.AGENT_QUEUE_PATH == mod.RUNTIME_DIR / "agent-queue.json"


def test_transcribe_no_longer_owns_config_dir_literal():
    src = TRANSCRIBE.read_text(encoding="utf-8")

    assert 'Path.home() / ".config" / "yulu" / "config.json"' not in src
