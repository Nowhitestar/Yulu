# AI Agent Workflow for Yulu

Yulu is an AI-native app, but agent work must be controlled. The agent loop is:

1. Capture problem from dogfooding.
2. Write a narrow task file.
3. Give one code CLI one branch/worktree.
4. Require tests and a run summary.
5. Review diff and run `make test`.
6. Install only after validation.
7. Release only from clean, reviewed source.

## Task file template

Create `.agent/tasks/YYYY-MM-DD-<slug>.md`:

```markdown
# Task: <title>

## Background

## Goal

## Non-goals

## Files likely involved

## Constraints

- Do not modify `~/Library/Application Support/Yulu`.
- Do not modify `~/Movies/Yulu`.
- Do not commit secrets, logs, recordings, transcripts, or local config.
- Do not change unrelated files.
- Preserve local-first behavior.

## Reproduction / current behavior

## Expected behavior

## Required tests

## Acceptance criteria
```

## Codex example

```bash
cd <yulu repo>
git checkout -b fix/<slug>

codex exec \
  --skip-git-repo-check \
  --sandbox workspace-write \
  --ephemeral \
  -o .agent/runs/<slug>.md \
  "Read .agent/tasks/YYYY-MM-DD-<slug>.md. Implement only that task. Add or update tests. Run the required tests. Do not touch unrelated files. Summarize what changed and what tests passed."
```

## Review checklist

Before accepting agent output:

- `git diff` only touches files relevant to the task.
- Tests were added or updated for behavior changes.
- `make test` passes locally.
- `make dev-install-dry-run` does not report active recording.
- No local paths, logs, transcripts, recordings, tokens, or credentials were added.
- If skill behavior changed, `make sync-skill-dry-run` shows expected updates.

## Parallel agents

Use worktrees:

```bash
mkdir -p ~/Documents/Codebase/yulu-worktrees
git worktree add ~/Documents/Codebase/yulu-worktrees/fix-queue -b fix/queue-worker
git worktree add ~/Documents/Codebase/yulu-worktrees/refactor-packaging -b refactor/packaging
```

One agent per worktree. Never share a checkout between agents.
