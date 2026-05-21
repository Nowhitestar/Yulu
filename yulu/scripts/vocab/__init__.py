"""Vocab package — custom_words SQLite repository and CLI."""

from .db import VocabRepo, CustomWord, Scope, Source, open_db

__all__ = ["VocabRepo", "CustomWord", "Scope", "Source", "open_db"]
