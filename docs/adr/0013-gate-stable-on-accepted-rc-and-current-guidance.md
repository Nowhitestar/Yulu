# Gate stable on an accepted RC and current guidance

Yulu publishes `v0.23.0` stable only from the same source commit as accepted
`v0.23.0-rc.21`: `ef9828a3d241acde0d05c8908e1d7b4023878760`. Candidate build
1666 becomes stable build 1667 without intervening product changes. CI and
signed public-artifact verification remain required, followed by live stable
feed/guidance readback and the normal whole-App update before phase closure.

## September 15 acceptance decision

The project owner explicitly accepted stopping VM repetitions and closing on
the existing physical Mac. #170 records the completed public-RC21 artifact,
installed-service, normal reopen and data-preservation checks. Applicable
recording, transcription, summary and manual-sharing evidence is reused with
its original version and scope. No new OAuth login or external share is needed.

The exact public RC21 default-local-runtime fresh-install journey and full
public `v0.22.2` upgrade were **not re-run end to end**. Existing internal-App,
genuine-legacy and component evidence is retained, not relabeled. Additional
cloud, lifecycle and rollback repetitions are accepted residual validation
risks, not passes or a new execution queue. This decision supersedes this ADR's
earlier full fresh-machine matrix. The VM stays stopped. macOS 13 remains a
deployment target, not an acceptance environment.

#171 owns stable publication and its separate public update checks. Current
evidence boundaries are summarized in `docs/release-notes/v0.23.0.md`; detailed
dated history remains in `docs/phase13-closeout.md`. Do not inspect password
stores or copy credentials, silently switch providers, reset permissions,
patch signed Apps or replay external writes to improve a status badge.
