# Yulu Development Workflow

Yulu has five separate layers. Keep them separate:

1. Source repo: the Git checkout you edit and review.
2. Runtime install: the copy launchd/Yulu.app uses to run locally.
3. Config/state: `~/Library/Application Support/Yulu`.
4. Meeting artifacts: `~/Movies/Yulu`.
5. Agent boundary: authenticated MCP servers, Hermes phase toolsets, and the Yulu skill.

Keep the editable checkout separate from `~/.yulu`, which is the development
runtime used by `make dev-install`. Public releases run from
`/Applications/Yulu.app`.

## Daily loop

Follow the [Engineering Workflow](../CLAUDE.md#engineering-workflow). Select
checks for the behavior and risk being changed; these are command references,
not a mandatory full-suite sequence. Documentation-only changes normally need
diff, reference, and consistency checks. Reuse relevant passing evidence unless
the code, environment, or a new observation warrants repeating it.

```bash
make doctor
make test
cd yulu/scripts/yulu_ui && npm ci && npm run typecheck && npm test && npm run build
cd -
make dev-install-dry-run
```

Do not install development code while Yulu is recording. `dev-install-dry-run` checks the audio daemon socket and refuses if it sees an active recording.
When the task includes an authorized development-runtime installation, run
`make dev-install` after the affected checks pass, then inspect that installed
runtime with `~/.local/bin/yulu doctor --json`, `/healthz`, and the relevant MCP
registrations. Signed public-DMG acceptance instead installs the complete signed
App; development installation is not a substitute.

## Branch workflow

Inspect the worktree first and preserve existing edits. When a separate branch is
needed, choose its base deliberately; do not switch to `main` or pull over ongoing
work just to follow an example. For an agent-created branch:

```bash
git status --short --branch
git switch -c codex/<slug>
# implement the requested change and run its affected checks
git add <files>
git commit -m "fix: <short description>"
```

Publishing (`git push -u origin HEAD`), merging, and deployment require their
explicitly authorized scope; this example is not authorization for them.

Use PRs for anything that changes runtime behavior, launchd, packaging, or skill
semantics. Use a Conventional Commit/PR title; release-please owns `VERSION`,
`CHANGELOG.md`, release tags, and the normal release PR.

## Runtime rules

- Do not hand-edit `~/Library/Application Support/Yulu` unless debugging a local state problem.
- Do not commit `.wav`, transcript, summary, logs, sockets, pid files, or local config.
- Keep repairs in the source checkout; never leave a runtime-only patch as the source of truth. Synchronize a development install with `make dev-install` only when installed-runtime changes are in scope. Signed Apps are replaced as whole signed units.
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
