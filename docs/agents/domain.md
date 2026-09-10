# Domain Docs

This repository uses a single domain context.

Before changing behavior, read the relevant terms in the root `CONTEXT.md` and
the relevant records under the existing `yulu/spec/adr/` and `docs/adr/` trees.
The latter includes the current App, onboarding, and release-acceptance decisions.

`CONTEXT.md` is a glossary of domain language, not an implementation spec.
Extend the existing glossary when needed. Add an ADR alongside the related
existing decisions only when it is hard to reverse, surprising without context,
and involves a real trade-off; do not create another glossary or ADR tree.

Use canonical glossary terms in issues, specifications, tests, and code.
Surface conflicts with an existing ADR instead of silently overriding it.
