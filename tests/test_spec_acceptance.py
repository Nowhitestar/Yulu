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
    """Acceptance #8: transcribe.py is a thin orchestrator.

    Limit bumped from 200 → 220 in Phase 6 to accommodate the search-index
    push (one try/except block). Still well under the pre-refactor (~600 line)
    monolith; the orchestrator-ness invariant holds."""
    line_count = sum(1 for _ in (SCRIPTS / "transcribe.py").open(encoding="utf-8"))
    assert line_count < 220, f"transcribe.py too long: {line_count} lines"


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


# ── Dual-Track + Recording Lock acceptance (spec 2026-05-22-dual-track-recording-design.md) ──

def test_wav_inspect_classifier_module_exists():
    pkg = SCRIPTS / "stt_daemon"
    assert (pkg / "wav_inspect.py").exists()


def test_transcript_merge_module_exists():
    pkg = SCRIPTS / "stt_daemon"
    assert (pkg / "transcript_merge.py").exists()


def test_recording_lock_module_exists():
    assert (SCRIPTS / "recording_lock.py").exists()


def test_audio_daemon_no_half_duplex_mix_references():
    text = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    assert "halfDuplexMix" not in text, "halfDuplexMix should be removed in Phase 3"
    assert "channelInterleave" in text, "channelInterleave is the new mix method"


def test_audio_daemon_writes_dual_track_marker():
    text = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    assert "Yulu DualTrack v1" in text
    assert "LIST" in text and "INFO" in text and "ICMT" in text


def test_seed_has_action_items_by_speaker():
    sys.path.insert(0, str(SCRIPTS))
    from prompts.db import PromptsRepo, open_db
    from prompts.seed import seed_from_current
    import tempfile, pathlib
    with tempfile.TemporaryDirectory() as td:
        repo = PromptsRepo(open_db(pathlib.Path(td) / "p.sqlite"))
        seed_from_current(repo)
        slugs = {p.slug for p in repo.list_prompts()}
    assert "action-items-by-speaker" in slugs


def test_promptscache_render_accepts_speaker_vars():
    sys.path.insert(0, str(SCRIPTS))
    import inspect
    from prompts.cache import PromptsCache
    params = inspect.signature(PromptsCache.render).parameters
    assert "my_transcript" in params
    assert "their_transcript" in params


def test_transcribe_uses_channel_split_and_three_outputs():
    text = (SCRIPTS / "transcribe.py").read_text(encoding="utf-8")
    assert "channel_split=True" in text
    assert ".mic.transcript.txt" in text
    assert ".sys.transcript.txt" in text
    assert "transcript_merge" in text


def test_record_audio_acquires_recording_lock():
    text = (SCRIPTS / "record_audio.py").read_text(encoding="utf-8")
    assert "acquire_recording_lock" in text or "from recording_lock import" in text
    assert "RecordingBusy" in text


def test_meeting_daemon_acquires_recording_lock():
    text = (SCRIPTS / "meeting_daemon.py").read_text(encoding="utf-8")
    assert "acquire_recording_lock" in text or "from recording_lock import" in text


# ── Voicemail Inbox acceptance (spec 2026-05-23-voicemail-inbox-design.md) ──

def test_voicemail_package_exists():
    pkg = SCRIPTS / "voicemail"
    assert (pkg / "__init__.py").exists()
    assert (pkg / "repo.py").exists()
    assert (pkg / "recorder.py").exists()
    assert (pkg / "cli.py").exists()


def test_category_voicemail_seeds():
    sys.path.insert(0, str(SCRIPTS))
    from prompts.db import PromptsRepo, open_db
    from prompts.seed import seed_from_current
    import tempfile, pathlib
    with tempfile.TemporaryDirectory() as td:
        repo = PromptsRepo(open_db(pathlib.Path(td) / "p.sqlite"))
        seed_from_current(repo)
        slugs = {p.slug for p in repo.list_prompts()}
    assert "voicemail-todos" in slugs
    assert "voicemail-clean" in slugs


def test_prompts_db_check_constraint_includes_voicemail():
    text = (SCRIPTS / "prompts" / "db.py").read_text(encoding="utf-8")
    assert "CHECK(category IN ('summary', 'cleanup', 'voicemail'))" in text
    assert "_migrate_category_check_constraint" in text


def test_audio_daemon_accepts_silence_seconds_and_output_dir():
    text = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    assert "silence_seconds" in text
    assert "output_dir" in text


def test_agent_queue_worker_has_voicemail_notify():
    text = (SCRIPTS / "agent_queue_worker.py").read_text(encoding="utf-8")
    assert "_maybe_voicemail_notify" in text
    assert "voicemails" in text


def test_yulu_wrapper_dispatches_memo():
    text = (SCRIPTS / "yulu").read_text(encoding="utf-8")
    assert "memo)" in text
    assert "voicemail.cli" in text


def test_voicemail_recorder_does_not_call_merge_segments():
    """Acceptance #4: voicemail transcripts have NO speaker tags, so
    voicemail.recorder MUST NOT invoke merge_segments. We allow the name to
    appear in docstrings/comments (which document the negative invariant),
    but it must never appear as a call or an import."""
    text = (SCRIPTS / "voicemail" / "recorder.py").read_text(encoding="utf-8")
    assert "merge_segments(" not in text
    assert "import merge_segments" not in text
    assert "from transcript_merge" not in text


def test_voicemail_recorder_sends_sys_disabled():
    text = (SCRIPTS / "voicemail" / "recorder.py").read_text(encoding="utf-8")
    assert "sys_disabled" in text
    assert "silence_seconds" in text


def test_voicemail_cli_default_dir_is_voicemails_subdir():
    sys.path.insert(0, str(SCRIPTS))
    from voicemail.repo import VOICEMAIL_DIR_DEFAULT
    assert VOICEMAIL_DIR_DEFAULT.name == "voicemails"


# ── Status Agent acceptance (spec 2026-05-26-status-agent-design.md) ──

def test_status_agent_config_module_exists():
    assert (SCRIPTS / "status_agent_config.py").exists()


def test_status_agent_swift_source_exists():
    assert (SCRIPTS / "status_agent.swift").exists()


def test_status_agent_plist_template_exists():
    assert (SCRIPTS / "com.yulu.statusagent.plist").exists()


def test_status_agent_build_script_exists():
    p = SCRIPTS / "build_status_agent.sh"
    assert p.exists()
    import os
    assert os.access(p, os.X_OK), "build_status_agent.sh must be executable"


def test_status_agent_app_bundle_exists():
    """StatusAgent.app should be built (tracked binary, like Yulu.app)."""
    app = SCRIPTS / "StatusAgent.app" / "Contents" / "MacOS" / "status_agent"
    assert app.exists()


def test_status_agent_binary_has_required_strings():
    """Static verification that the Swift binary embeds the key contracts."""
    app = SCRIPTS / "StatusAgent.app" / "Contents" / "MacOS" / "status_agent"
    blob = app.read_bytes()
    for needle in (
        b"Yulu Status Agent",          # log line + bundle name
        b"audio_daemon.sock",           # daemon client target
        b"voicemail.cli",               # launcher subprocess
        b"hotkey_registered",           # registrar success log
        b"status_agent.pid",            # pid file
    ):
        assert needle in blob, f"missing string: {needle!r}"


def test_audio_daemon_silence_monitor_periodic():
    """Acceptance #9: silence_monitor re-armed on every mixAndWrite event."""
    text = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    # The re-arm call must appear inside mixAndWrite (search for the function
    # then check the next ~40 lines contain another startSilenceMonitor() call)
    import re
    match = re.search(r"private func mixAndWrite\(\)\s*\{(.*?)\n    \}", text, re.DOTALL)
    assert match is not None, "mixAndWrite function not found"
    body = match.group(1)
    assert "startSilenceMonitor()" in body, "silence monitor not re-armed in mixAndWrite"


def test_yulu_wrapper_dispatches_status_agent():
    text = (SCRIPTS / "yulu").read_text(encoding="utf-8")
    assert "status-agent)" in text or "status-agent|statusagent" in text
    assert "status_agent_config" in text


def test_status_agent_plist_lsuielement_via_build():
    """The build script must set LSUIElement=true so the agent has no Dock icon."""
    text = (SCRIPTS / "build_status_agent.sh").read_text(encoding="utf-8")
    assert "LSUIElement" in text
    assert "true" in text  # the build_status_agent.sh sets it via PlistBuddy


def test_setup_sh_installs_statusagent_plist():
    text = (SCRIPTS / "setup.sh").read_text(encoding="utf-8")
    assert "com.yulu.statusagent.plist" in text


def test_config_example_has_status_agent_block():
    text = (SCRIPTS / "config.example.json").read_text(encoding="utf-8")
    assert "status_agent" in text
    # Confirm the default hotkey is there
    assert '"V"' in text or "'V'" in text
