---
phase: 10
plan: 05
status: accepted
accepted_at: 2026-08-25
issue: 125
fixed_point: db8674f
candidate_commit: d7cfcef59f53426b62b8affdccf288812706aa63
---

# Phase 10 installed-candidate acceptance evidence

This file records the redacted installed-runtime evidence for GitHub issue #125.
It does not update execution checkboxes in the historical GSD plans or validation
strategy.

## Candidate identity

- Exact candidate: `d7cfcef59f53426b62b8affdccf288812706aa63`
- Install ledger: source `dev`, branch `main`, dirty `false`, installed at
  `2026-08-24T17:56:29Z`
- Installed/source server bundle SHA-256:
  `a02dc4014064544e04475383f1bfa08328c98edb927a93812a54cc06afd875d6`
- Installed/source web entry SHA-256:
  `5c5b32648cc3eea8d81123198229423c0e2608bcad1be1c1d977a6da9c093efd`
- Installed UI/audio processes were fresh and alive after installation (PIDs
  `12302` and `12281`); health returned HTTP 200 / `ok`.
- Installed service: `yulu-ui` `0.0.1`, Yulu `0.23.0-rc.3`, Node `v24.19.0`.

## Automated gates

All gates were green before the final installation:

- Shared search suite: 108 passed, 3 skipped.
- Exact Phase 10 focused UI suite (22 files): 319 passed.
- Full UI/server Vitest: 120 files, 897 passed.
- TypeScript typecheck: passed.
- Production build: passed; only the existing bundle-size advisory remained.
- Repository pytest: 956 passed, 2 skipped.
- Credential source/package gates: 31 passed.
- Python compile gate: passed.
- Five Swift binary gates: passed; only the existing unused-variable warning
  remained.
- `git diff db8674f...HEAD --check`: passed.

## Blocking live checkpoint

All evidence below is limited to provider/model/time/result, booleans, counts,
hashes, field shapes, and identifiers for isolated synthetic acceptance work.
No credential value or user meeting content is recorded.

### A. One shared OAuth connection and three independent probes

The installed candidate reused one existing Yulu-managed OAuth connection.
Connection status was `connected=true`, source `oauth`, OAuth connected `true`,
and API key configured `false`.

| Capability | Model | Tested at (UTC) | Result | Credential source |
|---|---|---|---|---|
| transcription | `speech-to-text` | `2026-08-24T18:05:20.919Z` | ready | oauth |
| summary | `grok-4.6` | `2026-08-24T18:05:25.118Z` | ready | oauth |
| conversation | `grok-4.6` | `2026-08-24T18:05:31.886Z` | ready | oauth |

All three results remained independently visible as ready under the same
connection identity.

### B. Production Markdown summary

The exact installed candidate processed an isolated synthetic transcript through
the production summary path:

- Task: `f97ac46e-8cfa-43ca-8e83-ac83233a3530`
- Completed at: `2026-08-24T18:07:05.935Z`
- Provider/model/credential: `xai` / `grok-4.6` / `oauth`
- Attempt/request count: 1 / 1; fallback: false
- Committed transcript: 137 bytes, SHA-256
  `dfad9f67479848e1ffaf3997bb7365c9eeb8704b30413ab12a8a5a8f3ee7ba14`
- Committed Markdown summary: 120 bytes, SHA-256
  `a1230beac678f066b59fe3b606bdccb82db6f6a98d168fad4ccf515c4b7858e1`
- Both disk hashes matched HostStore. The synthetic pilot/date/owner/action facts
  were present in the Markdown result.
- Transcript and summary provenance matched and recorded
  `summaryProvider=xai`, `summaryModel=grok-4.6`, `storageDisabled=true`,
  `credentialSource=oauth`, and `committedBy=yulu-host`.
- Artifact/delivery session IDs were null and tool-name lists were empty.
- Exact-candidate source inspection confirmed transcript-only input,
  `store:false`, no tools, no previous response, and no files.

### C. Bounded cited cross-meeting conversation

The exact installed candidate used a fresh isolated session and exactly two
synthetic indexed meeting transcripts:

- Session: `4e1e6c2b-baa5-4a2d-9c66-c761a7b477cd`
- Provider/model/credential: `xai` / `grok-4.6` / `oauth`
- Public search preflight returned exactly two transcript sources; raw snippets
  were 142 and 114 characters and `fallback=false`.
- The real answer completed with `llmStatus=ok`, no fallback, and accurately
  covered both synthetic decisions, dates, owners, and follow-ups with two
  Yulu-owned local source cards.
- Normalized excerpts were 86 and 80 characters. Remote sources and connector
  outputs were both zero; search owner was Yulu.
- The request contained bounded excerpts/history only: no absolute paths, full
  files, connectors, tools, previous response, or files.
- The underlying TypeScript request caps remained 1,200 characters per source
  and 6,000 characters total.

During an earlier pre-final isolated run, the public search helper ignored the
temporary config directory and reached the production status-agent socket. One
request therefore contained four bounded real local excerpts. It contained no
full files, absolute paths, connectors, or tools, and the model declined to
answer. Acceptance stopped immediately. Commit `21c0ad7` made the search IPC
honor `YULU_CONFIG_DIR`; final preflight and the successful session above proved
that only the two synthetic sources were used. No user source names or content
are retained in this evidence.

### D. Invalid pinned model pauses durably

An isolated throwaway recording pinned
`xai/grok-yulu-acceptance-invalid-model-125` once:

- Task: `b3e13aaa-ccea-4817-af69-41578d40146c`
- State/phase: `awaiting_provider` / `summarizing`
- Attempt: 1
- Event counts: claimed 1, awaiting-provider 1, retry-requested 0, completed 0
- Fifteen-second and later post-audit readbacks both showed no automatic second
  request and no fallback.
- The public recording state exposed explicit same-pinned-model retry and open
  provider-settings actions.
- The error was retained only as safe metadata: 37 characters, SHA-256
  `a2050ddf77876a457813c63f0c7df53536fbe6ecfe9eb69d60f085c2e93f8617`,
  secret-like false.
- The configured summary selection was restored to `xai/grok-4.6` without
  retrying the paused task.

### E. Credential custody

The final audit ran after the real probes and production summary. It inspected
four config/session files, 18 SQLite files, 12 application logs, three process
argv values, and two browser-visible tRPC payload sets (11 payloads total).

For every surface, counts were zero for the acceptance sentinel, serialized
credential values, Bearer material, JWT-shaped material, provider-key-shaped
material, and credential assignments in argv. `oauthTokenMaterialObserved` was
false and `allClear` was true.

- Main payload field-shape SHA-256:
  `1b56710e12c124ba7c277e40eafaec78a1650d05d14d9e090c9ae118cb39784b`
  (5 payloads, 211 field paths)
- Isolated payload field-shape SHA-256:
  `ffa71d3a145c5991f092bfeb3a5b30c403ed1125abca9137920a29c8c15dd65a`
  (6 payloads, 241 field paths)

No token or secret value was printed, copied into this file, or used as a test
fallback.

## Independent review

- Standards axis (ADR-009, AGENTS, CLAUDE, CONTRIBUTING): PASS — zero Critical,
  zero Important. Three non-blocking minor observations remained: duplicated
  highlight expression, existing inline wrapping duplication, and a test-local
  variable name.
- Spec axis (#125 with parent #120): PASS — zero Important, Missing, or Partial
  findings. The final 400-character SQLite excerpt bound plus the TypeScript
  per-source/total caps preserve cross-meeting answers and distractor exclusion.

## Result

Issue #125's automated, installed-runtime, privacy, failure-control, and
credential-custody acceptance requirements are green for the exact candidate
above. This evidence supports commenting on and closing #125 only. Parent issue
#120 remains for the parent integration owner.
