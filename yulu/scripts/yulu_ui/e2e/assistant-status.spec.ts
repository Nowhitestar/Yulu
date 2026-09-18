import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("yulu_ui.lang", "zh"); document.addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.yuluNative = "true"; }); });
  await page.route("**/trpc/config.get*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    Object.assign(body.result.data, {
      ui: { ...body.result.data.ui, language: "zh" },
      transcription: { engine: "local" },
      status_agent: { enabled: true },
      agent_pipeline: { enabled: true, auto_process_recordings: true },
      calendars: [{ type: "macos", enabled: true }],
      intelligence: { summary: { provider: "agent", connectionId: "codex", model: "selected" }, conversation: { provider: "xai", model: "grok-4.6" } },
    });
    await route.fulfill({ response, json: body });
  });
  for (const [procedure, data] of [
    ["activation.status", { state: "activated", evidence: {}, journey: { shouldAutoEnter: false } }],
    ["onboarding.status", { entry: { shouldAutoEnter: false }, optionalCapabilities: [] }],
    ["recording.captureStatus", { reachable: true, recording: false, micReady: true, sysReady: true, checkedAt: new Date().toISOString() }],
    ["recording.state", { state: "idle" }],
    ["agentTasks.transcriptionHealth", { available: true, provider: "local", paused: false }],
    ["agentTasks.list", [{ id: "fixture", recordingStem: "Weekly_20260918_100000", title: "产品周会", state: "execution_unverified", phase: "summarizing", agentProvider: "codex", attempt: 1, updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() }]],
    ["agentSessions.list", { sessions: [{ id: "history", title: "本周行动项", agent: "xai", model: "grok-4.6", messageCount: 2, updatedAt: new Date().toISOString() }] }],
    ["agentConsole.meetings", [{ id: "meeting", stem: "Weekly_20260918_100000", title: "产品周会", hasTranscript: true, recordedAt: new Date().toISOString() }]],
    ["agentConsole.connectors", { agent: "codex", all: [{ id: "notion", label: "Notion", status: "configured" }, { id: "zulip", label: "Zulip", status: "unconfigured" }] }],
    ["agentConnections.view", { connections: [{ id: "codex", authorization: { connected: true }, capabilities: [{ capability: "summary", declared: true, currentReadiness: { status: "untested", model: "selected" }, disclosure: { required: false } }] }], selections: { summary: { connectionId: "codex", model: "selected" }, transcription: { connectionId: null, model: "local" } } }],
    ["integrations.calendarSources", { selectedSource: { source: "macos", account: null }, readiness: { status: "ready" } }],
    ["scheduler.overview", { exists: true, updatedAt: new Date().toISOString(), schedulerStatus: { pid: 12 }, calendarStatus: { pid: 13 }, events: [], meetings: [] }],
  ] as const) await page.route(`**/trpc/${procedure}*`, (route) => route.fulfill({ json: { result: { data } } }));
});

test("assistant leaves room for conversation at every window size", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST") posts.push(request.url()); });
  await page.goto("/agent-console");
  for (const width of [1440, 960, 760, 420, 360]) {
    await page.setViewportSize({ width, height: 760 });
    await expect(page.getByPlaceholder("问会议记录、决策、行动项...")).toBeVisible();
    await expect(page.locator(".agent-session-panel")).toHaveCount(0);
    expect(await page.locator(".agent-console-page").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    const composer = await page.locator(".agent-composer").boundingBox();
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(760);
    if (width === 1440 || width === 420) await page.screenshot({ path: `/private/tmp/yulu-assistant-${width}.png` });
  }
  await page.getByRole("button", { name: "对话历史", exact: true }).click();
  await expect(page.getByPlaceholder("搜索对话")).toBeFocused();
  await expect(page.locator(".agent-chat-main")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "对话历史", exact: true })).toBeFocused();
  await expect(page.getByPlaceholder("问会议记录、决策、行动项...")).toBeVisible();
  await page.getByRole("button", { name: "引用会议", exact: true }).click();
  await expect(page.getByPlaceholder("搜索最近会议")).toBeFocused();
  await page.getByRole("button", { name: /产品周会/ }).click();
  await expect(page.getByPlaceholder("问会议记录、决策、行动项...")).toHaveValue(/产品周会/);
  expect(posts).toEqual([]);
});

test("runtime status shows incomplete checks and preserves deep links to guarded task actions", async ({ page }) => {
  await page.goto("/health");
  await expect(page.locator('[data-feature="summary"]')).toHaveAttribute("data-state", "unchecked");
  await expect(page.getByRole("tablist", { name: "高级诊断" })).toHaveCount(0);
  for (const width of [1440, 960, 760, 420, 360]) {
    await page.setViewportSize({ width, height: 820 });
    await expect.poll(() => page.locator(".health-page").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    if (width === 1440 || width === 420) await page.screenshot({ path: `/private/tmp/yulu-runtime-${width}.png` });
  }
  await page.getByRole("link", { name: /1 项需要处理.*处理记录/ }).click();
  await expect(page.getByRole("tab", { name: "处理记录", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("agent-queue-section")).toBeVisible();
  await expect(page.getByRole("button", { name: "重试", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "处理记录", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "提醒计划", exact: true })).toBeFocused();
  await expect(page).toHaveURL(/#scheduler$/);
  await page.getByRole("button", { name: /高级诊断/ }).click();
  await expect(page.getByRole("tablist")).toHaveCount(0);
});

test("status does not keep stale green data when refresh fails", async ({ page }) => {
  await page.goto("/health");
  await expect(page.locator('[data-feature="recording"]')).toHaveAttribute("data-state", "ready");
  await page.route("**/trpc/recording.captureStatus*", (route) => route.fulfill({ status: 500, json: { error: { message: "Unavailable", code: -32603, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 } } } }));
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.locator('[data-feature="recording"]')).toHaveAttribute("data-state", "unchecked");
});
