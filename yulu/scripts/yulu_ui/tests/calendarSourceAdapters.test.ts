import { basename } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createCalendarSourceAdapters,
  type CalendarCommandRunner,
} from "../src/calendarSourceAdapters.js";

const window = {
  start: "2026-08-29T02:00:00.000Z",
  end: "2026-08-30T02:00:00.000Z",
};

function runner(result: Awaited<ReturnType<CalendarCommandRunner["run"]>>) {
  return { run: vi.fn(async () => result) } satisfies CalendarCommandRunner;
}

describe("production Calendar Source adapters", () => {
  it("uses only Yulu's native EventKit helper and accepts a successful empty enumeration", async () => {
    const command = runner({
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        access: "granted",
        enumerationSucceeded: true,
        eventCount: 0,
        ...window,
      }),
      stderr: "",
      errorCode: null,
    });
    const adapters = createCalendarSourceAdapters({ scriptDir: "/Applications/Yulu.app/Contents/Resources/yulu/scripts", runner: command });

    await expect(adapters.macos.probe({ ...window, account: null })).resolves.toEqual({
      ok: true,
      adapter: "eventkit",
      eventCount: 0,
      ...window,
    });
    const [executable, args] = (command.run as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[], number];
    expect(basename(executable)).toBe("calendar_probe");
    expect(args).toEqual(["--start", window.start, "--end", window.end]);
    expect(command.run).toHaveBeenCalledWith(executable, args, 35_000);
    expect(`${executable} ${args.join(" ")}`).not.toMatch(/osascript|gog|CLIProxyAPI/i);
  });

  it.each([
    ["authorization_denied", "Calendar access was denied"],
    ["authorization_restricted", "Calendar access is restricted"],
    ["authorization_not_determined", "Calendar access is still not determined"],
  ] as const)("preserves EventKit %s without exposing helper output", async (reason, detail) => {
    const command = runner({
      code: 2,
      stdout: JSON.stringify({ ok: false, reason, detail: "token=must-not-leak" }),
      stderr: "secret helper error",
      errorCode: null,
    });
    const adapters = createCalendarSourceAdapters({ scriptDir: "/runtime/scripts", runner: command });

    const result = await adapters.macos.probe({ ...window, account: null });

    expect(result).toMatchObject({ ok: false, reason, detail });
    expect(JSON.stringify(result)).not.toMatch(/must-not-leak|secret helper error/);
  });

  it("classifies a missing native helper without falling back to osascript", async () => {
    const command = runner({ code: 1, stdout: "", stderr: "spawn ENOENT", errorCode: "ENOENT" });
    const adapters = createCalendarSourceAdapters({ scriptDir: "/runtime/scripts", runner: command });

    await expect(adapters.macos.probe({ ...window, account: null })).resolves.toMatchObject({
      ok: false,
      reason: "runtime_missing",
    });
    expect(command.run).toHaveBeenCalledTimes(1);
  });

  it("enumerates a bounded gog event window through fixed non-interactive argv", async () => {
    const command = runner({
      code: 0,
      stdout: JSON.stringify({ events: [] }),
      stderr: "",
      errorCode: null,
    });
    const adapters = createCalendarSourceAdapters({ scriptDir: "/runtime/scripts", runner: command });

    await expect(adapters.gog.probe({ ...window, account: "me@example.com" })).resolves.toEqual({
      ok: true,
      adapter: "gog-cli",
      eventCount: 0,
      ...window,
    });
    expect(command.run).toHaveBeenCalledWith("gog", [
      "--json",
      "--results-only",
      "--no-input",
      "--account",
      "me@example.com",
      "calendar",
      "events",
      "primary",
      "--all-pages",
      "--from",
      window.start,
      "--to",
      window.end,
    ], 15_000);
  });

  it("accepts a non-empty gog enumeration only when every item has valid start and end evidence", async () => {
    const command = runner({
      code: 0,
      stdout: JSON.stringify({ events: [{
        id: "event-1",
        start: { dateTime: "2026-08-29T03:00:00Z" },
        end: { dateTime: "2026-08-29T04:00:00Z" },
      }] }),
      stderr: "",
      errorCode: null,
    });
    const adapters = createCalendarSourceAdapters({ scriptDir: "/runtime/scripts", runner: command });

    await expect(adapters.gog.probe({ ...window, account: "me@example.com" })).resolves.toMatchObject({
      ok: true,
      eventCount: 1,
    });
  });

  it.each([
    [[null]],
    [[{ error: "unauthorized" }]],
    [[{ start: { dateTime: "2026-08-29T03:00:00Z" } }]],
    [[{
      start: { dateTime: "not-a-date" },
      end: { dateTime: "2026-08-29T04:00:00Z" },
    }]],
  ])("fails closed on malformed gog event evidence %j", async (events) => {
    const command = runner({
      code: 0,
      stdout: JSON.stringify({ events }),
      stderr: "",
      errorCode: null,
    });
    const adapters = createCalendarSourceAdapters({ scriptDir: "/runtime/scripts", runner: command });

    await expect(adapters.gog.probe({ ...window, account: "me@example.com" })).resolves.toMatchObject({
      ok: false,
      reason: "enumeration_failed",
    });
  });

  it.each([
    [{ code: 1, stdout: "", stderr: "spawn gog ENOENT", errorCode: "ENOENT" }, "runtime_missing"],
    [{ code: 1, stdout: "", stderr: "not authenticated; run gog auth", errorCode: null }, "authorization_denied"],
    [{ code: 1, stdout: "", stderr: "upstream unavailable", errorCode: null }, "enumeration_failed"],
    [{ code: 0, stdout: "not json", stderr: "", errorCode: null }, "enumeration_failed"],
  ] as const)("classifies gog failures as %s", async (commandResult, reason) => {
    const command = runner(commandResult);
    const adapters = createCalendarSourceAdapters({ scriptDir: "/runtime/scripts", runner: command });

    const result = await adapters.gog.probe({ ...window, account: "me@example.com" });

    expect(result).toMatchObject({ ok: false, reason });
    if (commandResult.stderr) expect(JSON.stringify(result)).not.toContain(commandResult.stderr);
  });
});
