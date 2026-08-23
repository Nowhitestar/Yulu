---
status: awaiting_human_verify
trigger: "Diagnose and fix Phase 09 RC CI failure: tests/test_release_installer.py::test_raw_stable_bootstrap_fetches_release_owned_latest_installer[args0] cannot read argv.log in GitHub Actions while local full suite passed"
created: 2026-08-23T14:13:12Z
updated: 2026-08-23T14:34:00Z
---

## Current Focus

reasoning_checkpoint:
  hypothesis: "Raw default stable install leaves TARGET_ARGS empty; macOS Bash 3.2 under set -u rejects ${TARGET_ARGS[@]} at the release-installer handoff, so the downloaded installer never runs, and the install script reports status 0 after its cleanup trap."
  confirming_evidence:
    - "Exact CI-compatible PATH reproduces the same missing argv.log while the same Python/test with Homebrew Bash 5.3 passes."
    - "Post-mortem inspection records returncode=0 and stderr='install.sh: line 250: TARGET_ARGS[@]: unbound variable'; stdout stops immediately after 'Release installer downloaded'."
    - "An isolated Bash 3.2 empty-array experiment emits unbound variable and does not create the marker; Bash 5 creates it."
  falsification_test: "The hypothesis would be false if the zero-argument test still failed after invoking the downloaded installer without expanding TARGET_ARGS, or if tracing showed the child fixture executed before argv.log disappeared."
  fix_rationale: "An explicit zero/nonzero argument branch at the single handoff seam preserves no-argument default semantics and all Release ownership/version pinning while avoiding the Bash 3.2 nounset expansion entirely."
  blind_spots: "The causal reproduction is on macOS Bash 3.2 and covers default stable; explicit latest/version/dev use non-empty arrays and still require regression runs."

next_action: hand commit 05a8429 to the release orchestrator; confirmation is the release workflow rerunning this test successfully

## Symptoms

expected: raw stable bootstrap invokes the release-owned installer and records its argv for every supported argument case
actual: GitHub Actions run 32644495948 fails only for parameter args0 because tests/test_release_installer.py line 147 cannot read argv.log; local full suite previously passed
errors: FileNotFoundError for argv.log in test_raw_stable_bootstrap_fetches_release_owned_latest_installer[args0]
reproduction: run the exact failing test under the GitHub Actions shell, environment, and PATH differences; minimized command not yet established
started: after Phase 09 stable bootstrap changes, observed on the v0.23.0-rc.1 candidate CI run

## Eliminated

- hypothesis: the fake curl parser copies a wrong payload under system Bash
  evidence: curl URL assertion passes, stdout confirms the download, and stderr identifies the later TARGET_ARGS expansion at install.sh line 250
  timestamp: 2026-08-23T14:21:00Z

- hypothesis: Python 3.14 or pytest 9 removes or relocates argv.log
  evidence: the identical Python interpreter and pytest node pass when only PATH changes to select Bash 5, and fail when PATH selects Bash 3.2
  timestamp: 2026-08-23T14:21:00Z

- hypothesis: filesystem permissions or symlink resolution prevent fixture writes
  evidence: the same tmp_path and fixture create argv.log under Bash 5; Bash 3.2 stderr shows execution stops before the fixture
  timestamp: 2026-08-23T14:21:00Z

## Evidence

- timestamp: 2026-08-23T14:13:12Z
  checked: upstream CI report
  found: exactly 1 failed, 948 passed, 2 skipped; signing, notarization, packaging, and release did not run
  implication: isolate the raw stable bootstrap test before considering release or signing code

- timestamp: 2026-08-23T14:15:00Z
  checked: GitHub Actions run 32644495948 failed log and reusable workflow
  found: runner is macos-26-arm64; test command is python -m pytest -q under shell /bin/bash; Python 3.14.6 and pytest 9.1.1; return code and curl URL assertions passed before argv.log was missing
  implication: download routing succeeded and the failure is between download completion and execution of the zero-argument release installer fixture

- timestamp: 2026-08-23T14:16:00Z
  checked: exact args0 node under local default PATH versus PATH=/usr/bin:/bin:/usr/sbin:/sbin using the same Python interpreter
  found: default PATH selects Homebrew Bash 5.3.8 and passes; system-only PATH selects /bin/bash 3.2.57 and deterministically fails with the identical missing argv.log symptom
  implication: a Bash 3.2 compatibility difference, not Python or pytest version, is sufficient to reproduce the CI failure

- timestamp: 2026-08-23T14:20:00Z
  checked: pytest post-mortem state for the exact failing node under system PATH
  found: result.returncode is 0; stderr is exactly 'install.sh: line 250: TARGET_ARGS[@]: unbound variable'; stdout ends after 'Release installer downloaded'; argv.log is absent
  implication: the downloaded release installer is not invoked and the cleanup/exit behavior masks the bootstrap failure as success

- timestamp: 2026-08-23T14:21:00Z
  checked: every TARGET_ARGS access and the introducing commit 2689f2c
  found: line 250 is the only empty-array command expansion on the raw default stable path; packaged default is converted to exact --version and raw dev is non-empty
  implication: fix the single stable handoff seam without changing target parsing or security checks

- timestamp: 2026-08-23T14:23:00Z
  checked: permanent regression seam using /bin/bash in the existing default/latest parameterized test
  found: args0 fails before the production change with the exact missing argv.log symptom
  implication: the repository now has a deterministic macOS system-Bash regression check at the real bootstrap boundary

- timestamp: 2026-08-23T14:25:00Z
  checked: minimized args0 loop and both default/latest cases after the explicit handoff branch
  found: args0 passes under /bin/bash; both parameter cases pass under PATH=/usr/bin:/bin:/usr/sbin:/sbin
  implication: the minimal fix addresses the reproduced mechanism without changing explicit argument forwarding

- timestamp: 2026-08-23T14:27:00Z
  checked: full tests/test_release_installer.py plus install.sh syntax and ShellCheck
  found: 94 passed; bash -n and shellcheck both exit 0
  implication: default, explicit latest/version/dev, packaged pairing, guard, rollback, and installer shell contracts remain green

- timestamp: 2026-08-23T14:29:00Z
  checked: Phase 09 combined Python regression group
  found: 196 passed across package release, release installer, recording guard, setup decomposition, and provision registry
  implication: the fix does not regress adjacent Phase 09 distribution or onboarding contracts

- timestamp: 2026-08-23T14:31:00Z
  checked: full make test with Clang, Swift, and build outputs redirected to /private/tmp
  found: 935 passed, 16 skipped; all five Makefile Swift targets compiled; only a pre-existing unused-variable warning appeared in window_scanner.swift
  implication: repository-wide automated regression verification is green

- timestamp: 2026-08-23T14:34:00Z
  checked: atomic source/test commit
  found: commit 05a8429 records the true Bash 3.2 nounset root cause and changes only install.sh plus tests/test_release_installer.py
  implication: the release orchestrator can build a new immutable candidate from a reviewed, scoped fix

## Resolution

root_cause: Raw default stable installation expands an empty TARGET_ARGS array under set -u at install.sh line 250. macOS system Bash 3.2 treats that expansion as an unbound variable, never executes the downloaded Release-owned installer, and exits through cleanup with status 0, which hid the failure until the fixture artifact assertion.
fix: The bootstrap regression test now invokes macOS /bin/bash explicitly. install.sh calls the downloaded release installer without an array expansion when TARGET_ARGS is empty, and preserves the original array forwarding for explicit targets.
verification: Exact args0 and default/latest system-PATH loops pass; tests/test_release_installer.py 94 passed; Phase 09 combined group 196 passed; bash -n and ShellCheck pass; make test reports 935 passed, 16 skipped and five Swift targets compiled.
files_changed: [install.sh, tests/test_release_installer.py, .planning/phases/09-release-safety/09-01-SUMMARY.md]
