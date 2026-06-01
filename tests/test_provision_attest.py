"""PROV-03 — the provision/ fail-closed asset-integrity gate (Wave 0).

``provision/attest.py`` is the supply-chain control of Phase 6: it verifies a
downloaded release asset BEFORE any provisioning step's ``apply()`` runs, and
REJECTS a tampered asset fail-closed via ``TamperError``.

The gate is a 3-way ladder on ``gh`` (RESEARCH Pattern 3 / Pitfall 1):

  * gh present AND ``gh attestation verify`` exit 0  -> "attestation" (PASS)
  * gh exit 4 (UNAUTHENTICATED — the public-repo limitation cli/cli #11803)
    OR gh ABSENT                                     -> SHA-256 checksums.txt
                                                        floor (NOT a rejection)
  * gh present + a NON-4 nonzero verify (tamper /
    missing attestation)                             -> the checksum must
                                                        INDEPENDENTLY confirm,
                                                        else TamperError
                                                        (never silently
                                                        downgrade a hard verify
                                                        failure to checksum-pass)

The checksum floor REUSES ``release_installer.verify_checksum`` /
``parse_checksums`` (no hand-rolled hashlib loop — Don't-Hand-Roll).

These tests prove (each WITHOUT a real release asset or real gh auth, by
corrupting a fake fixture zip + monkeypatching ``shutil.which`` /
``subprocess.run``):
  (1) tamper REJECTED via the checksum floor when gh is ABSENT — fail-closed,
      before any apply() can run;
  (2) an unauthenticated gh (exit 4) FALLS BACK to the checksum floor (PASS,
      NOT a rejection);
  (3) an authed gh whose verify==0 PASSES via attestation (no checksum needed);
  (4) a NON-4 gh failure REJECTS when the checksum also cannot confirm;
  (5) a NON-4 gh failure is CORROBORATED by an untampered checksum (PASS via
      the floor);
  (6) an asset NOT listed in checksums.txt is REJECTED.

Import style mirrors the repo (and test_provision_state.py /
test_provision_registry.py): yulu/scripts is placed on sys.path so
`import provision.attest` and the reused `release_installer` import both work
whether pytest runs from the repo root (`pytest tests`) or from yulu/scripts
(`pytest ../../tests/...`).
"""

import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import provision.attest as attest  # noqa: E402

# Reuse the real-zip + checksums.txt fixture builder from the release-installer
# integration test (RESEARCH: do not re-derive a fake asset). build_fake_asset
# writes a genuine zip in tmp_path and a checksums.txt listing its SHA-256.
from test_release_installer_integration import build_fake_asset  # noqa: E402


def _completed(returncode: int, stderr: str = ""):
    """A stand-in subprocess.CompletedProcess for a monkeypatched gh call."""
    return subprocess.CompletedProcess(
        args=["gh", "attestation", "verify"], returncode=returncode, stdout="", stderr=stderr
    )


# ── (1) tamper REJECTED via the checksum floor, gh ABSENT (fail-closed) ──


def test_tamper_rejected_via_checksum(tmp_path, monkeypatch):
    zip_path, checksums = build_fake_asset(tmp_path)
    # Corrupt the asset AFTER its checksum was computed → the SHA-256 no longer
    # matches checksums.txt.
    zip_path.write_bytes(zip_path.read_bytes() + b"TAMPER")
    # Simulate gh ABSENT so the gate falls to the non-negotiable checksum floor.
    monkeypatch.setattr(attest.shutil, "which", lambda _name: None)
    with pytest.raises(attest.TamperError, match="Checksum mismatch"):
        attest.verify_asset(zip_path, checksums, zip_path.name)


# ── (2) unauthenticated gh (exit 4) FALLS BACK to checksum (PASS) ────────


def test_unauthenticated_gh_falls_back_to_checksum(tmp_path, monkeypatch):
    zip_path, checksums = build_fake_asset(tmp_path)  # untampered
    monkeypatch.setattr(attest.shutil, "which", lambda _name: "/usr/bin/gh")
    # exit 4 == unauthenticated (cli/cli #11803): a FALLBACK trigger, NOT a
    # rejection. The untampered checksum then confirms.
    monkeypatch.setattr(
        attest.subprocess, "run", lambda *a, **k: _completed(4, "auth required")
    )
    assert attest.verify_asset(zip_path, checksums, zip_path.name) == "checksum"


# ── (3) authed gh, verify==0 → "attestation" (no checksum needed) ────────


def test_gh_authed_verify_passes(tmp_path, monkeypatch):
    zip_path, checksums = build_fake_asset(tmp_path)
    monkeypatch.setattr(attest.shutil, "which", lambda _name: "/usr/bin/gh")
    monkeypatch.setattr(attest.subprocess, "run", lambda *a, **k: _completed(0))
    # Belt-and-suspenders: even a checksums.txt that would NOT match must be
    # irrelevant on the attestation-pass path (verify==0 is the only PASS that
    # skips the checksum floor).
    checksums.write_text("0" * 64 + f"  {zip_path.name}\n", encoding="utf-8")
    assert attest.verify_asset(zip_path, checksums, zip_path.name) == "attestation"


# ── (4) NON-4 gh failure REJECTS when the checksum cannot confirm ────────


def test_gh_hard_failure_rejects_when_checksum_cannot_confirm(tmp_path, monkeypatch):
    zip_path, checksums = build_fake_asset(tmp_path)
    zip_path.write_bytes(zip_path.read_bytes() + b"TAMPER")  # checksum WILL mismatch
    monkeypatch.setattr(attest.shutil, "which", lambda _name: "/usr/bin/gh")
    # A non-4 nonzero on a present gh = tamper / missing attestation signal.
    monkeypatch.setattr(
        attest.subprocess, "run", lambda *a, **k: _completed(1, "verification failed")
    )
    with pytest.raises(attest.TamperError):
        attest.verify_asset(zip_path, checksums, zip_path.name)


# ── (5) NON-4 gh failure CORROBORATED by an untampered checksum (PASS) ──


def test_gh_hard_failure_corroborated_by_checksum(tmp_path, monkeypatch):
    zip_path, checksums = build_fake_asset(tmp_path)  # UNtampered → checksum matches
    monkeypatch.setattr(attest.shutil, "which", lambda _name: "/usr/bin/gh")
    monkeypatch.setattr(
        attest.subprocess, "run", lambda *a, **k: _completed(1, "verification failed")
    )
    # The checksum independently confirms integrity even though attestation was
    # unavailable → PASS via the floor (never on the verify failure alone).
    assert attest.verify_asset(zip_path, checksums, zip_path.name) == "checksum"


# ── (6) an asset NOT listed in checksums.txt is REJECTED ─────────────────


def test_checksums_missing_asset_rejected(tmp_path, monkeypatch):
    zip_path, checksums = build_fake_asset(tmp_path)
    # checksums.txt lists a DIFFERENT name → no expected digest for our asset.
    checksums.write_text("a" * 64 + "  some-other-asset.zip\n", encoding="utf-8")
    monkeypatch.setattr(attest.shutil, "which", lambda _name: None)  # gh absent → floor
    with pytest.raises(attest.TamperError, match="does not list"):
        attest.verify_asset(zip_path, checksums, zip_path.name)
