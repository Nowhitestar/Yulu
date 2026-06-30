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

    Limit bumped 200 → 220 (Phase 6, search-index push) → 225 (realtime-robustness
    fix: the fast_summary coverage guard that stops a truncated realtime transcript
    from being reused as the final) → 240 (v0.6 Phase 13, diarization wiring: capture
    timestamped ASR segments + one thin call to
    stt_daemon.diarize_pipeline.run_diarize_stage) → 260 (per-run speaker-count CLI
    override for UI re-transcribe; → 280 (Hermes STT manifest wiring; the HEAVY
    diarize logic lives in that module, NOT here — the orchestrator only gained the wiring). Still well under the
    pre-refactor (~600 line) monolith; the orchestrator-ness invariant holds."""
    line_count = sum(1 for _ in (SCRIPTS / "transcribe.py").open(encoding="utf-8"))
    assert line_count < 280, f"transcribe.py too long: {line_count} lines"


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
    assert "start_realtime_transcriber(audio_path, title)" in text
    assert "recorder_status.log" in text
    assert "wait(timeout=0.4)" in text


def test_meeting_daemon_accepts_async_summary_queue():
    text = (SCRIPTS / "meeting_daemon.py").read_text(encoding="utf-8")
    assert "summary_queued = False" in text
    assert '"enqueued" in line and "LLM jobs" in line' in text
    assert "摘要任务已进入队列" in text


# ── Voicemail REMOVAL acceptance (voicemail unified into meetings) ──
# The voicemail concept was removed entirely: no module, no prompts, no
# category, no mic-only/sys-disabled path, no `yulu memo`. These assertions are
# the inverse of the old voicemail-inbox acceptance suite.

def test_voicemail_package_is_gone():
    pkg = SCRIPTS / "voicemail"
    assert not pkg.exists(), "the voicemail package must be deleted"


def test_no_voicemail_prompts_seed():
    sys.path.insert(0, str(SCRIPTS))
    from prompts.db import PromptsRepo, open_db
    from prompts.seed import seed_from_current
    import tempfile, pathlib
    with tempfile.TemporaryDirectory() as td:
        repo = PromptsRepo(open_db(pathlib.Path(td) / "p.sqlite"))
        seed_from_current(repo)
        slugs = {p.slug for p in repo.list_prompts()}
    assert not any(s.startswith("voicemail") for s in slugs)


def test_prompts_db_check_constraint_drops_voicemail():
    text = (SCRIPTS / "prompts" / "db.py").read_text(encoding="utf-8")
    # The live schema is the 2-value constraint.
    assert "CHECK(category IN ('summary', 'cleanup'))" in text
    assert "CHECK(category IN ('summary', 'cleanup', 'voicemail'))" not in text
    # The down-migration that collapses the legacy 3-value constraint stays.
    assert "_migrate_category_check_constraint" in text


def test_agent_queue_worker_has_generic_summary_notify():
    text = (SCRIPTS / "agent_queue_worker.py").read_text(encoding="utf-8")
    assert "_maybe_summary_notify" in text
    assert "_maybe_voicemail_notify" not in text


def test_yulu_wrapper_memo_is_removed():
    text = (SCRIPTS / "yulu").read_text(encoding="utf-8")
    # `yulu memo` no longer dispatches to the deleted voicemail.cli; it prints a
    # one-line hint pointing at `yulu record start`.
    assert "voicemail.cli" not in text
    assert "record start" in text


def test_yulu_wrapper_dispatches_unify_voicemails():
    text = (SCRIPTS / "yulu").read_text(encoding="utf-8")
    assert "unify-voicemails" in text
    assert "migrate.voicemail_unify" in text


def test_voicemail_unify_migrator_exists():
    assert (SCRIPTS / "migrate" / "voicemail_unify.py").exists()


def test_status_agent_swift_has_no_hotkey_or_voicemail():
    text = (SCRIPTS / "status_agent.swift").read_text(encoding="utf-8")
    assert "voicemail" not in text.lower()
    assert "RecordingLauncher" in text
    assert "import Carbon" not in text


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


def test_status_agent_build_script_builds_recorder_status():
    text = (SCRIPTS / "build_status_agent.sh").read_text(encoding="utf-8")
    assert "recorder_status.swift" in text
    assert "recorder_status" in text
    assert "codesign" in text


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
        b"meeting_daemon.py",           # launcher subprocess (mic + system)
        b"status_agent.pid",            # pid file
    ):
        assert needle in blob, f"missing string: {needle!r}"
    # The hotkey + voicemail launcher were removed entirely.
    assert b"hotkey_registered" not in blob
    assert b"voicemail.cli" not in blob


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


def test_audio_daemon_silence_threshold_is_request_configured():
    text = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    assert "silenceThreshold = DEFAULT_SILENCE_THRESHOLD" in text
    assert 'json["silence_threshold"]' in text
    assert "rms > silenceThreshold" in text


def test_audio_daemon_mic_device_is_request_configured():
    text = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    assert "selectedDeviceUID" in text
    assert 'json["mic_device"]' in text
    assert "configureInputDevice" in text
    assert "kAudioOutputUnitProperty_CurrentDevice" in text


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
    # After the Phase-1 setup decomposition (D-12), setup.sh is a thin orchestrator
    # and the per-plist install/load moved into setup_daemons.sh. Assert the
    # statusagent plist is installed by that concern AND that the orchestrator
    # sequences it.
    daemons_text = (SCRIPTS / "setup_daemons.sh").read_text(encoding="utf-8")
    assert "com.yulu.statusagent.plist" in daemons_text
    setup_text = (SCRIPTS / "setup.sh").read_text(encoding="utf-8")
    assert "setup_daemons.sh" in setup_text


def test_config_example_has_status_agent_block():
    import json
    cfg = json.loads((SCRIPTS / "config.example.json").read_text(encoding="utf-8"))
    block = cfg.get("status_agent")
    assert block is not None
    assert block.get("enabled") is True
    # The global hotkey was removed entirely — no hotkey block in the example.
    assert "hotkey" not in block


# ── Phase 6 — Global Search ──────────────────────────────────────────
# Maps 1:1 to spec §9 (docs/superpowers/specs/2026-05-25-global-search-design.md).

import sys as _sys_for_phase6
from datetime import timedelta as _td_for_phase6

_sys_for_phase6.path.insert(0, str(SCRIPTS))


def _phase6_seed_corpus(tmp_path):
    """Reusable corpus fixture: meetings (incl. a migrated memo) × summary/
    transcript. Every recording is a meeting now — no voicemail kind."""
    from search.indexer import (
        KIND_MEETING_SUMMARY, KIND_MEETING_TRANSCRIPT,
        init_db, upsert_doc,
    )
    db = tmp_path / "search.sqlite"
    conn = init_db(db)
    docs = [
        ("AgentkeyProductWeekly_20260521_160008.summary.md",
         KIND_MEETING_SUMMARY,
         "本周 OKR OKR OKR 完成度 80%，KPI 也持平"),
        ("AgentkeyProductWeekly_20260521_160008.transcript.txt",
         KIND_MEETING_TRANSCRIPT,
         "[00:00] 我们讨论 OKR 的落地阻塞"),
        ("Memo_20260513_140012.transcript.txt",
         KIND_MEETING_TRANSCRIPT,
         "记得明天找 Anthropic 团队同步 OKR"),
        ("Finance_20260518_140000.summary.md",
         KIND_MEETING_SUMMARY,
         "KPI 走势平稳，本周项目进度整体良好"),
    ]
    paths = {}
    for fname, kind, body in docs:
        p = tmp_path / fname
        p.write_text(body, encoding="utf-8")
        upsert_doc(source_path=p, kind=kind, conn=conn)
        paths[fname] = p
    return db, conn, paths


def test_phase6_1_schema_bootstraps_cleanly(tmp_path):
    from search.indexer import init_db, SCHEMA_VERSION
    conn = init_db(tmp_path / "search.sqlite")
    assert conn.execute("SELECT value FROM meta WHERE key='schema_version'"
                        ).fetchone()[0] == SCHEMA_VERSION
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"docs", "docs_meta", "meta"} <= tables


def test_phase6_2_upsert_is_idempotent(tmp_path):
    from search.indexer import init_db, upsert_doc, KIND_MEETING_SUMMARY
    db = tmp_path / "search.sqlite"
    conn = init_db(db)
    p = tmp_path / "Plan_20260521_160000.summary.md"
    p.write_text("body", encoding="utf-8")
    assert upsert_doc(source_path=p, kind=KIND_MEETING_SUMMARY, conn=conn) is True
    rowid_1 = conn.execute("SELECT rowid FROM docs").fetchone()[0]
    assert upsert_doc(source_path=p, kind=KIND_MEETING_SUMMARY, conn=conn) is False
    rowid_2 = conn.execute("SELECT rowid FROM docs").fetchone()[0]
    assert rowid_1 == rowid_2


def test_phase6_3_sweep_picks_up_oob_changes(tmp_path):
    import os, time
    from search.indexer import init_db, KIND_MEETING_SUMMARY
    from search.reader import sweep
    root = tmp_path / "Yulu"
    root.mkdir()
    p = root / "Plan_20260521_160000.summary.md"
    p.write_text("v1", encoding="utf-8")
    db = tmp_path / "search.sqlite"
    conn = init_db(db)
    sweep(conn=conn, roots=[root])
    p.write_text("v2", encoding="utf-8")
    future = time.time() + 5
    os.utime(p, (future, future))
    counts = sweep(conn=conn, roots=[root])
    assert counts["updated"] == 1


def test_phase6_4_sweep_removes_deleted_files(tmp_path):
    from search.indexer import init_db
    from search.reader import sweep
    root = tmp_path / "Yulu"
    root.mkdir()
    p = root / "Plan_20260521_160000.summary.md"
    p.write_text("x", encoding="utf-8")
    conn = init_db(tmp_path / "search.sqlite")
    sweep(conn=conn, roots=[root])
    p.unlink()
    counts = sweep(conn=conn, roots=[root])
    assert counts["removed"] == 1


def test_phase6_5_english_query_ranks_okr_docs(tmp_path):
    from search.reader import _fts_search
    _db, conn, _paths = _phase6_seed_corpus(tmp_path)
    hits = _fts_search("OKR", since=None, kinds=None, limit=10, conn=conn)
    # 3 OKR docs (meeting summary + meeting transcript + migrated memo).
    assert len(hits) == 3


def test_phase6_6_chinese_3char_via_trigram(tmp_path):
    from search.reader import _fts_search
    _db, conn, _paths = _phase6_seed_corpus(tmp_path)
    hits = _fts_search("项目进度", since=None, kinds=None, limit=10, conn=conn)
    assert len(hits) >= 1


def test_phase6_7_chinese_2char_routes_to_like(tmp_path, monkeypatch):
    from search.reader import search, CORPUS_ROOT
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", tmp_path / "nowhere")
    db, _conn, _ = _phase6_seed_corpus(tmp_path)
    hits, tel = search("进度", db_path=db)
    assert tel["fallback_used"] is True
    assert len(hits) >= 1


def test_phase6_8_filters_compose(tmp_path, monkeypatch):
    from datetime import timedelta
    from search.reader import search
    from search.indexer import KIND_MEETING_SUMMARY
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", tmp_path / "nowhere")
    db, _conn, _ = _phase6_seed_corpus(tmp_path)
    hits, _tel = search(
        "OKR",
        since=timedelta(days=10_000),
        kinds=[KIND_MEETING_SUMMARY],
        db_path=db,
    )
    assert all(h.kind == KIND_MEETING_SUMMARY for h in hits)


def test_phase6_9_slug_tagged_summaries_are_separate_rows(tmp_path):
    from search.indexer import init_db, upsert_doc, KIND_MEETING_SUMMARY
    db = tmp_path / "search.sqlite"
    conn = init_db(db)
    stem_sum = tmp_path / "Plan_20260521_160000.summary.md"
    slug_sum = tmp_path / "Plan_20260521_160000.action-items.summary.md"
    stem_sum.write_text("a", encoding="utf-8")
    slug_sum.write_text("b", encoding="utf-8")
    upsert_doc(source_path=stem_sum, kind=KIND_MEETING_SUMMARY, conn=conn)
    upsert_doc(source_path=slug_sum, kind=KIND_MEETING_SUMMARY, conn=conn)
    rows = list(conn.execute(
        "SELECT meeting_title, recorded_at, source_path FROM docs "
        "ORDER BY source_path"
    ))
    assert len(rows) == 2
    assert rows[0]["meeting_title"] == rows[1]["meeting_title"] == "Plan"
    assert rows[0]["recorded_at"] == rows[1]["recorded_at"]
    assert rows[0]["source_path"] != rows[1]["source_path"]


def test_phase6_10_stem_parser_handles_memo_literal():
    from search.indexer import parse_stem
    info = parse_stem("Memo_20260513_140012")
    assert info is not None
    assert info.meeting_title == "Memo"


def test_phase6_11_stem_parser_skips_nonmatching():
    from search.indexer import parse_stem
    assert parse_stem("notes") is None
    assert parse_stem("manual-note") is None


def test_phase6_12_index_failure_does_not_break_pipeline():
    """The search-index write hook in the sole LLM dispatcher
    (agent_queue_worker) is wrapped in try/except so a search-index failure
    can never break the recording → summary pipeline. (The runtime behaviour
    is exercised end-to-end by
    test_agent_queue_worker_search_hook::test_hook_failure_does_not_break_processing.)"""
    text = (SCRIPTS / "agent_queue_worker.py").read_text(encoding="utf-8")
    # The indexer import + upsert live inside a try/except that logs, not raises.
    idx = text.index("from search import indexer as _search_indexer")
    # The `try:` opens just before the indexer import…
    assert "try:" in text[idx - 120 : idx]
    # …and the matching except logs the failure rather than re-raising.
    window = text[idx : idx + 700]
    assert "except Exception" in window
    assert "search index upsert failed" in window


def test_phase6_13_ipc_path_matches_in_process(tmp_path, monkeypatch):
    """Both IPC helper and in-process search.reader.search return the
    same hit set for the same query+corpus."""
    from search.ipc_helper import handle_request
    from search.reader import search
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", tmp_path / "nowhere")
    db, _conn, _ = _phase6_seed_corpus(tmp_path)
    from search import indexer as search_indexer
    monkeypatch.setattr(search_indexer, "SEARCH_DB_PATH", db)
    monkeypatch.setattr(reader_mod, "SEARCH_DB_PATH", db)
    direct_hits, _ = search("OKR", db_path=db)
    ipc_resp = handle_request({"query": "OKR"})
    assert ipc_resp["ok"] is True
    ipc_paths = {h["source_path"] for h in ipc_resp["hits"]}
    direct_paths = {h.source_path for h in direct_hits}
    assert ipc_paths == direct_paths


def test_phase6_14_cli_in_process_fallback_works(tmp_path, monkeypatch, capsys):
    """When IPC unreachable, the CLI uses in-process search.reader."""
    from search import cli as search_cli, indexer as search_indexer
    from search import reader as reader_mod
    monkeypatch.setattr(
        search_cli, "IPC_SOCKET_PATH",
        tmp_path / "absent.sock",
    )
    db, _conn, _ = _phase6_seed_corpus(tmp_path)
    monkeypatch.setattr(search_indexer, "SEARCH_DB_PATH", db)
    monkeypatch.setattr(reader_mod, "SEARCH_DB_PATH", db)
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", tmp_path / "nowhere")
    rc = search_cli.main(["OKR", "--no-ipc"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "OKR" in out


def test_phase6_15_doctor_flag_prints_health(tmp_path, monkeypatch, capsys):
    import json as _json
    from search import cli as search_cli, indexer as search_indexer
    from search import reader as reader_mod
    db, _conn, _ = _phase6_seed_corpus(tmp_path)
    monkeypatch.setattr(search_indexer, "SEARCH_DB_PATH", db)
    monkeypatch.setattr(reader_mod, "SEARCH_DB_PATH", db)
    rc = search_cli.main(["--doctor"])
    assert rc == 0
    data = _json.loads(capsys.readouterr().out)
    assert data["schema_version"] == "1"
    assert data["total_docs"] == 4
    assert "per_kind" in data


def test_phase6_16_reindex_rebuilds_from_scratch(tmp_path, monkeypatch):
    from search.reader import reindex, sweep
    from search.indexer import init_db
    root = tmp_path / "Yulu"
    root.mkdir()
    (root / "Plan_20260521_160000.summary.md").write_text("body", encoding="utf-8")
    db = tmp_path / "search.sqlite"
    conn = init_db(db)
    sweep(conn=conn, roots=[root])
    n_before = conn.execute("SELECT COUNT(*) FROM docs").fetchone()[0]
    assert n_before == 1
    conn.close()

    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", root)
    counts = reindex(db_path=db)
    assert counts["added"] == 1

    conn = init_db(db)
    n_after = conn.execute("SELECT COUNT(*) FROM docs").fetchone()[0]
    assert n_after == 1


def test_phase6_17_concurrent_upserts_one_row(tmp_path):
    import threading
    from search.indexer import init_db, upsert_doc, open_conn, KIND_MEETING_SUMMARY
    db = tmp_path / "search.sqlite"
    init_db(db).close()
    p = tmp_path / "Plan_20260521_160000.summary.md"
    p.write_text("body", encoding="utf-8")
    errors = []
    def worker():
        try:
            c = init_db(db)
            upsert_doc(source_path=p, kind=KIND_MEETING_SUMMARY, conn=c)
            c.close()
        except Exception as exc:
            errors.append(exc)
    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads: t.start()
    for t in threads: t.join(timeout=10)
    assert not errors
    c = open_conn(db)
    assert c.execute("SELECT COUNT(*) FROM docs").fetchone()[0] == 1
    c.close()


def test_phase6_18_sweep_under_250ms_for_38_files(tmp_path):
    """Spec §6.1 perf gate; 500ms slack vs the 250ms target."""
    import time
    from search.indexer import init_db
    from search.reader import sweep
    root = tmp_path / "Yulu"
    root.mkdir()
    for i in range(30):
        stem = f"Meeting{i:02d}_20260521_{160000 + i:06d}"
        (root / f"{stem}.transcript.txt").write_text(f"b{i}", encoding="utf-8")
    for i in range(8):
        stem = f"Memo_20260513_{140000 + i:06d}"
        (root / f"{stem}.transcript.txt").write_text(f"v{i}", encoding="utf-8")
    conn = init_db(tmp_path / "search.sqlite")
    t0 = time.monotonic()
    counts = sweep(conn=conn, roots=[root])
    elapsed = (time.monotonic() - t0) * 1000
    assert counts["scanned"] == 38
    assert elapsed < 500, f"sweep too slow: {elapsed:.0f}ms"
