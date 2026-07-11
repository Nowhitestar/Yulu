# Yulu Development Workflow

Yulu has five separate layers. Keep them separate:

1. Source repo: the Git checkout you edit and review.
2. Runtime install: the copy launchd/Yulu.app uses to run locally.
3. Config/state: `~/.config/yulu`.
4. Meeting artifacts: `~/Movies/Yulu`.
5. Agent boundary: authenticated MCP servers, Hermes phase toolsets, and the Yulu skill.

Keep the editable checkout separate from `~/.yulu`, which is the installed
runtime used by LaunchAgents.

## Daily loop

```bash
make doctor
make test
cd yulu/scripts/yulu_ui && npm ci && npm run typecheck && npm test && npm run build
cd -
make dev-install-dry-run
```

Do not install development code while Yulu is recording. `dev-install-dry-run` checks the audio daemon socket and refuses if it sees an active recording.
After reviewable tests pass, run `make dev-install` and verify the installed
runtime with `~/.local/bin/yulu doctor --json`, `/healthz`, and the phase MCP
registrations.

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

Use PRs for anything that changes runtime behavior, launchd, packaging, or skill
semantics. Use a Conventional Commit/PR title; release-please owns `VERSION`,
`CHANGELOG.md`, release tags, and the normal release PR.

## Runtime rules

- Do not hand-edit `~/.config/yulu` unless debugging a local state problem.
- Do not commit `.wav`, transcript, summary, logs, sockets, pid files, or local config.
- Fix the source checkout first, then synchronize it with `make dev-install`; never leave a runtime-only patch as the source of truth.
- Before migrating launchd paths, run `make doctor` and record existing processes.

## Skill sync

The source skill is `skills/yulu/SKILL.md` inside this repo.

```bash
make sync-skill-dry-run
make sync-skill
```

For an end-user-style install, prefer the supported command instead:

```bash
yulu skill install --agent <agent-name>
```

For parallel work, use separate worktrees or explicitly non-overlapping files;
never let two writers mutate the same checkout without coordination.
