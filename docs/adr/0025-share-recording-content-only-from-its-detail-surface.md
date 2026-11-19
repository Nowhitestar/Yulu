# Share recording content only from its detail surface

> The Agent Console mention is superseded by [yulu ADR-010](../../yulu/spec/adr/010-retire-yulu-conversation.md),
> which retired Yulu-owned conversation.

Real recording content may be shared only from that recording or summary detail
surface. The Agent Connection Center owns runtime authorization and Connector
readiness, Settings and Onboarding reuse one Sharing surface for destinations and
Test Shares, and Agent Console remains diagnostic rather than sending meeting
content. This keeps configuration, proof, and each external write visibly separate.
