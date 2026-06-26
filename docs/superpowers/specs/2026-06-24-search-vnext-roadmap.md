# Spec: Search vNext Roadmap

> **Status**: Ready for task breakdown
> **Date**: 2026-06-24
> **Owner**: Yulu
> **Builds on**: `docs/superpowers/specs/2026-05-25-global-search-design.md`, the shipped `search.sqlite` v1 index, the local Web UI global search, and the diarization `.speakers.json` sidecar model.
> **Plane**: YULU-31

## 1. Current State

Yulu already has a useful lexical search baseline:

- `search.sqlite` schema v1 stores `docs(kind, stem, meeting_title, recorded_at, source_path, body)`, plus `docs_meta` and `meta`.
- The index currently supports meeting summaries and meeting transcripts. Legacy voicemail/memo content is treated as meeting content after the recordings unification.
- Writers push transcript/summary changes into the index, and `search.reader.sweep()` reconciles out-of-band file changes before each query.
- Query execution uses SQLite FTS5 trigram for queries with at least 3 characters and a LIKE fallback for short queries, including 1-2 character CJK queries.
- `yulu search` supports `--since`, `--in summary|transcript|both`, `--limit`, `--json`, `--doctor`, and `--reindex`.
- The local Web UI already calls the search router and renders global search results from the same CLI path.
- Diarization now has a sidecar data model (`<stem>.speakers.json`) with stable speaker ids, display names, confidence/source tags, and labelled segments, but search does not yet use that structured speaker data.

The v1 design deliberately deferred semantic search, speaker-aware search, saved searches, richer highlighting, and broader library roots. This document defines the next safe set of increments.

## 2. vNext Scope

Search vNext has four product goals:

1. **Result highlighting and reader deep links**
   - Preserve `[hit]...[/hit]` snippets from the search backend.
   - Render highlights in the Web UI result list and carry enough metadata to open the matching recording/summary context.
   - Keep this lexical-only; no schema migration required.

2. **Saved searches and local query history**
   - Store recent search history locally so repeated meeting-recall workflows are fast.
   - Let the user save named searches with filters.
   - Keep all history in the local runtime DB; never sync or send externally by default.

3. **Speaker-aware search**
   - Index diarization sidecars when present.
   - Let queries filter or facet by speaker display name / stable speaker id.
   - Keep speaker embeddings out of scope; Yulu stores labels and segment timings, not biometric voiceprints.

4. **Semantic search planning spike**
   - Define chunking, local embedding model ownership, storage, and fallback behavior.
   - Ship semantic search only after the local model and SQLite/vector extension path are proven on the installed runtime.
   - Lexical FTS remains the source-of-truth baseline.

## 3. Explicit Non-Goals

- No cloud search backend.
- No cross-device sync of `search.sqlite`.
- No default indexing of arbitrary external folders.
- No OCR/image indexing.
- No realtime transcript indexing in vNext; `.realtime.transcript.txt` remains excluded because it is noisy and superseded by final transcripts.
- No speaker identity inference beyond user-visible labels and diarization clusters.
- No replacement of the current FTS5/LIKE path; semantic search is additive and optional.

## 4. Schema Direction

The next durable schema should be additive from v1. Keep `docs` as the lexical full-text table and add metadata tables around it.

### 4.1 Schema Version 2

```sql
CREATE TABLE IF NOT EXISTS doc_attrs (
    source_path TEXT PRIMARY KEY,
    layer TEXT NOT NULL,              -- summary | transcript
    corpus_root_id TEXT NOT NULL,     -- v2 default: yulu-data-dir
    summary_slug TEXT,                -- NULL for default summary/transcript
    has_speakers INTEGER NOT NULL DEFAULT 0,
    sidecar_path TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS speaker_segments (
    source_path TEXT NOT NULL,
    segment_idx INTEGER NOT NULL,
    start_s REAL NOT NULL,
    end_s REAL NOT NULL,
    speaker_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    confident INTEGER NOT NULL,
    source TEXT NOT NULL,             -- overlap | bracket | nearest | unknown | hallucination
    text TEXT NOT NULL,
    PRIMARY KEY (source_path, segment_idx)
);
CREATE INDEX IF NOT EXISTS idx_speaker_segments_speaker
    ON speaker_segments(speaker_id, display_name);
CREATE INDEX IF NOT EXISTS idx_speaker_segments_source_path
    ON speaker_segments(source_path);

CREATE TABLE IF NOT EXISTS saved_searches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    query TEXT NOT NULL,
    filters_json TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS search_history (
    id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    filters_json TEXT NOT NULL,
    hit_count INTEGER NOT NULL,
    fallback_used INTEGER NOT NULL,
    elapsed_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_history_created_at
    ON search_history(created_at);
```

### 4.2 Semantic Search Tables

Do not add vector tables until a local runtime spike proves the exact dependency. The intended shape is:

```sql
CREATE TABLE embedding_chunks (
    id TEXT PRIMARY KEY,
    source_path TEXT NOT NULL,
    layer TEXT NOT NULL,
    chunk_start INTEGER NOT NULL,
    chunk_end INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    model TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    indexed_at TEXT NOT NULL
);
```

The vector storage itself can be `sqlite-vec`, another SQLite extension, or a plain sidecar if extension loading is unsafe in the installed runtime. That decision belongs to the semantic-search spike.

## 5. Migration Strategy

1. Bump `meta.schema_version` from `1` to `2` after creating the additive tables.
2. Leave `docs` and `docs_meta` intact; do not rebuild lexical rows during the schema migration.
3. During the next sweep, populate `doc_attrs` for every indexed document.
4. If `<stem>.speakers.json` exists, parse it as the speaker source of truth and populate `speaker_segments`; if absent, set `has_speakers=0`.
5. `yulu search --reindex` should rebuild `docs`, `docs_meta`, `doc_attrs`, and `speaker_segments` from disk.
6. Preserve user speaker renames by treating `.speakers.json` as authoritative. Search never overwrites sidecars.
7. History retention should be bounded, for example latest 500 rows or 30 days, whichever is smaller. Saved searches are retained until explicit deletion.

Rollback is simple: older code can ignore the extra tables. If a migration partially fails, `search --doctor` should warn on schema mismatch and `search --reindex` should repair from disk.

## 6. Release Slices

### Slice 1: Highlight and Deep Link Polish

- Render hit markers in `GlobalSearch`.
- Include enough route metadata to open the recording detail view for matching files.
- Add tests for hit rendering and route derivation.

**Ships independently**: yes. No DB migration.

### Slice 2: Search Schema v2 Metadata

- Add `doc_attrs`.
- Add migration and doctor reporting for schema v2.
- Populate metadata during sweep/reindex.

**Ships independently**: yes. No UI changes required.

### Slice 3: Saved Searches and Query History

- Add `saved_searches` and bounded `search_history`.
- Add CLI JSON operations first, then UI controls.
- Keep the history local-only and easy to clear.

**Ships independently**: yes. Depends on Slice 2 only for schema versioning conventions.

### Slice 4: Speaker-Aware Search

- Parse `.speakers.json` into `speaker_segments`.
- Add filters by speaker id/display name and return speaker facets.
- In the UI, show speaker labels as filters only when sidecar data exists.

**Ships independently**: yes. Depends on Slice 2.

### Slice 5: Broader Library Root Boundary

- Introduce a root registry but default it to the existing Yulu data dir only.
- Make external roots explicit opt-in and read-only.
- Do not allow runtime DBs, sockets, or caches in searchable content roots.

**Ships independently**: yes. Does not require semantic search.

### Slice 6: Semantic Search Spike

- Choose local embedding model ownership and install/reuse path.
- Prove vector storage on the installed runtime.
- Define chunking, invalidation, and lexical fallback behavior.
- Produce a follow-up implementation plan before writing user-facing semantic search UI.

**Ships independently**: no user-facing feature until the spike produces a safe storage/runtime decision.

## 7. Acceptance Criteria

- vNext scope and non-goals are documented in this file.
- Schema v2 is additive and has a clear rollback/reindex path.
- Speaker-aware search is based on `.speakers.json`, not speaker embeddings.
- Saved search/history data stays local by default.
- Semantic search is gated behind a spike and does not block lexical search.
- Each release slice can be implemented and verified independently.

