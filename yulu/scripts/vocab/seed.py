"""Frozen seed snapshots + seeder for vocab.sqlite.

These snapshots are intentionally frozen copies of the constants that used
to live in `scripts/transcribe.py`. The same PR that adds this module
deletes those constants from `transcribe.py`. After that point, this file
is the canonical history.
"""

from __future__ import annotations

from typing import Optional

from .db import Scope, Source, VocabRepo


# Frozen snapshot of DEFAULT_GLOSSARY from scripts/transcribe.py
SEED_GLOSSARY: tuple[str, ...] = (
    "AgentKey", "OpenClaw", "OpenAI", "Claude", "Cursor", "Deal Hub",
    "Portfolio", "public market", "candidate", "qualification", "recruiter",
    "research rollup", "workflow", "GitHub", "screenshot", "VP",
    "VC", "AI conference", "meetup", "Yulu",
)

# Frozen snapshot of the inline `replacements` dict
SEED_REPLACEMENTS: dict[str, str] = {
    "agent king": "AgentKey",
    "Agent King": "AgentKey",
    "agency": "AgentKey",
    "Agency": "AgentKey",
    "open cloud": "OpenClaw",
    "OpenCloud": "OpenClaw",
    "OpenCore": "OpenClaw",
    "deal hub": "Deal Hub",
    "github": "GitHub",
}


def _existing_seed_index(repo: VocabRepo) -> dict[tuple[str, str], str]:
    """Map (term, scope) -> id for existing seed rows."""
    index = {}
    for w in repo.list_words():
        if w.source == Source.SEED:
            index[(w.term, w.scope.value)] = w.id
    return index


def seed_from_current(
    repo: VocabRepo,
    *,
    config_replacements: Optional[dict[str, str]] = None,
) -> dict[str, int]:
    """Apply bundled snapshots + optional config overrides.

    Returns a summary dict with counts. Idempotent: skips (term, scope)
    pairs already present as seed rows.
    """
    existing = _existing_seed_index(repo)
    glossary_inserted = 0
    for term in SEED_GLOSSARY:
        if (term, Scope.PROMPT.value) in existing:
            continue
        repo.add(term=term, canonical=term, scope=Scope.PROMPT, source=Source.SEED)
        glossary_inserted += 1

    merged_replacements = dict(SEED_REPLACEMENTS)
    if config_replacements:
        for k, v in config_replacements.items():
            if k not in merged_replacements:
                merged_replacements[k] = v

    replacements_inserted = 0
    for term, canonical in merged_replacements.items():
        if (term, Scope.BOTH.value) in existing:
            continue
        repo.add(term=term, canonical=canonical, scope=Scope.BOTH, source=Source.SEED)
        replacements_inserted += 1

    from datetime import datetime, timezone
    repo.set_meta(
        "seeded_at",
        datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    )
    return {
        "glossary_inserted": glossary_inserted,
        "replacements_inserted": replacements_inserted,
    }


def restore_defaults(repo: VocabRepo) -> dict[str, int]:
    """Overwrite seed rows back to bundled snapshots; preserve manual rows.

    Seed rows are updated in-place (IDs preserved) so that callers holding
    IDs still get the reverted values. Seed rows that have no match in the
    bundled snapshots are removed. Manual rows are never touched.
    """
    # Build lookup tables for the bundled snapshots
    glossary_by_term: dict[str, str] = {t: t for t in SEED_GLOSSARY}
    replacements_by_term: dict[str, str] = dict(SEED_REPLACEMENTS)

    rows = repo.list_words()
    reverted = 0
    removed = 0
    for w in rows:
        if w.source != Source.SEED:
            continue
        if w.scope == Scope.PROMPT and w.term in glossary_by_term:
            canonical = glossary_by_term[w.term]
            if w.canonical != canonical:
                repo.edit(w.id, canonical=canonical)
            reverted += 1
        elif w.scope == Scope.BOTH and w.term in replacements_by_term:
            canonical = replacements_by_term[w.term]
            if w.canonical != canonical:
                repo.edit(w.id, canonical=canonical)
            reverted += 1
        else:
            # seed row no longer in snapshots — remove it
            repo.remove(w.id)
            removed += 1

    # Insert any snapshot entries that don't exist yet
    inserted = seed_from_current(repo, config_replacements=None)
    return {
        "reverted": reverted,
        "removed_stale": removed,
        "glossary_inserted": inserted["glossary_inserted"],
        "replacements_inserted": inserted["replacements_inserted"],
    }
