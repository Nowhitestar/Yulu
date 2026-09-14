# Gate stable on an accepted RC and current guidance

Yulu publishes `v0.23.0` stable only from the same source commit as an accepted
`v0.23.0-rc.21`, after green CI, real fresh-install and `v0.22.2` upgrade checks
on the required Apple Silicon environment, and read-back of current repository,
GitHub, and website guidance. The macOS 13 deployment target remains checked but
macOS 13 arm64 is not an acceptance environment for this release.

Acceptance starts from a quarantined public DMG on a clean machine without
Homebrew, host Node, host Python, or Xcode; it covers drag-to-Applications,
Gatekeeper, service and permission recovery, Core Activation through transcript
and summary, restart and login, supported Agent OAuth, Calendar, Test Share,
stable upgrade without duplicate services, RC-to-stable update, and proof that
the signed App remains immutable while running.

The next consolidated candidate includes the no-developer-tools Runtime Pack
check and read-only import probe repairs; the previous public candidate cannot
be promoted without them. This pins the intended promotion source; it is not an
acceptance decision or publication authorization. Reuse applicable unchanged
capability evidence as recorded in `docs/phase13-closeout.md`. Do not inspect password stores or copy
credentials: use the product's non-secret connection status and authorized
functional checks, and state any preservation claim those checks cannot prove.
