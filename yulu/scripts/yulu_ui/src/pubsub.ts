export type Listener<T> = (msg: T) => void;

/**
 * Tiny typed pub/sub for cross-cutting events (recording state, daemon
 * status changes, sidebar count invalidation). Routers publish; the
 * WebSocket multiplexer subscribes.
 */
export class PubSub<Channels extends Record<string, unknown>> {
  private subs = new Map<string, Set<Listener<unknown>>>();
  private last = new Map<string, unknown>();

  subscribe<K extends keyof Channels & string>(
    channel: K,
    fn: Listener<Channels[K]>
  ): () => void {
    let set = this.subs.get(channel);
    if (!set) { set = new Set(); this.subs.set(channel, set); }
    set.add(fn as Listener<unknown>);
    return () => { set!.delete(fn as Listener<unknown>); };
  }

  publish<K extends keyof Channels & string>(channel: K, msg: Channels[K]): void {
    this.last.set(channel, msg);
    const set = this.subs.get(channel);
    if (!set) return;
    for (const fn of set) (fn as Listener<Channels[K]>)(msg);
  }

  subscriberCount(channel: string): number {
    return this.subs.get(channel)?.size ?? 0;
  }

  latest<K extends keyof Channels & string>(channel: K): Channels[K] | undefined {
    return this.last.get(channel) as Channels[K] | undefined;
  }
}

export type AppChannels = {
  "recording":       { state: "idle" | "recording" | "processing" | "meetingBusy" | "daemonDown"; file?: string; elapsedSec?: number; level?: number; };
  "daemons":         { name: string; status: "running" | "idle" | "stopped" | "crashed"; pid: number; lastLog?: string; };
  "recordings-changed": { reason: "added" | "removed" | "changed" };
  "core-activation": { taskId: string; recordingStem: string };
  "logs":            { name: string; line: string; ts: number; };
  "jobs":            { stem: string; jobId: string; state: "transcribing" | "summarizing" | "done" | "failed"; error?: string };
  "realtime-transcript": {
    status: "starting" | "transcribing" | "finished" | "failed";
    stem: string;
    title?: string;
    language: "zh" | "en" | "ja" | "auto";
    text: string;
    stableText?: string;
    partialText?: string;
    captionProvider?: string;
    captionMode?: "streaming" | "segmented";
    coveredMs: number;
    trusted: boolean;
    sequence?: number;
    sourceText?: string;
    sourceLanguage?: "zh" | "en" | "ja" | "auto";
    translationText?: string;
    targetLanguage?: string;
    translationStatus?: "disabled" | "pending" | "ready" | "failed";
    startedAt?: string;
    emittedAt?: string;
    reason?: string | null;
    error?: string;
  };
};

export const appPubSub = new PubSub<AppChannels>();
