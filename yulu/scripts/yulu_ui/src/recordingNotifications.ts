import { ipcSend } from "./ipc.js";
import type { HostStore } from "./hostStore.js";
import type { AppChannels, PubSub } from "./pubsub.js";

export interface RecordingNotice {
  action: "notify";
  kind: "summary_ready" | "processing_attention";
  id: string;
  title: string;
  stem: string;
}

/** Observe new events only. UI progress is not proof of durable completion. */
export function startRecordingNotifications(options: {
  store: Pick<HostStore, "getTask" | "listArtifacts" | "isArtifactPublishPending">;
  pubsub: PubSub<AppChannels>;
  socketPath: string;
  send?: (notice: RecordingNotice) => Promise<{ ok: boolean }>;
  warn?: (message: string) => void;
}): () => void {
  const send = options.send ?? ((notice) => ipcSend<{ ok: boolean }>(options.socketPath, notice));
  const seen = new Set<string>();
  const unavailable = () => (options.warn ?? console.warn)("[notifications] Yulu App notification unavailable");
  return options.pubsub.subscribe("jobs", (event) => {
    try {
      if (event.state !== "done" && event.state !== "failed") return;
      const task = options.store.getTask(event.jobId);
      if (!task || task.recordingStem !== event.stem) return;
      let kind: RecordingNotice["kind"];
      if (event.state === "done") {
        if (task.state !== "completed" || options.store.isArtifactPublishPending(task.id) ||
            !options.store.listArtifacts(task.id).some((artifact) => artifact.kind === "summary")) return;
        kind = "summary_ready";
      } else {
        // Transient failures that the Host will retry should stay inside the App.
        if (!["failed", "awaiting_provider", "execution_unverified"].includes(task.state)) return;
        kind = "processing_attention";
      }
      const id = `${task.id}:${task.attempt}:${kind}`;
      if (seen.has(id)) return;
      if (seen.size >= 256) seen.delete(seen.values().next().value!);
      seen.add(id);
      void send({ action: "notify", kind, id, title: task.title, stem: task.recordingStem })
        .then((reply) => { if (!reply.ok) throw new Error("not accepted"); })
        .catch(unavailable);
    } catch {
      // Notification reads and delivery must never fail the publishing task.
      unavailable();
    }
  });
}
