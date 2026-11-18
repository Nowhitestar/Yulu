# Migrate only verifiable optional outcomes

> Conversation outcome migration is superseded by [yulu ADR-010](../../yulu/spec/adr/010-retire-yulu-conversation.md),
> which retired Yulu-owned conversation.

Yulu creates adopted Optional Capability Outcomes for existing users only when
their durable evidence satisfies the new versioned contract. Exact Conversation
probe and selection evidence may qualify, while legacy calendar configuration,
manual-share logs, and Hermes automatic-delivery history do not; this avoids
turning historical activity into a false claim of current onboarding proof.
