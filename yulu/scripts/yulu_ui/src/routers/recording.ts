import { router, publicProcedure } from "../trpc.js";
import { ipcSend } from "../ipc.js";

interface StatusReply { ok: boolean; state?: string; hotkey?: string; launcher_pid?: number; }
interface ToggleReply { ok: boolean; state_before?: string; state_after?: string; }

export const recordingRouter = router({
  state: publicProcedure.query(async ({ ctx }) => {
    const r = await ipcSend<StatusReply>(ctx.paths.statusAgentSock, { action: "status" });
    return { state: r.state ?? "unknown", hotkey: r.hotkey ?? "?", launcherPid: r.launcher_pid };
  }),

  toggle: publicProcedure.mutation(async ({ ctx }) => {
    const r = await ipcSend<ToggleReply>(ctx.paths.statusAgentSock, { action: "toggle" });
    return { stateBefore: r.state_before ?? "?", stateAfter: r.state_after ?? "?" };
  }),

  openInbox: publicProcedure.mutation(async ({ ctx }) => {
    await ipcSend(ctx.paths.statusAgentSock, { action: "open_inbox" });
    return { ok: true };
  }),
});
