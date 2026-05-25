"""Global search across voicemails, meetings, and summaries.

Phase 6 package — SQLite FTS5 + trigram tokenizer index over
~/Movies/Yulu/. See docs/superpowers/specs/2026-05-25-global-search-design.md.
"""

from search.indexer import (
    SEARCH_DB_PATH,
    CORPUS_ROOT,
    SCHEMA_VERSION,
    KIND_MEETING_SUMMARY,
    KIND_MEETING_TRANSCRIPT,
    KIND_VOICEMAIL_SUMMARY,
    KIND_VOICEMAIL_TRANSCRIPT,
    VALID_KINDS,
    StemInfo,
    init_db,
    open_conn,
    parse_stem,
    upsert_doc,
)
from search.reader import (
    SearchHit,
    doctor,
    reindex,
    search,
    sweep,
)

__all__ = [
    "SEARCH_DB_PATH",
    "CORPUS_ROOT",
    "SCHEMA_VERSION",
    "KIND_MEETING_SUMMARY",
    "KIND_MEETING_TRANSCRIPT",
    "KIND_VOICEMAIL_SUMMARY",
    "KIND_VOICEMAIL_TRANSCRIPT",
    "VALID_KINDS",
    "StemInfo",
    "init_db",
    "open_conn",
    "parse_stem",
    "upsert_doc",
    "SearchHit",
    "doctor",
    "reindex",
    "search",
    "sweep",
]
