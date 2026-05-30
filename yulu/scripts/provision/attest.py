"""Fail-closed asset-integrity gate (PROV-03, D-03 — ASVS V10 supply-chain CORE).

This is the headline supply-chain control of Phase 6: verify a downloaded
release asset BEFORE any provisioning step's ``apply()`` runs, and REJECT a
tampered asset fail-closed. Callers (the Plan-04 CLI / the download flow) MUST
call ``verify_asset`` FIRST — no ``step.apply()`` may run until it returns a PASS.
A tampered asset raises ``TamperError`` before any step executes.

The gh-auth fallback LADDER (RESEARCH Pattern 3 / Pitfall 1 — verified live):

    gh present AND `gh attestation verify` exit 0   -> "attestation"  (PASS)
    gh exit 4 (UNAUTHENTICATED — the public-repo limitation cli/cli #11803)
        OR gh ABSENT                                -> SHA-256 checksums.txt
                                                       floor (NOT a rejection)
    gh present + a NON-4 nonzero verify (tamper /
        missing attestation)                        -> the checksum must
                                                       INDEPENDENTLY confirm,
                                                       else TamperError

The decisive, non-obvious finding (RESEARCH Pitfall 1): ``gh attestation verify``
REQUIRES authentication to fetch attestations from the GitHub API and returns
**exit code 4** when unauthenticated — even for the public ``Nowhitestar/Yulu``
repo. So gating on ``command -v gh`` alone is WRONG: an unauthenticated gh
exit-4s on every verify. We gate on present-AND-(verify==0); exit-4 and gh-absent
both degrade to the SHA-256 ``checksums.txt`` FLOOR, the non-negotiable fallback
(D-03). A non-4 nonzero on an authed gh is a tamper / missing-attestation signal
that REQUIRES the checksum to independently confirm before proceeding — never a
silent downgrade to checksum-pass on the verify failure alone.

The checksum floor REUSES ``release_installer.verify_checksum`` /
``parse_checksums`` (Don't-Hand-Roll: those handle the ``*name`` BSD-format and
hex-validation edge cases and are already tested) — never a fresh hashlib loop.

All subprocess calls use argv LISTS (no ``shell=True``); ``REPO`` and the verify
flags are literals and the asset path is a ``Path`` argument, never
shell-interpolated (T-06-14).

Scope note (RESEARCH Pitfall 5 / Q1): ``verify_asset`` operates on an *asset*
(a downloaded zip + its checksums.txt) to verify. When provisioning an
already-installed tree with NO fresh asset (e.g. ``yulu provision deps`` on an
extracted ``~/.yulu``), the gate is N/A — the tree's integrity was established by
whatever installed it. The CLI therefore SKIPS the gate when no ``--asset`` is
supplied, and applies it (fail-closed, FIRST) on the asset-download path.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import release_installer  # REUSE its verified checksum helpers (do not re-implement)

# The repository whose CI (release-publish.yml, actions/attest-build-provenance@v4)
# mints the attestation this gate verifies. A literal — never caller-supplied.
REPO = "Nowhitestar/Yulu"

# `gh attestation verify` exit code for "authentication required" (gh help
# exit-codes: 0 ok / 1 fail / 2 cancel / 4 auth required). Treated as a FALLBACK
# trigger (use checksum), NOT a rejection — the public-repo unauth limitation
# cli/cli #11803.
_GH_EXIT_UNAUTHENTICATED = 4


class TamperError(RuntimeError):
    """Fail-closed integrity-failure signal: the asset did NOT verify.

    Raised (BEFORE any provisioning step runs) when an authed ``gh attestation
    verify`` fails and the checksum cannot corroborate, when the SHA-256 checksum
    mismatches, or when the asset is absent from ``checksums.txt``.
    """


def _gh_present() -> bool:
    """True iff the ``gh`` CLI is on PATH. Presence alone is NOT sufficient to
    gate on attestation (an unauthenticated gh exit-4s on every verify — see the
    module docstring / RESEARCH Pitfall 1); the ladder also inspects the verify
    return code."""
    return shutil.which("gh") is not None


def verify_asset(zip_path: Path, checksums_path: Path, asset_name: str) -> str:
    """Verify a downloaded release asset; return the method used.

    Returns ``"attestation"`` (an authed ``gh attestation verify`` passed) or
    ``"checksum"`` (the SHA-256 ``checksums.txt`` floor confirmed integrity).
    Raises :class:`TamperError` (fail-closed) on ANY integrity failure — and it
    raises BEFORE any provisioning step's ``apply()`` runs, so a tampered asset
    never reaches a step (D-03).

    The ladder is load-bearing and fail-closed (RESEARCH Pattern 3):

    1. gh present AND ``verify`` exit 0 -> ``"attestation"`` (the ONLY PASS that
       skips the checksum floor).
    2. gh present AND ``verify`` exit 4 (unauthenticated) -> fall through to the
       checksum FLOOR (NOT a rejection).
    3. gh present AND ``verify`` a NON-4 nonzero (tamper / missing attestation)
       -> the checksum must INDEPENDENTLY confirm; if it cannot, ``TamperError``.
       Never a silent downgrade to checksum-pass on the verify failure alone
       (RESEARCH anti-pattern; T-06-12).
    4. gh absent -> the checksum FLOOR (the non-negotiable D-03 fallback).
    """
    # 1) Prefer gh attestation IF gh is present AND authenticated.
    if _gh_present():
        proc = subprocess.run(
            ["gh", "attestation", "verify", str(zip_path), "--repo", REPO],
            capture_output=True,
            text=True,
        )
        if proc.returncode == 0:
            return "attestation"  # PASS — authed verify succeeded
        if proc.returncode == _GH_EXIT_UNAUTHENTICATED:
            pass  # unauthenticated (cli/cli #11803) → fall through to checksum floor
        else:
            # gh present but verify FAILED with a non-4 nonzero → tamper / missing
            # attestation. Do NOT silently downgrade to checksum-only: require the
            # checksum to INDEPENDENTLY confirm, and reject if it cannot.
            stderr = (proc.stderr or "").strip()
            _verify_checksum_or_raise(
                zip_path,
                checksums_path,
                asset_name,
                cause=f"gh attestation verify exited {proc.returncode}: {stderr[-300:]}",
            )
            return "checksum"  # checksum corroborated integrity despite the verify failure

    # 2) gh absent OR exit-4 unauthenticated → checksum is the non-negotiable
    #    floor (D-03).
    _verify_checksum_or_raise(zip_path, checksums_path, asset_name)
    return "checksum"


def _verify_checksum_or_raise(
    zip_path: Path, checksums_path: Path, asset_name: str, cause: str = ""
) -> None:
    """The non-negotiable SHA-256 floor. Parse ``checksums.txt``, look up the
    asset's expected digest, and verify it via ``release_installer.verify_checksum``
    (REUSE — no fresh hashlib loop). Raise :class:`TamperError` if the asset is
    unlisted or the digest mismatches. ``cause`` (optional) appends the upstream
    reason (e.g. the failing gh exit) to the error for diagnosis."""
    suffix = f" ({cause})" if cause else ""
    checksums = release_installer.parse_checksums(
        checksums_path.read_text(encoding="utf-8")
    )
    expected = checksums.get(asset_name)
    if expected is None:
        raise TamperError(f"checksums.txt does not list {asset_name}{suffix}")
    try:
        release_installer.verify_checksum(zip_path, expected)  # raises InstallError on mismatch
    except release_installer.InstallError as exc:
        raise TamperError(f"{exc}{suffix}") from exc
