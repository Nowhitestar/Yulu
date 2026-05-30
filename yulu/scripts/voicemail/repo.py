"""Filesystem-as-database voicemail inbox.

Voicemails live as `voicemail_YYYYMMDD_HHMMSS.wav` files (plus siblings)
in ~/Movies/Yulu/voicemails/. This module exposes a small API to enumerate,
fetch (by id-prefix), and delete records — no SQLite involved.

Title resolution order (per spec §5):
  1. `<stem>.title` sidecar
  2. First 8 whitespace tokens of `<stem>.transcript.txt`
  3. Literal "(no title)"

Summary slugs:
  - `<stem>.summary.md` → "voicemail-todos" (default-slug convention from Phase 2)
  - `<stem>.<slug>.summary.md` → that <slug>
"""

from __future__ import annotations

import re
import wave
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import List, Optional

# Phase 5 DATA-01 — content root follows data_dir(); existing-file migration is
# Phase 7 (D-08). Lazy + guarded resolver import (mirrors probes.probe_recording_dir)
# so this module imports off-Darwin / before the resolver lands, degrading to the
# historical ~/Movies/Yulu literal.
def _resolve_data_dir() -> Path:
    try:
        from yulu_platform.macos.path_resolver import MacOSPathResolver

        return MacOSPathResolver().data_dir()
    except Exception:
        return Path.home() / "Movies" / "Yulu"


VOICEMAIL_DIR_DEFAULT = _resolve_data_dir() / "voicemails"
_STEM_RE = re.compile(r"^voicemail_(\d{8})_(\d{6})$")
_DEFAULT_SUMMARY_SLUG = "voicemail-todos"


@dataclass
class VoicemailRecord:
    stem: str
    wav_path: Path
    title: str
    duration_sec: int
    has_summary: bool
    summary_slugs: List[str]
    created_at: datetime


def _parse_created_at(stem: str) -> Optional[datetime]:
    m = _STEM_RE.match(stem)
    if not m:
        return None
    ymd, hms = m.groups()
    try:
        return datetime.strptime(ymd + hms, "%Y%m%d%H%M%S")
    except ValueError:
        return None


def _read_title(stem: str, directory: Path) -> str:
    title_sidecar = directory / f"{stem}.title"
    if title_sidecar.exists():
        text = title_sidecar.read_text(encoding="utf-8").strip()
        if text:
            return text
    transcript = directory / f"{stem}.transcript.txt"
    if transcript.exists():
        text = transcript.read_text(encoding="utf-8").strip()
        if text:
            tokens = text.split()[:8]
            return " ".join(tokens) if tokens else "(no title)"
    return "(no title)"


def _read_duration(wav_path: Path) -> int:
    try:
        with wave.open(str(wav_path), "rb") as w:
            frames = w.getnframes()
            rate = w.getframerate()
            return int(frames / rate) if rate > 0 else 0
    except (wave.Error, OSError, EOFError):
        return 0


def _summary_slugs_for(stem: str, directory: Path) -> List[str]:
    slugs: list[str] = []
    default = directory / f"{stem}.summary.md"
    if default.exists():
        slugs.append(_DEFAULT_SUMMARY_SLUG)
    # `<stem>.<slug>.summary.md` siblings (skip default which has no infix)
    prefix = f"{stem}."
    suffix = ".summary.md"
    for child in directory.iterdir():
        name = child.name
        if not (name.startswith(prefix) and name.endswith(suffix)):
            continue
        infix = name[len(prefix):-len(suffix)]
        if infix and "." not in infix:    # safe slug
            slugs.append(infix)
    return slugs


def _make_record(stem: str, directory: Path) -> Optional[VoicemailRecord]:
    wav_path = directory / f"{stem}.wav"
    if not wav_path.exists():
        return None
    created = _parse_created_at(stem)
    if created is None:
        return None
    slugs = _summary_slugs_for(stem, directory)
    return VoicemailRecord(
        stem=stem,
        wav_path=wav_path,
        title=_read_title(stem, directory),
        duration_sec=_read_duration(wav_path),
        has_summary=bool(slugs),
        summary_slugs=slugs,
        created_at=created,
    )


def list_voicemails(*, directory: Path = VOICEMAIL_DIR_DEFAULT,
                    limit: int = 20) -> List[VoicemailRecord]:
    """Enumerate voicemails in `directory`, newest first, capped at `limit`."""
    directory = Path(directory)
    if not directory.exists():
        return []
    stems = []
    for child in directory.iterdir():
        if child.suffix != ".wav":
            continue
        stem = child.stem
        if _STEM_RE.match(stem):
            stems.append(stem)
    stems.sort(reverse=True)  # filename includes ts → sort = chronological
    out: List[VoicemailRecord] = []
    for stem in stems[:limit]:
        rec = _make_record(stem, directory)
        if rec is not None:
            out.append(rec)
    return out


class VoicemailNotFound(LookupError):
    """Raised when no voicemail matches the given id prefix."""

    def __init__(self, id_prefix: str):
        super().__init__(f"no voicemail matches '{id_prefix}'")
        self.id_prefix = id_prefix


class AmbiguousVoicemailId(LookupError):
    """Raised when an id prefix matches more than one voicemail."""

    def __init__(self, id_prefix: str, candidates: List[str]):
        super().__init__(
            f"id prefix '{id_prefix}' matches {len(candidates)} voicemails: {candidates}"
        )
        self.id_prefix = id_prefix
        self.candidates = candidates


def get_voicemail(id_prefix: str, *,
                  directory: Path = VOICEMAIL_DIR_DEFAULT) -> VoicemailRecord:
    """Resolve `id_prefix` to a unique VoicemailRecord, or raise.

    Exact stem match wins over prefix match.
    """
    directory = Path(directory)
    if not directory.exists():
        raise VoicemailNotFound(id_prefix)

    exact = _make_record(id_prefix, directory)
    if exact is not None:
        return exact

    matches: List[str] = []
    for child in directory.iterdir():
        if child.suffix != ".wav":
            continue
        stem = child.stem
        if _STEM_RE.match(stem) and stem.startswith(id_prefix):
            matches.append(stem)
    if not matches:
        raise VoicemailNotFound(id_prefix)
    if len(matches) > 1:
        matches.sort()
        raise AmbiguousVoicemailId(id_prefix, matches)
    rec = _make_record(matches[0], directory)
    if rec is None:
        raise VoicemailNotFound(id_prefix)
    return rec


def delete_voicemail(record: VoicemailRecord) -> int:
    """Remove the WAV and all `<stem>.*` sibling files. Returns the count."""
    directory = record.wav_path.parent
    prefix = f"{record.stem}."
    removed = 0
    # Remove the .wav itself
    if record.wav_path.exists():
        record.wav_path.unlink()
        removed += 1
    # Remove every sibling whose name starts with `<stem>.`
    for child in directory.iterdir():
        if child.name == record.wav_path.name:
            continue   # already removed above
        if child.name.startswith(prefix):
            try:
                child.unlink()
                removed += 1
            except OSError:
                pass
    return removed
