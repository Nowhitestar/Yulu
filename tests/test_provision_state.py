"""PROV-04 — the provision/ state ledger contract (Wave 0).

``provision/state.py`` is the resumable per-step ledger backing
``.yulu-install.json``. It mirrors ``queue_store.py``'s atomic-write primitive
(``tempfile.mkstemp`` + ``os.replace``) and EXTENDS the Phase-1 installer doc
rather than rewriting it.

These tests prove:
  (1) mark() + load() round-trip a steps:{name:{status,ts}} map;
  (2) the ledger is written ATOMICALLY — after a mark the file exists, is valid
      JSON, and the directory carries NO leftover temp files (kill-mid-write
      durability, T-06-05);
  (3) load() on a missing file returns {} (safe degrade);
  (4) load() on "{ not json" returns {} (corrupt → fresh, == read_install_metadata);
  (5) PRESERVE (Pitfall 3 / T-06-07) — a Phase-1-shaped doc {schema:1,
      source:"release", version, sha256} survives a mark(): source/version/sha256
      stay intact AND steps + schema_version are added. Dropping `source` would
      flip lib/common.sh:detect_source into the swiftc dev branch.

Import style mirrors the repo (and test_provision_registry.py): yulu/scripts is
placed on sys.path so `import provision.state` works whether pytest runs from the
repo root (`pytest tests`) or from yulu/scripts (`pytest ../../tests/...`).
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import provision.state as state  # noqa: E402


# ── (1) round-trip ───────────────────────────────────────────────────


def test_mark_then_load_round_trips_steps_map(tmp_path):
    ledger = tmp_path / ".yulu-install.json"
    state.mark(ledger, "deps", "ok")
    state.mark(ledger, "audio", "running", detail="mid-apply")

    doc = state.load(ledger)
    assert doc["schema_version"] == state.SCHEMA_VERSION
    assert doc["steps"]["deps"]["status"] == "ok"
    assert "ts" in doc["steps"]["deps"]
    assert doc["steps"]["audio"]["status"] == "running"
    # detail is carried only when provided.
    assert doc["steps"]["audio"]["detail"] == "mid-apply"
    assert "detail" not in doc["steps"]["deps"]


def test_now_is_iso_z(tmp_path):
    # _now() matches release_installer.write_install_metadata's "...Z" form.
    ts = state._now()
    assert ts.endswith("Z")
    assert "T" in ts and "+00:00" not in ts


# ── (2) atomic write (no temp litter) ────────────────────────────────


def test_ledger_written_atomically_no_temp_litter(tmp_path):
    ledger = tmp_path / ".yulu-install.json"
    state.mark(ledger, "deps", "ok")

    # File exists and is valid JSON (a torn write would fail json.loads).
    assert ledger.exists()
    json.loads(ledger.read_text(encoding="utf-8"))  # raises if partial/corrupt

    # No leftover mkstemp temp files — _atomic_write unlinks the temp in finally and
    # os.replace consumes it on success. The persistent `.<name>.lock` sidecar (the
    # fcntl lock, exactly like queue_store.py's `.agent-queue.lock`) is expected and
    # excluded; what must NOT remain is a mkstemp temp (`.<name>.XXXXXX`).
    lock_name = f".{ledger.name}.lock"
    others = [p.name for p in tmp_path.iterdir() if p.name not in (ledger.name, lock_name)]
    assert others == [], f"unexpected temp litter: {others}"


def test_atomic_write_creates_parent_dirs(tmp_path):
    ledger = tmp_path / "nested" / "dir" / ".yulu-install.json"
    state.mark(ledger, "deps", "ok")
    assert ledger.exists()
    assert state.is_done(ledger, "deps")


# ── (3)(4) missing / corrupt degrade to {} ───────────────────────────


def test_load_missing_file_returns_empty(tmp_path):
    assert state.load(tmp_path / "does-not-exist.json") == {}


def test_load_corrupt_returns_empty(tmp_path):
    ledger = tmp_path / ".yulu-install.json"
    ledger.write_text("{ not json", encoding="utf-8")
    assert state.load(ledger) == {}  # safe degrade, == read_install_metadata


def test_load_non_object_returns_empty(tmp_path):
    # A JSON array (not a dict) is also treated as fresh.
    ledger = tmp_path / ".yulu-install.json"
    ledger.write_text("[1, 2, 3]", encoding="utf-8")
    assert state.load(ledger) == {}


# ── (5) PRESERVE installer keys — Pitfall 3 guard ────────────────────


def test_mark_preserves_installer_source_version_sha256(tmp_path):
    ledger = tmp_path / ".yulu-install.json"
    # Seed a Phase-1-shaped installer doc (release_installer.write_install_metadata
    # form) directly, as the installer would have written it BEFORE provisioning.
    ledger.write_text(
        json.dumps(
            {
                "schema": 1,
                "source": "release",
                "installed_at": "2026-05-30T00:00:00Z",
                "version": "0.5.1",
                "sha256": "abc123",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    state.mark(ledger, "deps", "ok")

    doc = state.load(ledger)
    # Pitfall 3: the installer-written keys MUST survive — losing `source` flips
    # detect_source into the swiftc dev branch on the next update.
    assert doc["source"] == "release"
    assert doc["version"] == "0.5.1"
    assert doc["sha256"] == "abc123"
    assert doc["schema"] == 1  # installer's own schema key untouched
    # ...and the ledger fields are now layered on top.
    assert doc["schema_version"] == state.SCHEMA_VERSION
    assert doc["steps"]["deps"]["status"] == "ok"


def test_mark_preserves_source_across_many_marks(tmp_path):
    ledger = tmp_path / ".yulu-install.json"
    ledger.write_text(
        json.dumps({"schema": 1, "source": "release", "version": "0.5.1"}) + "\n",
        encoding="utf-8",
    )
    for name in ("deps", "audio", "daemons", "ui"):
        state.mark(ledger, name, "ok")
    doc = state.load(ledger)
    assert doc["source"] == "release"  # never clobbered across the whole walk
    assert all(doc["steps"][n]["status"] == "ok" for n in doc["steps"])


# ── is_done / resume_order primitives ────────────────────────────────


def test_is_done_only_true_on_ok(tmp_path):
    ledger = tmp_path / ".yulu-install.json"
    state.mark(ledger, "deps", "ok")
    state.mark(ledger, "audio", "running")
    state.mark(ledger, "daemons", "error", detail="boom")
    state.mark(ledger, "ui", "skipped")
    assert state.is_done(ledger, "deps") is True
    assert state.is_done(ledger, "audio") is False  # running ≠ done
    assert state.is_done(ledger, "daemons") is False  # error ≠ done
    assert state.is_done(ledger, "ui") is False  # skipped ≠ done (was not applied here)
    assert state.is_done(ledger, "never-marked") is False


def test_is_done_missing_ledger_is_false(tmp_path):
    assert state.is_done(tmp_path / "missing.json", "deps") is False


def test_resume_order_missing_steps_returns_all(tmp_path):
    # A fresh ledger (or a pre-Phase-6 install with no `steps`) → every step runs.
    ledger = tmp_path / ".yulu-install.json"
    names = ["deps", "audio", "daemons", "ui"]
    assert state.resume_order(names, ledger) == names


def test_resume_order_preserves_registry_order(tmp_path):
    ledger = tmp_path / ".yulu-install.json"
    state.mark(ledger, "audio", "ok")  # mark out of order
    state.mark(ledger, "deps", "ok")
    names = ["deps", "audio", "daemons", "ui"]
    # deps+audio are ok → dropped; the REST keep registry order (not mark order).
    assert state.resume_order(names, ledger) == ["daemons", "ui"]
