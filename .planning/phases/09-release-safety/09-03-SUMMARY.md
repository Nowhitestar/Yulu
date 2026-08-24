---
phase: 09-release-safety
plan: 03
subsystem: distribution
tags: [installer, optional-dependencies, release-candidate, clean-host, live-recording]

requires:
  - phase: 09-release-safety
    plan: 01
    provides: version-paired stable bootstrap and trusted recording guard
  - phase: 09-release-safety
    plan: 02
    provides: macOS 13 deployment-target gate for all five shipped binaries
provides:
  - core-first dependency readiness without automatic Homebrew installation
  - detected-only non-fatal Agent registration and deferred calendar activation
  - accepted signed v0.23.0-rc.3 candidate across asset, live-recording, and clean-host boundaries
affects: [phase-10, phase-13, onboarding, release-publish]

tech-stack:
  added: []
  patterns: [postcondition-first dependencies, exact opt-in optional tooling, real-host release checkpoint]

key-files:
  created:
    - .planning/phases/09-release-safety/09-03-SUMMARY.md
  modified:
    - yulu/scripts/setup.sh
    - yulu/scripts/setup_deps.sh
    - tests/test_setup_decomposition.py
    - tests/test_provision_registry.py
    - tests/test_package_release.py

key-decisions:
  - "Core setup reuses ffmpeg, sox, and a compatible Node and never bootstraps Homebrew."
  - "Agent registration is detected-only/non-fatal; calendar tooling and service installation require exact opt-in."
  - "v0.23.0-rc.3 is accepted for Phase 9 only; public latest-stable remains v0.22.2 and belongs to Phase 13."

requirements-completed: [DIST-04]

duration: ~4 h real-host checkpoint
completed: 2026-08-24
---

# Phase 9 Plan 03: Core-Only Install and RC Acceptance Summary

The signed `v0.23.0-rc.3` candidate passed the Phase 9 exact-asset, live-recording refusal, legacy staged-guard, and clean-host core-install boundaries without becoming public latest stable.

## Accomplishments

- Made dependency setup postcondition-first: ready `ffmpeg`, `sox`, and compatible Node are reused, missing Homebrew is read-only guidance, and no remote Homebrew bootstrap remains.
- Made all four Agent registrations one detected-only/non-fatal operation; zero Agents is a successful core-install state.
- Deferred Google Calendar and its LaunchAgent by default; `gog`, `cloudflared`, and the calendar plist require exact opt-in.
- Accepted one traceable signed/notarized candidate against release bytes, real active-recording refusal paths, a legacy staged guard, and a new macOS VM.
- Proved the clean install beyond process labels by loading the browser UI, reaching both audio readiness flags, and recording/stopping/decoding a real WAV.

## Task Commits

1. **Task 1: Make dependency setup core-first**
   - `a508e71` — `test(09-03): add failing core dependency boundary tests`
   - `4805d34` — `feat(09-03): make dependency setup core-first`
2. **Task 2: Make optional activation non-blocking**
   - `fbd5e2c` — `test(09-03): add failing optional activation tests`
   - `3951ba6` — `test(09-03): reject setup-time provider selection`
   - `daf09d1` — `feat(09-03): make optional activation non-blocking`
3. **Task 3: Real signed-candidate checkpoint**
   - Human/runtime evidence recorded below; no product source change was needed.

## Exact Candidate Evidence

| Item | Evidence |
|------|----------|
| Candidate | GitHub pre-release [`v0.23.0-rc.3`](https://github.com/Nowhitestar/Yulu/releases/tag/v0.23.0-rc.3), tag commit `c7cef2682828af026cab3c83553f264424c24072` |
| Credentialed workflow | GitHub Actions [run `32646068956`](https://github.com/Nowhitestar/Yulu/actions/runs/32646068956) succeeded; build-provenance attestation `42428392` |
| `install.sh` | SHA-256 `2fcedb219c9dbf3ab8b7d9ef85c382f0355af5cee1e9ec8ee770af19d70fbebd` |
| Runtime zip | SHA-256 `7fc8bec7e46f410ff8748f64d4dac51689a766136c6e04ff3ec5e8ade6923e2f` |
| `checksums.txt` | SHA-256 `87cc0b96ae019aafef48db940829ffdafb03a5b1b2236800608ec974aafd1436` |
| Candidate gates | Remote bytes, checksum, signed runtime manifest, Developer ID signatures, notarization/stapling, Gatekeeper, SLSA attestation, packaged tag pairing, and all-five-binary `vtool minos 13.0` checks passed |
| Channel safety | Candidate stayed a pre-release; public `releases/latest` remained `v0.22.2` |

## Live Recording Safety Evidence

- A real current-host recording was active before both the version-pinned release reinstall and the dev update path.
- Both commands refused non-zero before setup/runtime mutation. Before/after VERSION, install metadata, daemon PID observations, and recording path remained unchanged while the WAV continued growing.
- After explicit user stop, the WAV remained valid and decodable.
- A legacy pre-v0.6 fixture used the checksum/signature/manifest-verified staged guard and refused before runtime swap while recording was active.

## Clean-Host Evidence

- VM: `Yulu Clean Host Validation` (`1652d2fc-af43-4cb3-a417-ad5bbca0728a`), macOS 26.5 build 25F71, arm64, fresh `yuluvalidation` account.
- Initial inventory found no Homebrew, Yulu, Node, ffmpeg, SoX, Hermes, OpenClaw, Codex, Claude Code, gog, cloudflared, terminal-notifier, Agent config roots, or user LaunchAgents.
- Test prerequisites were staged under `~/.local` only: Python 3.12.13, Node 22.22.3, npm 10.9.8, ffmpeg 6.0, and SoX. Homebrew remained absent. Python is the documented installer prerequisite; npm accompanied the otherwise bare Node test binary.
- The downloaded public `install.sh` hash matched the candidate and exited 0. The installed ledger reports release `v0.23.0-rc.3` and runtime asset hash `7fc8bec7e46f410ff8748f64d4dac51689a766136c6e04ff3ec5e8ade6923e2f`.
- UI returned `<title>Yulu 语录</title>` and `/healthz` returned `{"status":"ok"}`. `com.yulu.ui`, scheduler, detector, status agent, and the native audio app started; after normal TCC consent the socket reported `sysReady=true`, `micReady=true`, and `recording=false`.
- A real smoke recording `/Users/yuluvalidation/Movies/Yulu/RC3CleanHostSmoke_20260824_153730.wav` was saved as 16-bit stereo PCM at 48 kHz, duration 112.7 seconds, 21,638,482 bytes, and decoded fully with ffmpeg.
- Post-install inventory still found no Homebrew or optional Agent/calendar commands/config roots. Installed LaunchAgents were only audio, detector, scheduler, status, and UI; `com.yulu.calendar.plist` was absent.
- Source macOS VM remained stopped, the prior RC3 clone remained stopped, and Windows 11 remained suspended.

## Automated Verification

- Phase 9 targeted regression: `196 passed in 54.74s`.
- `bash -n` and ShellCheck on installer/package/deployment/setup scripts: passed.
- Credentialed candidate workflow and exact extracted-asset checks: passed.
- Full Python suite: `935 passed, 16 skipped`; all five Swift smoke sources compiled successfully after giving the compiler its normal module-cache access.
- UI suite under the matching Node 24 ABI: `116` files / `847` tests passed; TypeScript typecheck and production server/web builds passed.

## Deviations and Findings

- The clean macOS 26.5 image had no usable `python3`; the documented Python 3.10+ prerequisite had to be staged explicitly. This is an onboarding/documentation gap for Phase 13, not a silent package-manager mutation.
- The bare Node test bundle did not include npm, while the UI release setup correctly requires it for `npm ci`; npm 10.9.8 was staged alongside Node before the exact installer ran.
- `npm audit --omit=dev` on the installed RC3 tree reports 3 high and 2 moderate findings (`fast-uri`, `ip-address`, `react-router`, Hono packages). No lockfile mutation was made during acceptance; dependency remediation requires a new candidate before public stable release.

## macOS 13 Hardware Waiver

macOS 13 arm64 hardware/runtime acceptance is **WAIVED**, not PASS. The exact candidate's five shipped binaries still passed the mandatory automated `vtool` `minos 13.0` gate.

## Next Phase Readiness

- Phase 10 may proceed with provider/xAI work; Phase 9 no longer blocks it.
- Before Phase 13 public stable acceptance, resolve the production npm audit findings and make the Python/npm prerequisite explicit or provide an approved first-run path.
- Public `releases/latest` smoke, final README alignment, and stable promotion remain Phase 13 DOCS-03.

## Self-Check: PASSED

- All three real-world evidence groups are tied to the same signed candidate.
- Clean-host runtime, optional-mutation, UI, daemon, and real WAV observations were read back after installation.
- No public stable release was published or claimed.
