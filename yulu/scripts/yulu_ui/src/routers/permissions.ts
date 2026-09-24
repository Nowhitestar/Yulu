import { z } from "zod";
import { ipcSend } from "../ipc.js";
import { publicProcedure, router, uiMutationProcedure } from "../trpc.js";

const permission = z.enum(["microphone", "systemAudio", "input", "notifications"]);
const captureSchema = z.object({
  micReady: z.boolean(), sysReady: z.boolean(),
  sysPermission: z.enum(["unknown", "granted", "check_failed"]).optional(),
  recording: z.boolean().optional(), sysDisabled: z.boolean().optional(),
});
const nativeSchema = z.object({
  ok: z.literal(true),
  macos_major: z.number().int().positive(),
  accessibility_trusted: z.boolean(),
  event_posting_allowed: z.boolean(),
  hotkeys_ready: z.boolean(),
  notifications: z.enum(["granted", "denied", "not_determined", "unknown"]),
});

function state(value: boolean | undefined) {
  return value === true ? "ready" as const : value === false ? "needs_attention" as const : "unknown" as const;
}

export const permissionsRouter = router({
  status: publicProcedure.query(async ({ ctx }) => {
    const [captureReply, nativeReply] = await Promise.allSettled([
      ipcSend(ctx.paths.audioDaemonSock, { action: "status" }),
      ipcSend(ctx.paths.statusAgentSock, { action: "permission_status" }),
    ]);
    const capture = captureSchema.safeParse(captureReply.status === "fulfilled" ? captureReply.value : null);
    const native = nativeSchema.safeParse(nativeReply.status === "fulfilled" ? nativeReply.value : null);
    const audio = capture.success ? capture.data : undefined;
    const app = native.success ? native.data : undefined;
    const systemAudio = captureReply.status === "rejected" ? "check_failed" as const
      : audio?.sysPermission === "granted" ? "ready" as const
      : audio?.sysPermission === "check_failed" ? "check_failed" as const
      // Older Capture versions cannot distinguish idle mic-only mode from a
      // failed permission check. Only their positive observation is conclusive.
      : audio?.sysPermission === undefined && audio?.sysReady ? "ready" as const : "unknown" as const;
    // Only native observations may mark access ready. Never return paths or raw IPC errors.
    return {
      checkedAt: new Date().toISOString(),
      macosMajor: app?.macos_major ?? null,
      voiceInputEnabled: ctx.config.read().status_agent.enabled,
      microphone: captureReply.status === "rejected" ? "check_failed" as const : state(audio?.micReady),
      systemAudio,
      systemAudioCapturing: audio?.recording === undefined || audio.sysDisabled === undefined ? null
        : audio.recording && !audio.sysDisabled && audio.sysReady,
      input: nativeReply.status === "rejected" ? "check_failed" as const
        : state(app ? app.accessibility_trusted && app.event_posting_allowed && app.hotkeys_ready : undefined),
      notifications: nativeReply.status === "rejected" ? "check_failed" as const : app?.notifications ?? "unknown" as const,
    };
  }),
  openSettings: uiMutationProcedure.input(z.object({ permission })).mutation(async ({ ctx, input }) => {
    const reply = await ipcSend<{ ok?: boolean }>(ctx.paths.statusAgentSock, {
      action: "open_permission_settings", permission: input.permission,
    });
    if (reply.ok !== true) throw new Error("Could not open permission settings");
    // Opening a pane or requesting access is not proof of a grant.
    return { opened: true };
  }),
});
