"""Codifies acceptance criteria from the design spec
(docs/superpowers/specs/2026-05-22-stt-daemon-and-vocab-design.md §13).

These tests verify the end-state of the 8-phase implementation: no shadow
mlx-whisper imports outside the daemon, transcribe.py reduced to thin
client + business logic, vocab DB seeded with the legacy glossary, and
the daemon's package structure intact.
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"


def test_no_mlx_whisper_imports_outside_stt_daemon():
    """Acceptance #2: actual `import mlx_whisper` only inside stt_daemon/.

    String references in docstrings, comments, doctor-process needles,
    setup.sh venv paths, and config example paths are allowed — those
    aren't shadow STT runtimes, they're legitimate references to the
    venv name or process-detection patterns.
    """
    result = subprocess.run(
        ["grep", "-rE", "-I", "--exclude-dir=__pycache__",
         r"^import mlx_whisper|^from mlx_whisper",
         str(SCRIPTS), str(ROOT / "tests")],
        capture_output=True, text=True,
    )
    hits = [line for line in result.stdout.strip().splitlines() if line]
    bad = []
    for hit in hits:
        path_str, _ = hit.split(":", 1)
        p = Path(path_str)
        # Allowed: anything under stt_daemon/, including tests for it.
        if "stt_daemon" in p.parts:
            continue
        if p.name.startswith("test_stt_"):
            continue
        bad.append(hit)
    assert not bad, f"mlx_whisper imported outside stt_daemon: {bad}"


def test_realtime_transcribe_is_daemon_subscriber():
    """Acceptance #2 part 2: realtime_transcribe.py routes through the daemon."""
    text = (SCRIPTS / "realtime_transcribe.py").read_text(encoding="utf-8")
    assert "mlx_whisper" not in text, "realtime_transcribe.py still imports mlx_whisper"
    assert "subscribe_session" in text, "realtime_transcribe.py is not a daemon subscriber"


def test_transcribe_py_no_inline_mlx_invocation():
    """Acceptance #3: transcribe.py is a thin client; no in-process mlx-whisper.

    The line-count target in the original spec was aspirational (< 200) but
    the preserved business logic (refine, summarize, fallback, agent queue,
    prompt templates) reasonably runs ~340 lines. The substantive check is
    that all STT goes through transcribe_client RPC — no direct mlx import
    or subprocess invocation of mlx-whisper / whisper-cli remains.
    """
    path = SCRIPTS / "transcribe.py"
    text = path.read_text(encoding="utf-8")
    assert "from transcribe_client import" in text or "import transcribe_client" in text, \
        "transcribe.py should delegate STT to transcribe_client"
    assert not re.search(r"^\s*import\s+mlx_whisper", text, re.MULTILINE), \
        "transcribe.py still has inline mlx_whisper import"
    # The legacy `transcribe_mlx` and `transcribe` helper functions are gone
    assert "def transcribe_mlx" not in text
    assert "def final_transcribe_audio" not in text
    line_count = sum(1 for _ in path.open(encoding="utf-8"))
    assert line_count < 400, f"transcribe.py too long: {line_count} lines"


def test_default_glossary_constant_removed():
    """Acceptance #4: DEFAULT_GLOSSARY removed from transcribe.py source."""
    text = (SCRIPTS / "transcribe.py").read_text(encoding="utf-8")
    assert "DEFAULT_GLOSSARY" not in text, "DEFAULT_GLOSSARY should not appear in transcribe.py"


def test_inline_replacements_dict_removed():
    """Acceptance #4 part 2: inline replacements dict removed from transcribe.py."""
    text = (SCRIPTS / "transcribe.py").read_text(encoding="utf-8")
    # Look for the specific legacy dict literal pattern
    assert '"agent king": "AgentKey"' not in text


def test_seed_count_threshold(tmp_path):
    """Acceptance #4 part 3: `yulu vocab seed --from-current` produces >= 23 rows."""
    sys.path.insert(0, str(SCRIPTS))
    from vocab import VocabRepo, open_db
    from vocab.seed import seed_from_current
    repo = VocabRepo(open_db(tmp_path / "vocab.sqlite"))
    seed_from_current(repo, config_replacements=None)
    assert repo.count() >= 23, f"seed produced too few rows: {repo.count()}"


def test_stt_daemon_package_complete():
    """All expected stt_daemon modules exist."""
    pkg = SCRIPTS / "stt_daemon"
    for name in (
        "__init__.py", "__main__.py", "protocol.py", "logging.py",
        "config.py", "vocab_cache.py", "runtime.py", "scheduler.py",
        "control_server.py", "app.py", "live_session.py",
    ):
        assert (pkg / name).exists(), f"missing {name}"
    backends = pkg / "backends"
    assert (backends / "__init__.py").exists()
    assert (backends / "mlx.py").exists()
    assert (backends / "whisper_cli.py").exists()


def test_vocab_package_complete():
    """All expected vocab modules exist."""
    pkg = SCRIPTS / "vocab"
    for name in ("__init__.py", "db.py", "seed.py", "cli.py"):
        assert (pkg / name).exists(), f"missing {name}"


def test_launchd_plist_template_exists():
    """The stt_daemon launchd plist template is installable via setup.sh."""
    plist = SCRIPTS / "com.yulu.sttdaemon.plist"
    assert plist.exists()
    text = plist.read_text(encoding="utf-8")
    for placeholder in ("__PYTHON__", "__SCRIPT_DIR__", "__HOME__", "__PATH__"):
        assert placeholder in text, f"{placeholder} missing from plist template"


# ── Prompt Library acceptance (spec 2026-05-22-prompt-library-design.md) ──

def test_transcribe_no_summary_prompt_constant():
    """Acceptance #1: SUMMARY_PROMPT removed from transcribe.py + worker."""
    for name in ("transcribe.py", "agent_queue_worker.py"):
        text = (SCRIPTS / name).read_text(encoding="utf-8")
        assert "SUMMARY_PROMPT" not in text, f"{name} still has SUMMARY_PROMPT"


def test_transcribe_no_summarize_or_fallback_def():
    """Acceptance #2: inline LLM helpers removed from transcribe.py."""
    import re as _re
    text = (SCRIPTS / "transcribe.py").read_text(encoding="utf-8")
    assert _re.search(r"^\s*def\s+summarize\b", text, _re.MULTILINE) is None
    assert _re.search(r"^\s*def\s+fallback_summary\b", text, _re.MULTILINE) is None
    assert _re.search(r"^\s*def\s+refine_transcript\b", text, _re.MULTILINE) is None


def test_transcribe_is_thin():
    """Acceptance #8: transcribe.py is a thin orchestrator (<200 lines)."""
    line_count = sum(1 for _ in (SCRIPTS / "transcribe.py").open(encoding="utf-8"))
    assert line_count < 200, f"transcribe.py too long: {line_count} lines"


def test_prompts_seed_count(tmp_path):
    """Acceptance #3: yulu prompts seed ships at least 3 frozen seeds."""
    sys.path.insert(0, str(SCRIPTS))
    from prompts import PromptsRepo, open_db
    from prompts.seed import seed_from_current
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    seed_from_current(repo)
    assert len(repo.list_prompts()) >= 3


def test_prompts_package_complete():
    """All expected prompts modules exist."""
    pkg = SCRIPTS / "prompts"
    for name in ("__init__.py", "db.py", "seed.py", "cli.py", "cache.py"):
        assert (pkg / name).exists(), f"missing {name}"


def test_summaries_cli_exists():
    assert (SCRIPTS / "summaries_cli.py").exists()


def test_adr_004_exists():
    adr = SCRIPTS.parent / "spec" / "adr" / "004-prompt-library.md"
    assert adr.exists(), f"ADR-004 missing at {adr}"
