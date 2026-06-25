"""DATA-03 cloud-sync-root detection (macOS) — stdlib path-prefix + ``SF_DATALESS``.

A single pure classifier, ``is_cloud_root(path)``, that decides whether a
candidate data-folder lives under one of macOS's two cloud-sync-root families and
whether it is currently EVICTED (made "dataless" by a File Provider engine). It
returns a structured ``CloudRootResult(is_cloud, engine, reason, dataless_sample)``
so the UI can WARN before accepting the folder (D-03) and so Plan 01's
``assert_runtime_not_synced()`` can refuse to put runtime/state under a sync root.

Detection method (RESEARCH Pattern 1, validated on-device — macOS Darwin 26.5,
Python 3.14.3):

* **Path-prefix**, relative to ``Path.home()``:
  - iCloud Drive = ``~/Library/Mobile Documents/com~apple~CloudDocs/`` (it has its
    OWN root and is NOT under CloudStorage).
  - Third-party File Provider engines (Dropbox / OneDrive / Google Drive) =
    ``~/Library/CloudStorage/<Provider>-<account>/`` since macOS 12.3+.
* **Eviction** = ``os.stat(path).st_flags & stat.SF_DATALESS`` (``SF_DATALESS =
  0x40000000``). A real evicted iCloud file reports ``st_flags = 0x40000060``.

NOT the Linux-only ``os`` xattr functions (RESEARCH Pitfall 2): the
``os.get<x>attr`` / ``os.set<x>attr`` / ``os.list<x>attr`` family is absent on
macOS CPython (compiled only on ``__linux__``; ``hasattr(os, ...)`` is False
on-device for all of them). The CONTEXT.md hint to read ``com.apple.fileprovider``
via the ``os`` extended-attribute reader is WRONG for macOS — ``SF_DATALESS``
(stdlib) is sufficient and simpler, so no extended-attribute read appears here.

Why the runtime lock this backs is justified (RESEARCH Pitfall 3): a Unix socket
CAN bind under iCloud Drive (verified on-device). The refusal is NOT "a socket
can't exist in a synced folder"; it is that a sync engine CORRUPTS a live WAL-mode
SQLite database (WAL checkpoint + hot-journal relocation, sqlite.org/howtocorrupt)
and may EVICT an in-use file mid-write — machine-local corruption/eviction safety,
never physical impossibility.

Security (RESEARCH V12 + threat register): detection is metadata-only —
``os.stat`` does NOT materialize a dataless file (the flag reads without a network
download; verified on-device), so we never ``open()``/read file contents (no DoS
bandwidth / info-leak, T-05-08). The directory child scan is hard-bounded to the
first 64 entries (T-05-10) and uses ``follow_symlinks=False`` so a symlinked entry
cannot redirect the ``stat`` outside the resolved path (T-05-09).

Pure stdlib (``os``, ``stat``, ``dataclasses``, ``pathlib``) with NO Darwin gate at
import time: some Python builds expose ``stat.SF_DATALESS`` and some do not, so
the module installs the documented macOS bit value when missing. Off-Darwin
``st_flags`` simply won't carry the bit, which is the correct answer
(not-dataless). Every public function NEVER raises — it degrades to a safe
not-cloud value, mirroring the ``capabilities.probes`` never-raise idiom.
"""

from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from pathlib import Path

# macOS File Provider dataless bit. Some Python builds omit the stdlib constant.
if not hasattr(stat, "SF_DATALESS"):
    stat.SF_DATALESS = 0x40000000  # type: ignore[attr-defined]

# iCloud Drive is NOT under CloudStorage — it has its own root. [VERIFIED on-device]
_ICLOUD_ROOT = "Library/Mobile Documents/com~apple~CloudDocs"
# Third-party File Provider engines (Dropbox/OneDrive/Google Drive) since macOS 12.3+.
_CLOUDSTORAGE_ROOT = "Library/CloudStorage"

# Hard upper bound on the eviction child-scan fan-out (T-05-10 DoS guard).
_MAX_CHILD_SCAN = 64


@dataclass(frozen=True)
class CloudRootResult:
    """Structured classification of a candidate data-folder path.

    Attributes:
        is_cloud: True if the path lives under a known sync root (or is evicted).
        engine:   "icloud" | "google-drive" | "dropbox" | "onedrive" |
                  "cloudstorage" | "" (empty when not cloud, or evicted-only).
        reason:   Human-readable explanation for the warning copy.
        dataless_sample: True if the path (or a scanned child) is currently evicted.
    """

    is_cloud: bool
    engine: str
    reason: str
    dataless_sample: bool


def _engine_from_cloudstorage_segment(segment: str) -> str:
    """Map a ``~/Library/CloudStorage/<segment>`` provider segment to an engine id.

    The segment is typically ``<Provider>-<account>`` (e.g. ``GoogleDrive-me@x.com``);
    an unknown provider is still a real sync root, just labelled ``cloudstorage``.
    """
    s = segment.lower()
    if s.startswith("googledrive"):
        return "google-drive"
    if s.startswith("dropbox"):
        return "dropbox"
    if s.startswith("onedrive"):
        return "onedrive"
    return "cloudstorage"  # unknown File Provider engine, still a sync root


def is_cloud_root(path: os.PathLike | str) -> CloudRootResult:
    """Classify whether *path* lives under a known macOS sync root. Never raises.

    Resolves *path* once (``expanduser`` + ``resolve``), then checks the two
    path-prefix families relative to ``Path.home()``; failing those, falls back to
    the live ``SF_DATALESS`` flag (belt-and-suspenders — the OS may already have
    evicted a file under a sync engine we don't recognise by path). Returns a
    not-cloud ``CloudRootResult`` on any unresolvable input rather than raising.
    """
    try:
        p = Path(path).expanduser().resolve()
    except Exception as exc:  # unresolvable/garbage path → degrade, never raise
        return CloudRootResult(False, "", f"unresolvable path: {exc}", False)

    try:
        home = Path.home()
    except Exception:
        home = None

    rel = None
    if home is not None:
        try:
            rel = p.relative_to(home)
        except ValueError:
            rel = None  # path is not under home → not a per-user sync root by prefix

    # 1. iCloud Drive
    if rel is not None and str(rel).startswith(_ICLOUD_ROOT):
        return CloudRootResult(
            True,
            "icloud",
            "iCloud Drive (~/Library/Mobile Documents/com~apple~CloudDocs)",
            _is_dataless(p),
        )

    # 2. ~/Library/CloudStorage/<Provider>-<account>/...
    if rel is not None and str(rel).startswith(_CLOUDSTORAGE_ROOT):
        parts = rel.parts  # ('Library', 'CloudStorage', 'GoogleDrive-acct', ...)
        provider_segment = parts[2] if len(parts) >= 3 else ""
        engine = (
            _engine_from_cloudstorage_segment(provider_segment)
            if provider_segment
            else "cloudstorage"
        )
        return CloudRootResult(
            True,
            engine,
            f"macOS File Provider sync folder (~/Library/CloudStorage/{provider_segment})",
            _is_dataless(p),
        )

    # 3. Not a known root by path, but flag it if the OS already made it dataless.
    if _is_dataless(p):
        return CloudRootResult(
            True,
            "",
            "path contains evicted (dataless) files — under some sync engine",
            True,
        )

    return CloudRootResult(False, "", "", False)


def is_evicted(path: os.PathLike | str) -> bool:
    """True if *path* is currently a dataless/evicted File Provider item.

    The single-file eviction signal (``SF_DATALESS = 0x40000000``) used by the
    warning copy and tests. Metadata-only (``os.stat``) — never materializes the
    file. Returns False on any ``OSError`` / ``AttributeError`` (off-Darwin
    ``st_flags`` may be absent) rather than raising.
    """
    try:
        return bool(os.stat(path).st_flags & stat.SF_DATALESS)
    except (OSError, AttributeError):
        return False


def _is_dataless(p: Path) -> bool:
    """True if *p* (or, for a dir, any immediate child) is evicted/dataless.

    ``SF_DATALESS = 0x40000000``. [VERIFIED on-device: an evicted iCloud file
    reports ``st_flags = 0x40000060``.] Metadata-only; the child scan is bounded to
    the first ``_MAX_CHILD_SCAN`` entries (DoS guard) and uses
    ``follow_symlinks=False`` (symlink-escape guard). Never raises.
    """
    try:
        if bool(os.stat(p).st_flags & stat.SF_DATALESS):
            return True
        if p.is_dir():
            for child in list(p.iterdir())[:_MAX_CHILD_SCAN]:  # bounded scan
                try:
                    if bool(
                        os.stat(child, follow_symlinks=False).st_flags
                        & stat.SF_DATALESS
                    ):
                        return True
                except OSError:
                    continue
    except (OSError, AttributeError):
        return False
    return False
