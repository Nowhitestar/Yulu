import { test, expect } from "@playwright/test";

// A test may end while a passthrough route is still fetching; that is not a failure.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("yulu_ui.lang", "zh");
    document.addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.yuluNative = "true"; });
  });
  await page.route("**/trpc/config.get*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.result.data.ui = { ...body.result.data.ui, language: "zh" };
    await route.fulfill({ response, json: body });
  });
  for (const [procedure, data] of [
    ["activation.status", { state: "activated", evidence: {}, journey: { shouldAutoEnter: false } }],
    ["onboarding.status", { entry: { shouldAutoEnter: false }, optionalCapabilities: [] }],
    ["integrations.calendarSources", { selectedSource: { source: "macos", account: null }, sources: [], readiness: { status: "untested", source: "macos", reason: null, detail: "Connection not checked", remediation: "", evidence: null } }],
    ["scheduler.overview", { updatedAt: new Date().toISOString(), schedulerStatus: { pid: 123 }, calendarStatus: { pid: 456 }, events: [], meetings: [] }],
  ] as const) {
    await page.route(`**/trpc/${procedure}*`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { data } }) }));
  }
});

test("settings takes over the left pane, with one appearance control and diagnostics folded away", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/settings/general");
  const nav = page.locator(".root-pane .settings-nav");
  await expect(nav.getByTestId("settings-category")).toHaveText(["通用", "录音与摘要", "会议提醒", "语音输入", "连接"]);
  await expect(nav.locator(".settings-nav-item.active")).toHaveText("通用");
  // The recordings list steps aside while you are in Settings.
  await expect(page.locator(".root-pane .recordings-list")).toHaveCount(0);
  await expect(page.locator(".root-body nav")).toHaveCount(0);
  await expect(page.getByRole("group", { name: "主题明暗模式", exact: true })).toHaveCount(1);
  await expect(page.getByRole("group", { name: "主题家族", exact: true }).getByRole("button")).toHaveCount(4);
  await expect(page.locator("#capabilities")).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("settings-general-wide.png") });
  await page.getByText("排查问题", { exact: true }).click();
  await expect(page.locator("#capabilities")).toBeVisible();
});

test("meeting settings fit wide and narrow windows, and narrow settings are a list then a page", async ({ page }) => {
  await page.goto("/settings/meetings");
  for (const width of [1440, 960, 760, 680, 420, 360]) {
    await page.setViewportSize({ width, height: 820 });
    await expect(page.getByRole("heading", { name: "日历提醒" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const content = await page.locator(".root-body").boundingBox();
    expect(content!.width).toBeGreaterThan(300);
    expect(await page.locator(".root-body").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    if (width === 960 || width === 420) await page.screenshot({ path: test.info().outputPath(`settings-meetings-${width}.png`) });
  }
  const nav = page.locator(".root-pane .settings-nav");
  await expect(nav).toBeHidden();
  await page.locator(".topbar-back").click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(nav).toBeVisible();
  await expect(page.locator(".root-main")).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("settings-categories-narrow.png") });
  await nav.getByRole("link", { name: "通用", exact: true }).click();
  await expect(page.getByRole("heading", { name: "偏好设置" })).toBeVisible();
  await expect(nav).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("settings-general-narrow.png") });
});

test("legacy links preserve connection remediation and reveal the right advanced section", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  // The Agent calendar connector is gone; its old link lands on meeting reminders.
  await page.goto("/settings/integrations#agent-calendar-connector");
  await expect(page).toHaveURL(/\/settings\/meetings#agent-calendar-connector$/);
  await expect(page.getByRole("heading", { name: "会议提醒", level: 1 })).toBeVisible();
  await expect(page.locator("#agent-calendar-connector")).toHaveCount(0);
  await page.goto("/settings/sharing");
  await expect(page).toHaveURL(/\/settings\/connections#sharing$/);
  await expect(page.locator("#sharing > details")).toHaveAttribute("open", "");
  await page.goto("/settings/transcription");
  await expect(page).toHaveURL(/\/settings\/recording#transcription$/);
  await expect(page.locator("#transcription")).toBeVisible();
});

test("reminder edits retain save feedback and recording guards", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  let recording = false;
  await page.route("**/trpc/recording.state*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { data: { state: recording ? "recording" : "idle" } } }) }));
  const updates: unknown[] = [];
  await page.route("**/trpc/config.update*", (route) => {
    updates.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { data: { daemonsNeedingRestart: [], daemonsNeedingSighup: [] } } }) });
  });
  await page.goto("/settings/meetings");
  await page.getByRole("switch", { name: "提醒我录音" }).click();
  await expect(page.getByTestId("undo-toast")).toBeVisible();
  expect(updates).toContainEqual(expect.objectContaining({ key: "meeting_detection.enabled" }));
  recording = true;
  await page.reload();
  await expect(page.locator("#automation")).toBeVisible();
  await expect(page.getByRole("switch", { name: "提醒我录音" })).toHaveCount(0);
  await expect(page.locator("#automation .value-disabled-note").first()).toContainText("录音中");
});


test("all settings categories fit a compact window", async ({ page }) => {
  for (const width of [960, 760, 420]) {
    await page.setViewportSize({ width, height: 860 });
    for (const category of ["general", "recording", "meetings", "voice", "connections"]) {
      await page.goto(`/settings/${category}`);
      await expect(page.locator(".settings-detail > h1")).toBeVisible();
      await expect.poll(() => page.locator(".root-body").evaluate((element) => element.scrollWidth - element.clientWidth), { message: `${category} should fit at ${width}px` }).toBeLessThanOrEqual(1);
    }
  }
});

async function mockConnectionSettings(page: import("@playwright/test").Page) {
  const capability = (capability: "summary" | "conversation", model: string, selected: boolean) => ({
    capability, declared: true, selected,
    currentReadiness: { status: "ready", model, testedAt: "2026-09-17T00:00:00.000Z" },
    readinessHistory: [], disclosure: { required: false }, remediation: null,
  });
  await page.route("**/trpc/agentConnections.view*", (route) => route.fulfill({ json: { result: { data: {
    connections: [{
      id: "direct-xai", kind: "direct-provider", adapter: "direct-xai", label: "xAI",
      authorization: { connected: true, credentialSource: "oauth", oauthConnected: true, apiKeyConfigured: false, oauthReadSucceeded: true, apiKeyReadSucceeded: true, status: "idle" },
      settings: { credentialSource: "oauth", summaryModel: "grok-summary", conversationModel: "grok-conversation" },
      capabilities: [capability("summary", "grok-summary", true), capability("conversation", "grok-conversation", false)],
    }, {
      id: "codex", kind: "supported-agent", adapter: "codex", label: "Codex",
      authorization: { connected: true, runtimeVersion: "test", minimumVersion: "test", features: [], loginCommand: "codex login", statusCommand: "codex login status", remediation: null },
      settings: { summaryModel: "selected-model", conversationModel: "selected-model" },
      capabilities: [capability("summary", "selected-model", false), capability("conversation", "selected-model", true)],
    }], candidates: [], legacyConnections: [],
    selections: { transcription: { connectionId: null, model: "local" }, summary: { connectionId: "direct-xai", model: "grok-summary" }, conversation: { connectionId: "codex", model: "selected-model" } },
  } } } }));
  await page.route("**/trpc/prompts.list*", (route) => route.fulfill({ json: { result: { data: [
    { slug: "dictation-cleanup", name: "整理听写文字" }, { slug: "dictation-translate", name: "翻译听写文字" },
  ] } } }));
}

test("account settings start with uses and reveal the chosen capability with the keyboard", async ({ page }) => {
  await mockConnectionSettings(page);
  const mutations: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST") mutations.push(request.url()); });
  await page.setViewportSize({ width: 1120, height: 860 });
  await page.goto("/settings/connections");
  // Yulu transcribes and summarizes; nothing here configures a conversation.
  await expect(page.locator(".agent-usage-row strong")).toHaveText(["转写", "摘要"]);
  await expect(page.locator(".agent-provider-details[open]")).toHaveCount(0);
  await expect(page.locator(".agent-connection-model input").first()).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("settings-connections-wide.png") });
  await page.getByRole("button", { name: "配置摘要", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#agent-connection-direct-xai-summary")).toHaveAttribute("open", "");
  await expect(page.locator('[id$="-conversation"]')).toHaveCount(0);
  await expect(page.locator("#agent-connection-model-summary")).toBeVisible();
  expect(mutations).toEqual([]);
  await page.goto("/settings/llm?connection=codex&capability=summary");
  await expect(page.locator("#agent-connection-codex-summary")).toHaveAttribute("open", "");
  await expect(page.locator("#agent-connection-codex-summary")).toBeFocused();
  // A link to the retired capability still finds the account it was about.
  await page.goto("/settings/llm?connection=codex&capability=conversation");
  await expect(page.locator("#agent-connection-codex")).toBeFocused();
});

test("recording, voice and expanded account controls fit narrow windows", async ({ page }) => {
  test.setTimeout(60_000);
  await mockConnectionSettings(page);
  for (const category of ["recording", "voice", "connections"]) {
    await page.goto(`/settings/${category}`);
    await expect(page.locator(".settings-detail > h1")).toBeVisible();
    if (category === "connections") await expect(page.locator(".agent-usage-row")).toHaveCount(2);
    if (category === "recording") await expect(page.locator("#transcription")).toBeVisible();
    if (category === "voice") await expect(page.locator(".voice-hotkey-display")).toHaveCount(2);
    for (const width of [960, 760, 420, 360]) {
      await page.setViewportSize({ width, height: 860 });
      await expect.poll(() => page.locator(".root-body").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      if (width === 960 || width === 420) await page.screenshot({ path: test.info().outputPath(`settings-${category}-${width}.png`) });
    }
    await page.locator(".settings-detail details").evaluateAll((elements) => elements.forEach((element) => element.setAttribute("open", "")));
    await expect.poll(() => page.locator(".root-body").evaluate((element) => element.scrollWidth - element.clientWidth), { message: `${category} expanded controls should fit at 360px` }).toBeLessThanOrEqual(1);
  }
});

test("voice shortcuts can be cancelled and are saved as one complete value", async ({ page }) => {
  await mockConnectionSettings(page);
  await page.setViewportSize({ width: 1120, height: 860 });
  const updates: unknown[] = [];
  await page.route("**/trpc/config.update*", (route) => {
    updates.push(route.request().postDataJSON());
    return route.fulfill({ json: { result: { data: { daemonsNeedingRestart: [], daemonsNeedingSighup: [] } } } });
  });
  await page.route("**/trpc/recording.shortcutEditing*", (route) => route.fulfill({ json: { result: { data: { ok: true } } } }));
  await page.goto("/settings/voice");
  const change = page.getByRole("button", { name: "听写快捷键 更改", exact: true });
  await change.click();
  // Capture starts once the global shortcuts are paused.
  await expect(change).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(change).toHaveAttribute("aria-pressed", "false");
  await expect(change).toBeFocused();
  expect(updates).toEqual([]);
  await change.click();
  await expect(change).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Control+Alt+F1");
  await expect(page.getByTestId("undo-toast")).toBeVisible();
  // Real key presses say which side they came from.
  expect(updates).toEqual([{ key: "status_agent.hotkeys.dictate", value: { key: "F1", modifiers: ["left_ctrl", "left_alt"] } }]);
});
