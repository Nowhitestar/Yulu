import { test, expect } from "@playwright/test";

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

test("settings has five categories, a separate workspace, and no duplicate appearance controls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/settings/general");
  await expect(page.locator(".settings-category-row")).toHaveCount(5);
  await expect(page.locator("#app-sidebar")).toBeHidden();
  await expect(page.getByRole("group", { name: "主题明暗模式", exact: true })).toHaveCount(1);
  await expect(page.locator("#capabilities")).toBeHidden();
  await expect(page.locator(".theme-preview-window")).toHaveCount(0);
  await page.screenshot({ path: "/private/tmp/yulu-settings-general-wide.png" });
  await page.getByText("排查问题", { exact: true }).click();
  await expect(page.locator("#capabilities")).toBeVisible();
});

test("meeting settings fit wide and narrow windows, and mobile categories are a list", async ({ page }) => {
  await page.goto("/settings/meetings");
  for (const width of [1440, 960, 760, 680, 420, 360]) {
    await page.setViewportSize({ width, height: 820 });
    await expect(page.getByRole("heading", { name: "日历提醒" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const content = await page.locator(".settings-content").boundingBox();
    expect(content!.width).toBeGreaterThan(300);
    expect(await page.locator(".settings-content").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    if (width === 960 || width === 420) await page.screenshot({ path: `/private/tmp/yulu-settings-meetings-${width}.png` });
  }
  await expect(page.locator(".settings-navigation")).toBeHidden();
  await page.getByRole("link", { name: "全部设置", exact: true }).click();
  await expect(page.locator(".settings-navigation")).toBeVisible();
  await expect(page.locator(".settings-content")).toBeHidden();
  await page.screenshot({ path: "/private/tmp/yulu-settings-categories-narrow.png" });
  await page.getByRole("link", { name: "通用 语言、外观与关于 Yulu" }).click();
  await expect(page.getByRole("heading", { name: "偏好设置" })).toBeVisible();
  await page.screenshot({ path: "/private/tmp/yulu-settings-general-narrow.png" });
});

test("legacy links preserve connection remediation and reveal the right advanced section", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/settings/integrations#agent-calendar-connector");
  await expect(page).toHaveURL(/\/settings\/connections#agent-calendar-connector$/);
  await expect(page.locator("#agent-calendar-connector")).toBeVisible();
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
    for (const category of ["general", "recording", "voice", "connections"]) {
      await page.goto(`/settings/${category}`);
      await expect(page.locator(".settings-detail-head")).toBeVisible();
      await expect.poll(() => page.locator(".settings-content").evaluate((element) => element.scrollWidth - element.clientWidth), { message: `${category} should fit at ${width}px` }).toBeLessThanOrEqual(1);
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
  await expect(page.locator(".agent-usage-row")).toHaveCount(3);
  await expect(page.locator(".agent-provider-details[open]")).toHaveCount(0);
  await expect(page.locator(".agent-connection-model input").first()).toBeHidden();
  await page.screenshot({ path: "/private/tmp/yulu-settings-connections-wide.png" });
  await page.getByRole("button", { name: "配置摘要", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#agent-connection-direct-xai-summary")).toHaveAttribute("open", "");
  await expect(page.locator("#agent-connection-direct-xai-conversation")).not.toHaveAttribute("open", "");
  await expect(page.locator("#agent-connection-model-summary")).toBeVisible();
  expect(mutations).toEqual([]);
  await page.goto("/settings/llm?connection=codex&capability=conversation");
  await expect(page.locator("#agent-connection-codex-conversation")).toHaveAttribute("open", "");
  await expect(page.locator("#agent-connection-codex-conversation")).toBeFocused();
});

test("recording, voice and expanded account controls fit narrow windows", async ({ page }) => {
  test.setTimeout(60_000);
  await mockConnectionSettings(page);
  for (const category of ["recording", "voice", "connections"]) {
    await page.goto(`/settings/${category}`);
    await expect(page.locator(".settings-detail-head")).toBeVisible();
    if (category === "connections") await expect(page.locator(".agent-usage-row")).toHaveCount(3);
    if (category === "recording") await expect(page.locator("#transcription")).toBeVisible();
    if (category === "voice") await expect(page.locator(".voice-hotkey-display")).toHaveCount(3);
    for (const width of [960, 760, 420, 360]) {
      await page.setViewportSize({ width, height: 860 });
      await expect.poll(() => page.locator(".settings-content").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      if (width === 960 || width === 420) await page.screenshot({ path: `/private/tmp/yulu-settings-${category}-${width}.png` });
    }
    await page.locator(".settings-detail details").evaluateAll((elements) => elements.forEach((element) => element.setAttribute("open", "")));
    await expect.poll(() => page.locator(".settings-content").evaluate((element) => element.scrollWidth - element.clientWidth), { message: `${category} expanded controls should fit at 360px` }).toBeLessThanOrEqual(1);
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
  await page.goto("/settings/voice");
  await expect(page.locator("#voice-input .adv-disclosure")).not.toHaveAttribute("open", "");
  const change = page.getByRole("button", { name: "听写快捷键 更改", exact: true });
  await change.click();
  await page.keyboard.press("Escape");
  await expect(change).toHaveAttribute("aria-pressed", "false");
  await expect(change).toBeFocused();
  expect(updates).toEqual([]);
  await change.click();
  await page.keyboard.press("Control+Alt+F1");
  await expect(page.getByTestId("undo-toast")).toBeVisible();
  expect(updates).toEqual([{ key: "status_agent.hotkeys.dictate", value: { key: "F1", modifiers: ["ctrl", "alt"] } }]);
});
