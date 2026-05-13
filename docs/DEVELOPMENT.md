# Yulu Development Workflow

Yulu has five separate layers. Keep them separate:

1. Source repo: the Git checkout you edit and review.
2. Runtime install: the copy launchd/Yulu.app uses to run locally.
3. Config/state: `~/.config/yulu`.
4. Meeting artifacts: `~/Movies/Yulu`.
5. Agent interface: Hermes skill + l-skills backup.

Current dogfood source repo on Lewis's machine is `~/.yulu`. The target developer-friendly checkout is `~/Documents/Codebase/yulu`; move there only after the current dirty worktree has been committed or intentionally migrated.

## Daily loop

```bash
make doctor
make test
make dev-install-dry-run
```

Do not install development code while Yulu is recording. `dev-install-dry-run` checks the audio daemon socket and refuses if it sees an active recording.

## Branch workflow

```bash
git checkout main
git pull origin main
git checkout -b fix/<slug>
make test
# edit
make test
make dev-install-dry-run
git add <files>
git commit -m "fix: <short description>"
git push -u origin HEAD
```

Use PRs for anything that changes runtime behavior, launchd, packaging, or skill semantics.

## Runtime rules

- Do not hand-edit `~/.config/yulu` unless debugging a local state problem.
- Do not commit `.wav`, transcript, summary, logs, sockets, pid files, or local config.
- Do not patch the legacy OpenClaw runtime as the only fix. If an emergency runtime patch is necessary, immediately port it back to the source repo.
- Before migrating launchd paths, run `make doctor` and record existing processes.

## Skill sync

The source skill is `skills/yulu/SKILL.md` inside this repo.

```bash
make sync-skill-dry-run
make sync-skill
```

This syncs to:

- `~/.hermes/skills/leizi/yulu/SKILL.md`
- `~/Documents/Codebase/l-skills/skills/yulu/SKILL.md`

## Third-party code CLI protocol

Each code agent gets one narrow task and one branch/worktree.

```bash
mkdir -p .agent/tasks .agent/runs
git checkout -b fix/<slug>
codex exec --skip-git-repo-check --sandbox workspace-write --ephemeral \
  -o .agent/runs/<slug>.md \
  "Read .agent/tasks/<slug>.md. Implement only that task. Add/update tests. Run required tests. Do not touch unrelated files."
```

For parallel agents, use `git worktree` and never let two agents modify the same checkout.
