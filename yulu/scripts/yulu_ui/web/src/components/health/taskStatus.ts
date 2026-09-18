/** Keep unresolved outcomes visible even when a newer attempt exists. */
export function taskActivity(tasks: readonly { id: string; recordingStem: string; state: string; trigger?: string; updatedAt?: string }[]) {
  const latest = new Map<string, typeof tasks[number]>();
  for (const task of [...tasks].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))) {
    if (!latest.has(task.recordingStem)) latest.set(task.recordingStem, task);
  }
  const uncertain = tasks.filter((task) => ["delivery_unverified", "execution_unverified"].includes(task.state));
  const current = [...latest.values()].filter((task) => !uncertain.some((other) => other.id === task.id));
  const attention = uncertain.length + current.filter((task) => ["failed", "awaiting_agent", "awaiting_provider"].includes(task.state)).length;
  const active = current.filter((task) => ["queued", "running", "transcript_committed", "artifacts_committed", "sending", "delivery_reported"].includes(task.state)).length;
  return { active, attention };
}

export function taskStateKey(state: string) {
  const known = ["queued", "awaiting_agent", "awaiting_provider", "awaiting_policy", "running", "transcript_committed", "artifacts_committed", "sending", "delivery_reported", "delivery_unverified", "execution_unverified", "completed", "failed", "cancelled"];
  return `runtime.task.${known.includes(state) ? state : "unknown"}`;
}
