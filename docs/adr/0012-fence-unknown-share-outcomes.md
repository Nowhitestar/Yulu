# Fence unknown Share outcomes

A Share Action with an Unknown Outcome remains fenced and is never retried as an
ordinary failure. The user may keep waiting, reconcile a verified receipt,
abandon the old attempt, or explicitly create a new attempt, preserving intent
and preventing duplicate Notion pages or Zulip messages after transport loss.
