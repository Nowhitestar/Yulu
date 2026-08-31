# Phase 6 IPC smoke test (manual)

Validates the full Swift → Python → Swift round-trip for the `search`
IPC action. Run on a real machine where the status agent and audio
daemon are deployed. The pytest suite covers the Python helper and the
fake-IPC server path; this doc covers what only a real binary can
exercise.

## Pre-requisites

- `~/Movies/Yulu/` has at least one `.summary.md` and one
  `*.transcript.txt` already produced by a recording.
- `~/Library/Application Support/Yulu/search.sqlite` will be created on first run; or run
  `yulu search --reindex` once after install to pre-populate.

## Build + install the updated agent

```bash
# 1. Rebuild StatusAgent.app with the new IPC `search` case.
bash yulu/scripts/build_status_agent.sh

# 2. Copy into the main worktree (the path launchd loads from).
cp -R yulu/scripts/StatusAgent.app \
      /Users/liaoyuxing/.yulu/yulu/scripts/StatusAgent.app

# 3. Reload via launchctl. (Or `yulu status-agent install`.)
launchctl unload ~/Library/LaunchAgents/com.yulu.statusagent.plist 2>/dev/null
launchctl load   ~/Library/LaunchAgents/com.yulu.statusagent.plist
```

## Round-trip checks

### A. IPC path (agent running)

```bash
yulu status-agent state          # → should print state: idle / recording / ...
yulu search "OKR" --verbose      # IPC path
```

Expected: hits are returned in <100ms; telemetry line shows non-zero
`sweep_ms` + `query_ms`.

### B. In-process fallback (agent stopped)

```bash
launchctl unload ~/Library/LaunchAgents/com.yulu.statusagent.plist
yulu search "OKR" --verbose      # in-process path
launchctl load   ~/Library/LaunchAgents/com.yulu.statusagent.plist
```

Expected: identical hits to part A. The CLI prints the same render; only
the source of the response differs.

### C. JSON output sanity

```bash
yulu search "OKR" --json | python3 -m json.tool
```

Expected: top-level `ok`, `hits`, `elapsed_ms`, `fallback_used` — same
shape from both IPC and in-process paths.

### D. Chinese query routing

```bash
yulu search "项目进度"   # ≥3 chars → FTS5 trigram
yulu search "进度"        # 2 chars → LIKE fallback (fallback_used=true)
```

Expected: both return hits when the term is present; the LIKE path is
slower but still subsecond on the ~38-file corpus.

### E. Filter composition

```bash
yulu search "OKR" --since 7d --type meeting --in summary
```

Expected: only `meeting_summary` rows recorded in the last 7 days.

### F. Doctor + reindex

```bash
yulu search --doctor                 # row counts + last sweep + integrity
yulu search --reindex                # drop + walk; should be quick
yulu search --doctor                 # confirm total_docs unchanged
```
