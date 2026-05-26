export type Listener<T> = (msg: T) => void;

/**
 * Tiny typed pub/sub for cross-cutting events (recording state, daemon
 * status changes, sidebar count invalidation). Routers publish; the
 * WebSocket multiplexer subscribes.
 */
export class PubSub<Channels extends Record<string, unknown>> {
  private subs = new Map<string, Set<Listener<unknown>>>();

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
    const set = this.subs.get(channel);
    if (!set) return;
    for (const fn of set) (fn as Listener<Channels[K]>)(msg);
  }

  subscriberCount(channel: string): number {
    return this.subs.get(channel)?.size ?? 0;
  }
}

export type AppChannels = {
  "recording":       { state: "idle" | "recording" | "processing" | "meetingBusy" | "daemonDown"; file?: string; elapsedSec?: number; level?: number; };
  "daemons":         { name: string; status: "running" | "stopped" | "crashed"; pid: number; lastLog?: string; };
  "sidebar-counts":  { voicemails: number; meetings: number; prompts: number; glossary: number; };
  "logs":            { name: string; line: string; ts: number; };
};

export const appPubSub = new PubSub<AppChannels>();
