"""In-memory cache over the prompts.sqlite Agent instruction table."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Optional

from .db import (
    Category, Prompt, PromptsRepo, open_db,
)


class PromptsCache:
    """Loads prompts from sqlite; exposes auto_run / by_slug / by_id / render.

    Kept intentionally small so Agent-owned dictation can render local prompts
    without a resident transcription service.
    Same WAL-aware reload semantics, same threading.RLock.

    API:
      __init__(db_path, *, autoreload=False)
      load() -> None                       # initial population
      reload() -> None                     # full reread from sqlite
      maybe_reload() -> bool               # reload iff autoreload + mtime changed
      by_id(prompt_id) -> Optional[Prompt]
      by_slug(slug) -> Optional[Prompt]
      auto_run(category: str | Category) -> list[Prompt]
        # filtered to is_auto_run=True, sorted by sort_order asc then slug
      render(prompt, *, transcript, meeting_title, date,
             my_transcript="", their_transcript="",
             speaker_transcript="", speaker_list="") -> str
        # single-pass literal substitution of {{transcript}}/{{meeting_title}}/
        # {{date}}/{{my_transcript}}/{{their_transcript}}/
        # {{speaker_transcript}}/{{speaker_list}}.
        # The speaker-aware vars default to "" so legacy prompts/callers
        # that don't pass them keep rendering unchanged.
    """

    def __init__(self, db_path: Path, *, autoreload: bool = False):
        self.db_path = Path(db_path)
        self.autoreload = autoreload
        self._lock = threading.RLock()
        self._by_id: dict[str, Prompt] = {}
        self._by_slug: dict[str, Prompt] = {}
        self._mtime: float = 0.0

    def _max_mtime(self) -> float:
        """Return the latest mtime across the db file and its WAL sidecar.

        SQLite WAL mode writes go to a -wal sidecar before checkpointing back
        to the main file. We track the max so maybe_reload doesn't thrash
        when the wal mtime is persistently ahead of the main file mtime.
        """
        m = self.db_path.stat().st_mtime
        wal_path = Path(str(self.db_path) + "-wal")
        if wal_path.exists():
            m = max(m, wal_path.stat().st_mtime)
        return m

    def load(self) -> None:
        self.reload()

    def reload(self) -> None:
        """Re-read prompts from sqlite; rebuild by_id + by_slug indexes."""
        with self._lock:
            if not self.db_path.exists():
                self._by_id = {}
                self._by_slug = {}
                self._mtime = 0.0
                return
            conn = open_db(self.db_path)
            try:
                repo = PromptsRepo(conn)
                prompts = repo.list_prompts()
            finally:
                conn.close()

            by_id: dict[str, Prompt] = {}
            by_slug: dict[str, Prompt] = {}
            for p in prompts:
                by_id[p.id] = p
                by_slug[p.slug] = p
            self._by_id = by_id
            self._by_slug = by_slug
            try:
                self._mtime = self._max_mtime()
            except OSError:
                self._mtime = 0.0

    def maybe_reload(self) -> bool:
        """If autoreload enabled and DB mtime changed since last load, reload."""
        if not self.autoreload or not self.db_path.exists():
            return False
        try:
            current_mtime = self._max_mtime()
        except OSError:
            return False
        if current_mtime > self._mtime:
            self.reload()
            return True
        return False

    def by_id(self, prompt_id: str) -> Optional[Prompt]:
        with self._lock:
            return self._by_id.get(prompt_id)

    def by_slug(self, slug: str) -> Optional[Prompt]:
        with self._lock:
            return self._by_slug.get(slug)

    def auto_run(self, category) -> list[Prompt]:
        """Prompts in `category` with is_auto_run=True, sorted by sort_order, slug."""
        cat = Category(category) if not isinstance(category, Category) else category
        with self._lock:
            results = [p for p in self._by_id.values()
                       if p.category == cat and p.is_auto_run]
        results.sort(key=lambda p: (p.sort_order, p.slug))
        return results

    def render(self, prompt: Prompt, *,
               transcript: str, meeting_title: str, date: str,
               my_transcript: str = "", their_transcript: str = "",
               speaker_transcript: str = "", speaker_list: str = "") -> str:
        """Single-pass literal substitution of the supported template vars.

        Supported placeholders:
          {{transcript}}         — merged transcript (mic + sys)
          {{my_transcript}}      — mic-side only (speaker = "我")
          {{their_transcript}}   — sys-side only (speaker = "对方")
          {{speaker_transcript}} — diarized transcript with [MM:SS <speaker>] labels (v0.6)
          {{speaker_list}}       — compact roster of detected/named speakers (v0.6)
          {{best_transcript}}    — speaker_transcript when present, else transcript
          {{meeting_title}}      — meeting title
          {{date}}               — YYYY-MM-DD meeting date

        my_transcript / their_transcript / speaker_transcript / speaker_list all
        default to "" so legacy callers and legacy prompts (mono / pre-Phase-3 /
        older callers) keep rendering EXACTLY unchanged — the additive-var contract.
        """
        best_transcript = speaker_transcript or transcript
        return (prompt.content
                .replace("{{transcript}}", transcript)
                .replace("{{my_transcript}}", my_transcript)
                .replace("{{their_transcript}}", their_transcript)
                .replace("{{speaker_transcript}}", speaker_transcript)
                .replace("{{speaker_list}}", speaker_list)
                .replace("{{best_transcript}}", best_transcript)
                .replace("{{meeting_title}}", meeting_title)
                .replace("{{date}}", date))
