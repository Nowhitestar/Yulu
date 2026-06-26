import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "../trpc.js";

type RawEntry = Record<string, unknown>;
const STALE_PROCESSING_MS = 2 * 60 * 60 * 1000;

function readQueue(path: string): RawEntry[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((entry): entry is RawEntry => !!entry && typeof entry === "object" && !Array.isArray(entry)) : [];
  } catch {
    return [];
  }
}

function writeQueue(path: string, queue: RawEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(queue, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function statusOf(entry: RawEntry): string {
  return typeof entry.status === "string" && entry.status ? entry.status : "pending";
}

function isStaleProcessing(entry: RawEntry, now = Date.now()): boolean {
  if (statusOf(entry) !== "processing") return false;
  const raw = entry.processing_at;
  if (!raw) return true;
  const started = Date.parse(String(raw));
  return Number.isNaN(started) || now - started > STALE_PROCESSING_MS;
}

function normalize(entry: RawEntry) {
  const promptSnapshot = String(entry.prompt_content_snapshot ?? "");
  return {
    id: String(entry.id ?? ""),
    type: String(entry.type ?? ""),
    ts: String(entry.ts ?? ""),
    title: String(entry.title ?? ""),
    status: statusOf(entry),
    promptSlug: String(entry.prompt_slug ?? ""),
    promptName: String(entry.prompt_name ?? ""),
    transcriptPath: String(entry.transcript_path ?? ""),
    summaryPath: String(entry.summary_path ?? ""),
    audioPath: String(entry.audio_path ?? ""),
    error: entry.error == null ? "" : String(entry.error),
    processingBy: entry.processing_by == null ? "" : String(entry.processing_by),
    processingAt: entry.processing_at == null ? "" : String(entry.processing_at),
    processedBy: entry.processed_by == null ? "" : String(entry.processed_by),
    processedAt: entry.processed_at == null ? "" : String(entry.processed_at),
    htmlPath: entry.html_path == null ? "" : String(entry.html_path),
    stale: isStaleProcessing(entry),
    promptContentSnapshot: promptSnapshot,
    promptPreview: promptSnapshot.length > 240 ? `${promptSnapshot.slice(0, 240)}...` : promptSnapshot,
  };
}

function mutateEntry(path: string, id: string, updater: (entry: RawEntry) => void) {
  const queue = readQueue(path);
  const entry = queue.find((item) => String(item.id ?? "") === id);
  if (!entry) throw new TRPCError({ code: "NOT_FOUND", message: `queue entry not found: ${id}` });
  updater(entry);
  writeQueue(path, queue);
  return normalize(entry);
}

export const queueRouter = router({
  list: publicProcedure.query(({ ctx }) => {
    const queue = readQueue(ctx.paths.agentQueueJson);
    const entries = queue.map(normalize).reverse();
    const stats = entries.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.status] = (acc[entry.status] ?? 0) + 1;
      return acc;
    }, {});
    return { path: ctx.paths.agentQueueJson, entries, stats, total: entries.length };
  }),

  retry: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => mutateEntry(ctx.paths.agentQueueJson, input.id, (entry) => {
      entry.status = "pending";
      entry.retried_at = new Date().toISOString();
      for (const key of ["error", "processing_by", "processing_at", "processed_by", "processed_at", "dispatch_status", "dispatch_error"]) {
        delete entry[key];
      }
    })),

  cancel: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => mutateEntry(ctx.paths.agentQueueJson, input.id, (entry) => {
      entry.status = "error";
      entry.error = "cancelled from Yulu UI";
      entry.cancelled_at = new Date().toISOString();
      delete entry.processing_by;
      delete entry.processing_at;
    })),

  clearStale: publicProcedure.mutation(({ ctx }) => {
    const queue = readQueue(ctx.paths.agentQueueJson);
    let count = 0;
    for (const entry of queue) {
      if (!isStaleProcessing(entry)) continue;
      entry.status = "pending";
      entry.retried_at = new Date().toISOString();
      delete entry.processing_by;
      delete entry.processing_at;
      delete entry.error;
      count += 1;
    }
    if (count > 0) writeQueue(ctx.paths.agentQueueJson, queue);
    return { ok: true, count };
  }),
});
