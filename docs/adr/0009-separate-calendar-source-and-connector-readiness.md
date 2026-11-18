# Separate Calendar Source and connector readiness

> Interactive Agent calendar access is superseded by [yulu ADR-010](../../yulu/spec/adr/010-retire-yulu-conversation.md),
> which retired Yulu-owned conversation.

Yulu treats meeting-schedule access and interactive Agent calendar access as two
independent optional capabilities with separate readiness evidence. The guided
path prefers calendars already available through macOS, keeps direct Google
authorization as an advanced path, and never treats a configured account or an
empty event window as proof of failure or success by itself.
