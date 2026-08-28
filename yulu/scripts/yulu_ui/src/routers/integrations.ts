import { spawn } from "node:child_process";
import { z } from "zod";
import { router, publicProcedure, uiMutationProcedure } from "../trpc.js";
import { envWithFallbackPath, resolveExecutable } from "../executables.js";

function runSpawn(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    let settled = false;
    const finish = (result: { stdout: string; stderr: string; code: number }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const spawnEnv = envWithFallbackPath(env);
    const proc = spawn(resolveExecutable(cmd, spawnEnv), args, { env: spawnEnv });
    const timer = setTimeout(() => { proc.kill("SIGKILL"); }, timeoutMs);
    proc.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    proc.on("error", (err: Error) => { clearTimeout(timer); finish({ stdout, stderr: stderr || err.message, code: 1 }); });
    proc.on("close", (code: number | null) => { clearTimeout(timer); finish({ stdout, stderr, code: code ?? 1 }); });
  });
}

const accountListItemSchema = z.object({
  email: z.string().min(1),
  services: z.array(z.string()).optional(),
  scopes: z.array(z.string()).optional(),
});

const googleAccountSchema = z.object({
  email: z.string(),
  services: z.array(z.string()),
});
type GoogleAccount = z.infer<typeof googleAccountSchema>;

const calendarListItemSchema = z.object({
  id: z.string(),
  summary: z.string().optional(),
  primary: z.boolean().optional(),
});

const calendarOptionSchema = z.object({
  id: z.string(),
  summary: z.string(),
  primary: z.boolean(),
});
type CalendarOption = z.infer<typeof calendarOptionSchema>;

function accountItemsFromJson(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.items)) return record.items;
    if (Array.isArray(record.accounts)) return record.accounts;
    if (Array.isArray(record.result)) return record.result;
  }
  return [];
}

function hasCalendarAccess(services: string[], scopes: string[]): boolean {
  if (services.includes("calendar")) return true;
  if (scopes.some((scope) => scope.includes("/auth/calendar"))) return true;
  return services.length === 0 && scopes.length === 0;
}

function parseAccountList(stdout: string): GoogleAccount[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const accounts: GoogleAccount[] = [];
  for (const item of accountItemsFromJson(parsed)) {
    const result = accountListItemSchema.safeParse(item);
    if (!result.success) continue;
    const services = result.data.services ?? [];
    const scopes = result.data.scopes ?? [];
    if (!hasCalendarAccess(services, scopes)) continue;
    if (seen.has(result.data.email)) continue;
    seen.add(result.data.email);
    accounts.push({ email: result.data.email, services });
  }
  return accounts;
}

function calendarItemsFromJson(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.items)) return record.items;
    if (Array.isArray(record.calendars)) return record.calendars;
    if (Array.isArray(record.result)) return record.result;
  }
  return [];
}

function parseCalendarList(stdout: string): CalendarOption[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  return calendarItemsFromJson(parsed)
    .map((item) => calendarListItemSchema.safeParse(item))
    .filter((result): result is z.SafeParseSuccess<z.infer<typeof calendarListItemSchema>> => result.success)
    .map(({ data }) => ({
      id: data.primary === true ? "primary" : data.id,
      summary: data.summary || data.id,
      primary: data.primary === true,
    }));
}

export const integrationsRouter = router({
  calendarSources: publicProcedure.query(({ ctx }) => {
    if (!ctx.calendarSources) throw new Error("Calendar Source service is unavailable");
    return ctx.calendarSources.view();
  }),

  selectCalendarSource: uiMutationProcedure
    .input(z.object({
      source: z.enum(["macos", "gog"]),
      account: z.string().trim().max(320).nullable().optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      if (!ctx.calendarSources) throw new Error("Calendar Source service is unavailable");
      const result = ctx.calendarSources.select(input);
      const restartErrors: string[] = [];
      for (const label of ["com.yulu.calendar", "com.yulu.scheduler"] as const) {
        try { await ctx.launchctl.restart(label); }
        catch (error) { restartErrors.push(`${label}: ${(error as Error).message}`); }
      }
      if (restartErrors.length > 0) ctx.calendarSources.markServiceActivationFailed(restartErrors);
      return { ...result, restartErrors, readiness: ctx.calendarSources.view().readiness };
    }),

  probeCalendarSource: uiMutationProcedure.mutation(({ ctx }) => {
    if (!ctx.calendarSources) throw new Error("Calendar Source service is unavailable");
    return ctx.calendarSources.probe();
  }),

  accountList: publicProcedure.query(async () => {
    const { stdout, stderr, code } = await runSpawn(
      "gog",
      ["auth", "list", "--json", "--results-only", "--no-input"],
      process.env,
      10_000,
    );
    if (code !== 0) {
      return { ok: false, accounts: [] as GoogleAccount[], stderr: stderr || stdout || `gog exited ${code}` };
    }
    return {
      ok: true,
      accounts: parseAccountList(stdout),
      stderr,
    };
  }),

  calendarList: publicProcedure
    .input(z.object({ account: z.string() }))
    .query(async ({ input }) => {
      const account = input.account.trim();
      if (!account) {
        return { ok: false, calendars: [] as CalendarOption[], stderr: "account is required" };
      }

      const { stdout, stderr, code } = await runSpawn(
        "gog",
        ["--json", "--results-only", "--no-input", "--account", account, "calendar", "calendars", "--all"],
        process.env,
        10_000,
      );
      if (code !== 0) {
        return { ok: false, calendars: [] as CalendarOption[], stderr: stderr || stdout || `gog exited ${code}` };
      }
      return {
        ok: true,
        calendars: parseCalendarList(stdout),
        stderr,
      };
    }),
});
