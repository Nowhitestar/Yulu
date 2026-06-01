"""D-04 / Pitfall 3 — the in-transit corrections apply.py makes during migration.

The migration corrects three known fragilities in transit, NON-destructively:
  * drop the dead ``transcription.mlx.python`` field (Phase 1 removed the venv);
  * route a hardcoded ``~/Movies/Yulu`` ``audio.output_dir`` through PathResolver —
    but LEAVE a user's already-custom output_dir UNTOUCHED (never reconfigure);
  * stamp ``schema_version`` while PRESERVING the installer ``source`` (Pitfall 3 /
    T-07-10: dropping source flips the next update into the swiftc dev branch).

These tests prove:
  (1) drop mlx_python — after apply the field is GONE and the rest of config is intact;
  (2) route ~/Movies/Yulu — the hardcoded default is rewritten to the resolver path;
  (3) custom output_dir — an already-custom path is LEFT UNTOUCHED;
  (4) schema_version stamp + PRESERVE source — the ledger gains schema_version and its
      original ``source`` ("release") survives.

These exercise the correction helpers directly (so they run off-Darwin too — the
path_route resolver is monkeypatched), plus one end-to-end apply asserting the
composed result. Import style mirrors test_migrate_recording_guard.py.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from migrate import apply as apply_mod  # noqa: E402
from migrate.apply import apply_migration  # noqa: E402
from migrate.detect import detect_migration  # noqa: E402
from migrate.plan import build_plan  # noqa: E402
from provision import state as state_mod  # noqa: E402


class _StubManager:
    def __init__(self):
        self.unloaded = []

    def unload(self, label):
        self.unloaded.append(label)


def _send_idle(_cmd):
    return {"recording": False}


def _write_config(config_dir: Path, doc: dict) -> Path:
    config_dir.mkdir(parents=True, exist_ok=True)
    path = config_dir / "config.json"
    path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    return path


# ── (1) drop the dead transcription.mlx.python field; preserve the rest ──


def test_drop_mlx_python_removes_field_preserves_rest(tmp_path):
    config_dir = tmp_path / "cfg"
    _write_config(
        config_dir,
        {
            "transcription": {
                "final_engine": "mlx",
                "language": "zh",
                "mlx": {
                    "python": "~/.config/yulu/venv-mlx-whisper/bin/python",
                    "model": "mlx-community/whisper-large-v3-mlx",
                },
            },
            "audio": {"format": "wav"},
        },
    )

    reasons = []
    apply_mod._apply_drop_mlx_python(config_dir, reasons)

    data = json.loads((config_dir / "config.json").read_text(encoding="utf-8"))
    # The dead field is gone...
    assert "python" not in data["transcription"]["mlx"]
    # ...and everything else is preserved unchanged.
    assert data["transcription"]["mlx"]["model"] == "mlx-community/whisper-large-v3-mlx"
    assert data["transcription"]["final_engine"] == "mlx"
    assert data["transcription"]["language"] == "zh"
    assert data["audio"] == {"format": "wav"}
    assert any("transcription.mlx.python" in r for r in reasons)


def test_drop_mlx_python_noop_when_absent(tmp_path):
    config_dir = tmp_path / "cfg"
    _write_config(config_dir, {"transcription": {"mlx": {"model": "m"}}})
    before = (config_dir / "config.json").read_bytes()

    reasons = []
    apply_mod._apply_drop_mlx_python(config_dir, reasons)

    # No field to drop → config untouched, no reason recorded.
    assert (config_dir / "config.json").read_bytes() == before
    assert reasons == []


# ── (2) route hardcoded ~/Movies/Yulu via PathResolver ──


def test_route_recording_dir_rewrites_hardcoded_default(tmp_path, monkeypatch):
    config_dir = tmp_path / "cfg"
    _write_config(config_dir, {"audio": {"output_dir": "~/Movies/Yulu", "format": "wav"}})

    # Monkeypatch the resolver so the test runs off-Darwin and is deterministic.
    monkeypatch.setattr(apply_mod, "_resolver_data_dir", lambda: "~/Movies/Yulu-resolved")

    reasons = []
    apply_mod._apply_route_recording_dir(config_dir, reasons)

    data = json.loads((config_dir / "config.json").read_text(encoding="utf-8"))
    assert data["audio"]["output_dir"] == "~/Movies/Yulu-resolved"
    assert data["audio"]["format"] == "wav"  # siblings preserved
    assert any("PathResolver" in r for r in reasons)


# ── (3) a custom output_dir is LEFT UNTOUCHED (never reconfigure) ──


def test_route_recording_dir_leaves_custom_untouched(tmp_path, monkeypatch):
    config_dir = tmp_path / "cfg"
    _write_config(config_dir, {"audio": {"output_dir": "~/Dropbox/MyMeetings"}})
    before = (config_dir / "config.json").read_bytes()

    # Even if the resolver would offer a path, a custom output_dir must NOT be rewritten.
    monkeypatch.setattr(apply_mod, "_resolver_data_dir", lambda: "~/Movies/Yulu-resolved")

    reasons = []
    apply_mod._apply_route_recording_dir(config_dir, reasons)

    assert (config_dir / "config.json").read_bytes() == before
    assert reasons == []


def test_route_recording_dir_noop_when_resolver_unavailable(tmp_path, monkeypatch):
    config_dir = tmp_path / "cfg"
    _write_config(config_dir, {"audio": {"output_dir": "~/Movies/Yulu"}})
    before = (config_dir / "config.json").read_bytes()

    # Off Darwin the resolver returns None → the correction is a safe no-op.
    monkeypatch.setattr(apply_mod, "_resolver_data_dir", lambda: None)

    reasons = []
    apply_mod._apply_route_recording_dir(config_dir, reasons)

    assert (config_dir / "config.json").read_bytes() == before
    assert reasons == []


# ── (4) schema_version stamp + PRESERVE source (Pitfall 3 / T-07-10) ──


def test_schema_stamp_preserves_source(tmp_path):
    install_dir = tmp_path / "dot-yulu"
    install_dir.mkdir()
    (install_dir / ".yulu-install.json").write_text(
        json.dumps({"schema": 1, "source": "release", "version": "0.5.1"}, indent=2) + "\n",
        encoding="utf-8",
    )

    reasons = []
    apply_mod._apply_schema_stamp(install_dir, reasons)

    ledger = json.loads((install_dir / ".yulu-install.json").read_text(encoding="utf-8"))
    assert ledger["schema_version"] == state_mod.SCHEMA_VERSION
    # Pitfall 3: the installer-written source MUST survive the stamp.
    assert ledger["source"] == "release"
    assert ledger["version"] == "0.5.1"
    assert any("schema_version" in r for r in reasons)


def test_schema_stamp_preserves_dev_source(tmp_path):
    install_dir = tmp_path / "dot-yulu"
    install_dir.mkdir()
    (install_dir / ".yulu-install.json").write_text(
        json.dumps({"schema": 1, "source": "dev", "branch": "main", "commit": "abc1234"}, indent=2)
        + "\n",
        encoding="utf-8",
    )

    apply_mod._apply_schema_stamp(install_dir, [])

    ledger = json.loads((install_dir / ".yulu-install.json").read_text(encoding="utf-8"))
    assert ledger["source"] == "dev", "a dev install must keep its dev source"
    assert ledger["branch"] == "main"
    assert ledger["commit"] == "abc1234"
    assert ledger["schema_version"] == state_mod.SCHEMA_VERSION


# ── end-to-end: all three corrections compose through apply_migration ──


def test_all_corrections_compose_end_to_end(tmp_path, monkeypatch):
    install_dir = tmp_path / "dot-yulu"
    install_dir.mkdir()
    (install_dir / ".yulu-install.json").write_text(
        json.dumps({"schema": 1, "source": "release", "version": "0.5.1"}, indent=2) + "\n",
        encoding="utf-8",
    )
    config_dir = tmp_path / "cfg"
    _write_config(
        config_dir,
        {
            "audio": {"output_dir": "~/Movies/Yulu"},
            "transcription": {"mlx": {"python": "/dead/path", "model": "m"}},
        },
    )
    monkeypatch.setattr(apply_mod, "_resolver_data_dir", lambda: "~/Movies/Yulu-resolved")

    need = detect_migration(install_dir, config_dir)
    plan = build_plan(need)
    result = apply_migration(
        need, plan, install_dir, config_dir,
        manager=_StubManager(), socket_send=_send_idle,
    )

    assert result.ok is True
    cfg = json.loads((config_dir / "config.json").read_text(encoding="utf-8"))
    assert "python" not in cfg["transcription"]["mlx"]
    assert cfg["audio"]["output_dir"] == "~/Movies/Yulu-resolved"
    ledger = json.loads((install_dir / ".yulu-install.json").read_text(encoding="utf-8"))
    assert ledger["schema_version"] == state_mod.SCHEMA_VERSION
    assert ledger["source"] == "release"
