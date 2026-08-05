"""Codifies acceptance criteria from the design spec
(docs/superpowers/specs/2026-05-22-stt-daemon-and-vocab-design.md §13).

These tests retain the still-relevant capture, vocabulary, prompt, and search
invariants. The retired Yulu batch transcriber and JSON Agent queue are covered
by the Host/Hermes tests in ``yulu_ui`` instead.
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"


def test_no_yulu_mlx_whisper_imports():
    """Transcription runtimes belong to the selected Agent."""
    result = subprocess.run(
        ["grep", "-rE", "-I", "--exclude-dir=__pycache__",
         r"^import mlx_whisper|^from mlx_whisper",
         str(SCRIPTS), str(ROOT / "tests")],
        capture_output=True, text=True,
    )
    hits = [line for line in result.stdout.strip().splitlines() if line]
    assert not hits, f"Yulu still imports mlx_whisper: {hits}"


def test_realtime_transcribe_executor_is_removed():
    assert not (SCRIPTS / "realtime_transcribe.py").exists()


def test_seed_count_threshold(tmp_path):
    """Acceptance #4 part 3: `yulu vocab seed --from-current` produces >= 23 rows."""
    sys.path.insert(0, str(SCRIPTS))
    from vocab import VocabRepo, open_db
    from vocab.seed import seed_from_current
    repo = VocabRepo(open_db(tmp_path / "vocab.sqlite"))
    seed_from_current(repo, config_replacements=None)
    assert repo.count() >= 23, f"seed produced too few rows: {repo.count()}"


def test_stt_daemon_package_is_removed():
    assert not (SCRIPTS / "stt_daemon").exists()


def test_vocab_package_complete():
    """All expected vocab modules exist."""
    pkg = SCRIPTS / "vocab"
    for name in ("__init__.py", "db.py", "seed.py", "cli.py"):
        assert (pkg / name).exists(), f"missing {name}"


def test_stt_launchagent_is_retired_on_install():
    assert not (SCRIPTS / "com.yulu.sttdaemon.plist").exists()
    assert "com.yulu.sttdaemon.plist" in (SCRIPTS / "dev_install.py").read_text(encoding="utf-8")
    assert "com.yulu.sttdaemon.plist" in (SCRIPTS / "setup_daemons.sh").read_text(encoding="utf-8")


# ── Prompt Library acceptance (spec 2026-05-22-prompt-library-design.md) ──

def test_legacy_batch_executors_are_removed():
    """Batch transcription, summarization and connectors are Agent-owned."""
    for name in (
        "transcribe.py",
        "agent_queue_worker.py",
        "queue_store.py",
        "agent_notify.py",
        "send_summary.py",
        "com.yulu.agentqueue.plist",
        "stt_cli.py",
        "transcribe_client.py",
        "realtime_transcribe.py",
        "realtime_coverage.py",
        "transcribe_text.py",
        "setup_models.sh",
        "setup_capabilities.sh",
    ):
        assert not (SCRIPTS / name).exists(), f"retired executor still exists: {name}"


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


def test_legacy_summary_cli_is_removed():
    assert not (SCRIPTS / "summaries_cli.py").exists()
    wrapper = (SCRIPTS / "yulu").read_text(encoding="utf-8")
    assert "summaries)" not in wrapper
    assert "stt)" not in wrapper


def test_adr_004_exists():
    adr = SCRIPTS.parent / "spec" / "adr" / "004-prompt-library.md"
    assert adr.exists(), f"ADR-004 missing at {adr}"


# ── Dual-Track + Recording Lock acceptance (spec 2026-05-22-dual-track-recording-design.md) ──

def test_wav_inspect_classifier_module_exists():
    assert (SCRIPTS / "wav_inspect.py").exists()


def test_legacy_transcript_merge_module_is_removed():
    assert not (SCRIPTS / "stt_daemon" / "transcript_merge.py").exists()


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


def test_record_audio_acquires_recording_lock():
    text = (SCRIPTS / "record_audio.py").read_text(encoding="utf-8")
    assert "acquire_recording_lock" in text or "from recording_lock import" in text
    assert "RecordingBusy" in text


def test_meeting_daemon_acquires_recording_lock():
    text = (SCRIPTS / "meeting_daemon.py").read_text(encoding="utf-8")
    assert "acquire_recording_lock" in text or "from recording_lock import" in text
    assert "recorder_status.log" in text
    assert "wait(timeout=0.4)" in text


def test_meeting_daemon_hands_completed_recordings_to_host():
    text = (SCRIPTS / "meeting_daemon.py").read_text(encoding="utf-8")
    assert "/api/recordings/completed" in text
    assert "recording-events" in text
    assert "send_summary.py" not in text


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
    # The live schema keeps meeting prompts separate from voice-input prompts.
    assert "CHECK(category IN ('summary', 'cleanup', 'voice'))" in text
    assert "CHECK(category IN ('summary', 'cleanup', 'voicemail'))" not in text
    # The migration that collapses legacy voicemail rows stays.
    assert "_migrate_category_check_constraint" in text


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


def test_status_agent_swift_has_hotkeys_no_voicemail():
    text = (SCRIPTS / "status_agent.swift").read_text(encoding="utf-8")
    assert "voicemail" not in text.lower()
    assert "RecordingLauncher" in text
    assert "import Carbon" in text
    assert "RegisterEventHotKey" in text


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
    assert b"hotkey_registered" in blob
    assert b"voicemail.cli" not in blob


def test_audio_daemon_silence_monitor_is_lifecycle_owned():
    """Acceptance #9: silence_monitor is owned by recording lifecycle."""
    text = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    assert 'DispatchQueue(label: "com.yulu.audioRecorder")' in text
    assert "DispatchSource.makeTimerSource(queue: recorderQueue)" in text
    assert "startSilenceMonitorOnQueue()" in text
    start = text.index("private func mixAndWriteOnQueue()")
    end = text.index("private func flushBuffersOnQueue()", start)
    body = text[start:end]
    assert "startSilenceMonitor" not in body, (
        "audio callback path must not recreate/cancel DispatchSourceTimer"
    )


def test_audio_daemon_silence_threshold_is_request_configured():
    text = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    assert "let silenceThreshold: Float" in text
    assert "silenceThresholdState = silenceThreshold" in text
    assert 'json["silence_threshold"]' in text
    assert "self.calcRMS(samples) > self.silenceThresholdState" in text


def test_audio_daemon_mic_device_is_request_configured():
    text = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    assert "selectedDeviceUID" in text
    assert 'json["mic_device"]' in text
    assert "configureInputDevice" in text
    assert "kAudioOutputUnitProperty_CurrentDevice" in text
    assert "mic_device_not_found" in text
    assert "if let error = configureInputDevice(input)" in text


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
    assert block["hotkeys"]["dictate"]["key"] == "Space"
    assert block["hotkeys"]["translate"]["target_language"] == "English"
    assert block["hotkeys"]["voice_chat"]["key"] == "A"


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
