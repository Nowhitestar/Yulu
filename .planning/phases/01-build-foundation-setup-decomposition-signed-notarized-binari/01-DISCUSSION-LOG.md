# Phase 1: Build Foundation — Setup Decomposition + Signed/Notarized Binaries - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-29
**Phase:** 1-Build Foundation — Setup Decomposition + Signed/Notarized Binaries
**Areas discussed:** Python runtime ownership, Signing & notarization credentials, setup.sh decomposition, platform ABC scope

---

## Python Runtime Ownership

| Option | Description | Selected |
|--------|-------------|----------|
| Host system python3 | No bundled Python; remove venv-mlx-whisper, daemon uses system python3; sidesteps hardest notarization case; Phase 3 probes system interpreter; fixes dead mlx_python field | ✓ |
| Bundled Python | Self-contained, version-controlled runtime; but Python is the hardest thing to notarize and it conflicts with reuse-host philosophy | |
| You decide | Default to ROADMAP recommendation (host) | |

**User's choice:** Host system python3
**Notes:** Matches the "reuse host capabilities" principle and the ROADMAP "Decision to log". Inferences captured in CONTEXT D-01..D-05 (remove venv, fix mlx_python, signing excludes Python, mlx-whisper acquisition deferred to capabilities script / Phase 5).

---

## Signing & Notarization — Credential Mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| notarytool + API key | App Store Connect API key (.p8 + Key ID + Issuer ID); altool deprecated; no Apple ID/2FA; revocable; CI-friendly | ✓ |
| Apple ID + app-specific password | Traditional; ties to a personal Apple account; 2FA/password rotation friction | |
| You decide | Default to notarytool + API key | |

**User's choice:** notarytool + API key
**Notes:** CI-first credential model. Signing details (bottom-up, never --deep, notarize+staple) captured in CONTEXT D-07.

---

## Signing & Notarization — Identity Recording Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| All via secret + env | CONTEXT records only the mechanism (YULU_CODESIGN_IDENTITY env + all creds in GitHub secrets); no sensitive value in docs | (Claude) |
| Paste Team ID now | Record exact identity / Team ID in CONTEXT for the planner | |
| You decide | Default to all-via-secret | |

**User's choice:** *Dismissed* — user declined to answer this question, then delegated all remaining decisions to Claude ("后面全部你决定吧… 跳过讨论… 直接进入 plan").
**Notes:** Claude chose "all via secret + env" (CONTEXT D-08) — safest, honors the YULU_CODESIGN_IDENTITY design and the secrets-never-in-docs rule.

---

## setup.sh Decomposition

**User's choice:** Delegated to Claude.
**Notes:** Decided in CONTEXT D-10..D-14 — per-concern scripts (`set -uo pipefail`, idempotent, isolated re-run) under a thin top-level orchestrator, sized to map 1:1 onto Phase 6 provision steps; dev/release compile fork; fold in install_plist + nvm-PATH fixes.

---

## platform ABC Scope

**User's choice:** Delegated to Claude.
**Notes:** Decided in CONTEXT D-15..D-18 — `platform/base.py` defines all 4 Python-side seam ABCs (PathResolver / DaemonManager / PermissionModel / DependencyManager) as signatures only, linux/windows raise NotImplementedError; Swift CaptureBackend + macOS impls deferred to Phase 2.

---

## Claude's Discretion

User explicitly delegated the identity recording strategy (after dismissing the question) and the entire setup.sh-decomposition and platform-ABC areas, citing previously-agreed principles and a desire to skip ahead to planning. Claude decided D-08 and D-10..D-18 from the locked project principles + ROADMAP/CONCERNS.

## Deferred Ideas

None new. Adjacent fragilities (curl|bash verification, backup cleanup, open -W daemon-stop, security items) are already mapped to later phases by ROADMAP/REQUIREMENTS.
