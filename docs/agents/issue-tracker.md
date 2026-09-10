# Issue tracker: GitHub

Issues and specs for this repo live as GitHub Issues. Use the `gh` CLI and
infer the repository from `git remote -v`.

## Conventions

- Reuse relevant existing specs and tickets. Create a new one with
  `gh issue create` only when the task or coordination needs it; a new spec or
  ticket is not a prerequisite for every bounded change.
- Read the complete ticket and comments with `gh issue view <number> --comments`.
- Update labels with `gh issue edit`.
- Record implementation results in the issue before closing it.
- Pull requests are not treated as feature-request or triage surfaces.
- Issue creation, updates, and closure are external writes and must remain within
  the user's authorized scope. Labels or old checkboxes alone do not establish
  current readiness or missing implementation.
