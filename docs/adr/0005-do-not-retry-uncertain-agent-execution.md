# Do not retry uncertain Agent execution

When an Agent invocation times out or loses its transport, Yulu first requests
adapter-specific cancellation. If the adapter cannot prove a terminal outcome,
the work enters Unknown Outcome rather than ordinary failure. Yulu does not
retry automatically, does not commit staged output, and does not assume the
remote operation stopped. The user may wait, restore the original connection,
or explicitly create a new attempt over the preserved input and artifacts.

This sacrifices automatic recovery for at-most-one intentional execution.
Some Agent and Gateway transports may continue work after the local client
disconnects, so an automatic retry could duplicate model cost, summary work, or
connector side effects. Ordinary failures with a proven terminal result remain
eligible for the existing explicit retry path.
