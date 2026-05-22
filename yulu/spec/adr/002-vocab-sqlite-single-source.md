# ADR-002: Single SQLite vocabulary, two application points

**Status**: Accepted
**Date**: 2026-05-22
**Spec**: [docs/superpowers/specs/2026-05-22-stt-daemon-and-vocab-design.md](../../../docs/superpowers/specs/2026-05-22-stt-daemon-and-vocab-design.md) §7
**Supersedes**: hardcoded `DEFAULT_GLOSSARY` constant + inline `replacements` dict in `scripts/transcribe.py`

## Context

Until v0.x, the user's custom vocabulary (proper nouns, company terms, common
mishearings like `agent king→AgentKey`) lived in three uncoordinated places:

1. `DEFAULT_GLOSSARY` constant in `scripts/transcribe.py` — 20 terms fed to
   `mlx-whisper`'s `initial_prompt`.
2. `replacements` dict in `transcribe.py`'s `normalize_transcript_text` — 9
   regex post-replacements.
3. Optional `transcription.replacements` field in user's
   `~/.config/yulu/config.json` — read but undocumented.

Editing the first two required modifying source code. The CLI / UX gap was
real: a power user wanting to add a term had to find and edit a constant.

## Decision

Single SQLite file `~/.config/yulu/vocab.sqlite` with one table:

```sql
CREATE TABLE custom_words (
    id TEXT PRIMARY KEY,
    term TEXT NOT NULL,
    canonical TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('prompt', 'replace', 'both')),
    source TEXT NOT NULL DEFAULT 'manual'
        CHECK(source IN ('seed', 'manual', 'learned')),
    enabled INTEGER NOT NULL DEFAULT 1,
    ...
);
```

Each row has a `scope` selecting one or both of two application points:

- **`prompt`** — term is appended to `mlx-whisper`'s `initial_prompt`, biasing
  recognition toward the canonical form.
- **`replace`** — regex post-pass rewrites occurrences of `term` to
  `canonical` in the transcribed text.
- **`both`** — applied at both points (e.g. `agent king→AgentKey` is biased in
  *and* rewritten *out*).

Users edit via `yulu vocab` CLI (`add`/`list`/`edit`/`remove`/`import`/`export`).
Writes auto-SIGHUP the daemon, which reloads `VocabCache` from SQLite. The
daemon also polls SQLite + `-wal` sidecar mtime as a backup signal in case the
SIGHUP is missed.

## Rejected alternatives

- **YAML/JSON config file** — easy to corrupt with partial writes from
  multiple processes; SQLite's WAL mode + busy_timeout handle concurrent CLI
  writes vs daemon reads cleanly.
- **Single application point (prompt-only OR replace-only)** — both axes are
  needed:
  - `Kubernetes` (anchor): mlx already knows the word, just needs casing
    consistency. Prompt is sufficient.
  - `agent king→AgentKey` (correction): mlx will never produce `AgentKey`
    without help. Prompt nudges + regex catches anything that slips through.
- **Macparakeet's FluidAudio keyword boosting** — only available with
  FluidAudio (which Yulu doesn't use). Equivalent behavior via initial_prompt
  is well-established and works on `mlx-whisper`.

## Consequences

**Good**
- Single source of truth for vocabulary, editable without source changes.
- Frozen `SEED_GLOSSARY` + `SEED_REPLACEMENTS` in `vocab/seed.py` preserve the
  legacy 29-row baseline for first install (`yulu vocab seed --from-current`).
- Per-row enable/disable, source attribution, and scope tuning unlock future
  features (auto-learn from past transcripts, hide a built-in without
  deleting) without schema migration.

**Bad**
- One more file in `~/.config/yulu/`. Backup story is the same as
  `agent-queue.json`: copy the file.
- The CJK match path uses plain substring (no `\b` between CJK code points);
  acceptable false-positive risk noted in the spec, can add `match_mode`
  column later if it ever matters.

## Notes for future change

If we add `text_snippets` (e.g. `"my signature"→"Best regards, …"`) for a
future dictation path, that goes in a new sibling table. The current
`custom_words` table stays untouched.

If we add a `language` column for per-language vocabularies (so AgentKey
only applies to zh-only transcripts), it's an additive migration; the
existing `VocabCache` query just gains a `WHERE language IS NULL OR language=?`
clause.
