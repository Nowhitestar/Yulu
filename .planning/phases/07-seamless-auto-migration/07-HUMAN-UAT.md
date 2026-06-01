---
status: partial
phase: 07-seamless-auto-migration
source: [07-VERIFICATION.md]
started: 2026-05-30T08:30:00Z
updated: 2026-05-30T08:30:00Z
---

## Current Test

[awaiting human testing — requires a real v0.5.x ~/.yulu install + the live daemon stack. Code is complete + fixture-tested: 819 pytest pass, transactional backup→verify→prune-on-success, recording-guard, byte-for-byte rollback, source-preservation all unit-proven with a fake legacy tree + mocked daemon status. These 2 are the only checks that need a real machine.]

## Tests

### 1. Real v0.5.x ~/.yulu end-to-end upgrade (MIG-01/03)
expected: On a machine with a genuine v0.5.x `~/.yulu` — run `yulu migrate` → detect→plan→apply→verify completes with NO data loss (recordings/transcripts/vocab/prompts/summaries intact), NO reconfiguration prompted, `.yulu-install.json` `source` preserved, `schema_version` stamped, dead `mlx_python` dropped, `~/Movies/Yulu` routed via PathResolver, and the backup pruned ONLY after verify passed. `yulu migrate --dry-run` first shows the plan without mutating. A forced failure → `yulu rollback` restores the prior state byte-for-byte.
result: [pending]

### 2. Live in-flight-recording guard (MIG-02)
expected: Start a recording (audio_daemon actively writing a WAV) → trigger `yulu migrate` → it REFUSES to stop the audio daemon (raises RecordingActive), no daemon stopped, the WAV is NOT truncated. End the recording → migration proceeds. No `pkill -9` anywhere.
result: [pending]

## Summary

total: 2
passed: 0
issues: 0
pending: 2
skipped: 0
blocked: 0

## Gaps

None — code-complete + fixture-tested (transactional/guard/rollback/source-preservation all unit-proven). These 2 are real-legacy-install confirmations only. Detail in 07-03-SUMMARY.md "Pending Human Verification".
