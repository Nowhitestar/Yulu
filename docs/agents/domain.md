# Domain Docs

This repository uses a single domain context.

Before changing an area, read the root `CONTEXT.md` when present and the
relevant records under `docs/adr/`.

`CONTEXT.md` is a glossary of domain language, not an implementation spec.
Create it only when the first term is resolved. Create `docs/adr/` only when
a decision is hard to reverse, surprising without context, and involves a
real trade-off.

Use canonical glossary terms in issues, specifications, tests, and code.
Surface conflicts with an existing ADR instead of silently overriding it.
