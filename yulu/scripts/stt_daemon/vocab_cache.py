"""In-memory cache over the vocab.sqlite custom_words table."""

from __future__ import annotations

import re
import threading
from pathlib import Path
from typing import Optional

from vocab import VocabRepo, Scope, open_db


_ASCII_RE = re.compile(r"[A-Za-z0-9]")


def _compile_rule(term: str) -> re.Pattern[str]:
    """Build a regex that matches `term` case-insensitively.

    If the term contains any ASCII alphanumeric character we use word
    boundaries; otherwise (pure CJK) we fall back to a plain substring
    match because Python's \\b is not meaningful between CJK characters.
    """
    if _ASCII_RE.search(term):
        pattern = r"\b" + re.escape(term) + r"\b"
    else:
        pattern = re.escape(term)
    return re.compile(pattern, re.IGNORECASE)


class VocabCache:
    """Loads custom_words from sqlite, exposes prompt + replace data."""

    def __init__(self, db_path: Path, *, autoreload: bool = False):
        self.db_path = Path(db_path)
        self.autoreload = autoreload
        self._lock = threading.RLock()
        self._prompt_terms: list[str] = []
        self._replace_rules: list[tuple[str, str, re.Pattern[str]]] = []
        self._mtime: float = 0.0

    @property
    def prompt_terms(self) -> list[str]:
        with self._lock:
            return list(self._prompt_terms)

    @property
    def replace_rules(self) -> list[tuple[str, str]]:
        """Public view: list of (term, canonical) tuples (excludes compiled regex)."""
        with self._lock:
            return [(t, c) for t, c, _ in self._replace_rules]

    def load(self) -> None:
        self.reload()

    def reload(self) -> None:
        with self._lock:
            if not self.db_path.exists():
                self._prompt_terms = []
                self._replace_rules = []
                self._mtime = 0.0
                return
            conn = open_db(self.db_path)
            try:
                repo = VocabRepo(conn)
                prompt_words = repo.list_words(
                    scopes=[Scope.PROMPT, Scope.BOTH], enabled_only=True
                )
                replace_words = repo.list_words(
                    scopes=[Scope.REPLACE, Scope.BOTH], enabled_only=True
                )
            finally:
                conn.close()

            # Sort longest-first to prevent prefix shadowing in regex pass
            replace_words.sort(key=lambda w: len(w.term), reverse=True)
            self._prompt_terms = [w.term for w in prompt_words]
            self._replace_rules = [
                (w.term, w.canonical, _compile_rule(w.term)) for w in replace_words
            ]
            try:
                self._mtime = self.db_path.stat().st_mtime
            except OSError:
                self._mtime = 0.0

    def maybe_reload(self) -> bool:
        """If autoreload enabled and DB mtime changed since last load, reload.

        SQLite WAL mode writes go to a -wal sidecar before checkpointing back
        to the main file, so the main file's mtime may not advance immediately.
        We therefore also check the -wal file mtime to catch in-flight writes.
        """
        if not self.autoreload or not self.db_path.exists():
            return False
        try:
            current_mtime = self.db_path.stat().st_mtime
            wal_path = Path(str(self.db_path) + "-wal")
            if wal_path.exists():
                current_mtime = max(current_mtime, wal_path.stat().st_mtime)
        except OSError:
            return False
        if current_mtime > self._mtime:
            self.reload()
            return True
        return False

    def inject_prompt(self, base_prompt: str = "", meeting_title: str = "") -> str:
        """Build the initial_prompt fed to the speech engine."""
        with self._lock:
            terms = list(self._prompt_terms)
        parts = []
        if base_prompt:
            parts.append(base_prompt.strip())
        if meeting_title:
            parts.append(f"会议标题：{meeting_title}。")
        if terms:
            parts.append("常见术语：" + ", ".join(terms) + "。")
        return " ".join(parts).strip()

    def apply_replacements(self, text: str) -> tuple[str, int]:
        """Run the regex replacement pass. Returns (new_text, replacement_count)."""
        with self._lock:
            rules = list(self._replace_rules)
        out = text
        total = 0
        for term, canonical, pattern in rules:
            out, n = pattern.subn(canonical, out)
            total += n
        return out, total
