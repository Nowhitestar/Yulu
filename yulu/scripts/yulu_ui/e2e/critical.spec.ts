// e2e/critical.spec.ts
import { test, expect, type Route } from "@playwright/test";

function fulfill(route: Route, data: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ result: { data } }),
  });
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("yulu_ui.lang", "en"));
  await page.route("**/trpc/activation.status*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      result: {
        data: {
          state: "activated",
          evidence: {
            recordingStem: "e2e-fixture",
            taskId: "e2e-task",
            transcriptionProvider: "e2e",
            summaryProvider: "e2e",
            summaryModel: "e2e",
            artifacts: {
              audio: { sha256: "a".repeat(64), bytes: 1 },
              transcript: { sha256: "b".repeat(64), bytes: 1 },
              summary: { sha256: "c".repeat(64), bytes: 1 },
            },
            completedAt: "2026-08-25T00:00:00.000Z",
          },
          sourceArtifacts: { audio: false, transcript: false, summary: false },
          completedNoteAvailable: false,
          completedNote: null,
        },
      },
    }),
  }));
  await page.route("**/trpc/activation.acknowledgeAutomaticEntry*", (route) => route.abort("blockedbyclient"));
  await page.route("**/trpc/activation.defer*", (route) => route.abort("blockedbyclient"));
  await page.route("**/trpc/onboarding.status*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.result.data.entry.shouldAutoEnter = false;
    await route.fulfill({ response, json: body });
  });
});

// A test may end while a passthrough route is still fetching; that is not a failure.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("shell sends a first run through /onboarding once", async ({ page }) => {
  let acknowledgementRequests = 0;
  await page.unroute("**/trpc/onboarding.status*");
  await page.route("**/trpc/onboarding.status*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.result.data.entry.shouldAutoEnter = true;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/trpc/onboarding.acknowledgeAutomaticEntry*", (route) => {
    acknowledgementRequests += 1;
    return fulfill(route, { acknowledged: true });
  });
  await page.goto("/");
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("heading", { name: "Onboarding Home" })).toBeVisible();
  expect(acknowledgementRequests).toBe(1);
});

test("/activate resumes durable Host progress and permits nonblocking navigation", async ({ page }) => {
  await page.unroute("**/trpc/activation.status*");
  await page.route("**/trpc/activation.status*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      result: {
        data: {
          state: "processing",
          evidence: null,
          journey: {
            automaticEntryAcknowledgedAt: "2026-08-25T00:00:00.000Z",
            deferredAt: null,
            shouldAutoEnter: false,
          },
          attempt: {
            id: "e2e-attempt",
            startedAt: "2026-08-25T00:00:00.000Z",
            taskId: "e2e-task",
            recordingStem: "Activation_20260825_080000",
          },
          task: {
            id: "e2e-task",
            state: "running",
            phase: "transcribing",
            error: null,
          },
        },
      },
    }),
  }));

  await page.goto("/activate");
  await expect(page.getByRole("heading", { name: /Complete Core Activation|完成核心激活/ })).toBeVisible();
  await expect(page.getByText(/10–20 (seconds|秒)/)).toBeVisible();
  await expect(page.locator(".activate-status")).toContainText(/Transcribing your recording|正在转写录音/);
  await page.getByRole("link", { name: /Continue using Yulu|继续使用 Yulu/ }).click();
  await expect(page).toHaveURL(/\/inbox(\/.+)?$/);
});

test("Shell — recordings on the left, everything else behind the gear", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/inbox(\/.+)?$/);
  // The window has no navigation of its own: a search field and the recordings.
  await expect(page.locator(".root-pane .pane-search")).toBeVisible();
  await expect(page.locator(".root-pane nav")).toHaveCount(0);
  await expect(page.locator(".topbar").getByRole("link")).toHaveCount(1);
  await expect(page.getByRole("link", { name: /assistant/i })).toHaveCount(0);

  await page.locator(".topbar").getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await expect(page.locator(".root-pane .settings-nav a")).toHaveText([
    "Back to recordings",
    "General", "Recording & summaries", "Meeting reminders", "Voice Input", "Connections",
    "Templates", "Glossary",
    "Runtime status",
  ]);
  // Inside Settings the gear has done its job.
  await expect(page.locator(".topbar").getByRole("link", { name: "Settings" })).toHaveCount(0);
  await page.getByRole("link", { name: "Back to recordings" }).click();
  await expect(page).toHaveURL(/\/inbox(\/.+)?$/);
});

test("Shell — the recordings pane tucks away and stays that way", async ({ page }) => {
  await page.goto("/inbox");
  const shell = page.locator(".root-shell");
  const pane = page.locator(".root-pane");
  await expect(shell).toHaveAttribute("data-pane", "open");
  await expect(pane).toBeVisible();

  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(shell).toHaveAttribute("data-pane", "closed");
  await expect(pane).toBeHidden();
  await expect(page.getByRole("button", { name: "Show sidebar" })).toHaveAttribute("aria-expanded", "false");
  const main = await page.locator(".root-main").boundingBox();
  expect(main!.x).toBeLessThanOrEqual(1);

  await page.reload();
  await expect(shell).toHaveAttribute("data-pane", "closed");
  // Settings is navigated from the pane, so it comes back there.
  await page.goto("/settings/general");
  await expect(pane).toBeVisible();
  await expect(page.getByRole("button", { name: /sidebar/i })).toHaveCount(0);

  await page.goto("/inbox");
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(shell).toHaveAttribute("data-pane", "open");
  await expect(pane).toBeVisible();
});

test("Recordings — list renders + clicking a row opens reader", async ({ page }) => {
  await page.goto("/inbox");
  const rows = page.getByTestId("recording-row");
  const count = await rows.count();
  if (count === 0) {
    await expect(page.locator(".root-pane")).toContainText("No recordings yet.");
    test.info().annotations.push({ type: "skip", description: "no recordings on this machine" });
    return;
  }
  await rows.first().click();
  await expect(page).toHaveURL(/\/inbox\/.+/);
  await expect(page.getByRole("button", { name: /play|pause/i })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("tab", { name: "Transcript" })).toBeVisible();
});

test("Recordings — old /inbox/voicemails + /inbox/meetings redirect to /inbox", async ({ page }) => {
  await page.goto("/inbox/voicemails");
  await expect(page).toHaveURL(/\/inbox$/);
  await page.goto("/inbox/meetings");
  await expect(page).toHaveURL(/\/inbox$/);
});

test("Command palette opens via ⌘K, jumps to any page, closes on Esc", async ({ page }) => {
  await page.goto("/inbox");
  await expect(page.locator(".pane-search")).toBeVisible();
  // Click in the page body so focus is on the document (not the URL bar) before pressing the hotkey.
  await page.locator(".root-main").click({ position: { x: 300, y: 300 } });
  const meta = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${meta}+KeyK`);
  const palette = page.getByRole("dialog", { name: "Search" });
  const input = palette.getByRole("combobox", { name: "Search" });
  await expect(input).toBeFocused();
  // With nothing typed it is a list of every place in the app.
  await expect(palette.getByRole("option")).toHaveText([
    "Recordings", "General", "Recording & summaries", "Meeting reminders", "Voice Input", "Connections",
    "Templates", "Glossary", "Runtime status",
  ]);

  await input.fill("gloss");
  await expect(palette.getByRole("option")).toHaveText(["Glossary"]);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/knowledge\/glossary$/);
  await expect(palette).toBeHidden();

  // The field at the top of the pane opens the same palette; Esc closes it.
  await page.locator(".pane-search").click();
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
});

test("Settings — Agent-native categories render current detail sections", async ({ page }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/general$/);
  await expect(page.getByTestId("settings-category")).toHaveCount(5);
  await expect(page.getByRole("heading", { name: "Host capabilities", exact: true })).toBeHidden();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await page.goto("/settings/audio");
  await expect(page).toHaveURL(/\/settings\/recording#audio$/);
  await expect(page.getByRole("heading", { name: "Recording", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Storage", exact: true })).toBeVisible();
});

test("Settings — Agent Connection Center is authoritative and honors exact remediation links", async ({ page }) => {
  let probes = 0;
  page.on("request", (request) => {
    if (request.url().includes("/trpc/agentConnections.probe")) probes += 1;
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function scrollIntoView(options?: boolean | ScrollIntoViewOptions) {
      (window as typeof window & { __yuluScrollBehavior?: ScrollBehavior }).__yuluScrollBehavior =
        typeof options === "object" ? options.behavior : undefined;
      original?.call(this, options);
    };
  });

  await page.goto("/settings/llm?connection=direct-xai&capability=summary");
  await expect(page).toHaveURL(/\/settings\/connections\?connection=direct-xai&capability=summary#ai-connections$/);
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  const target = page.locator("#agent-connection-direct-xai-summary");
  await expect(target).toBeFocused();
  await expect(target).toHaveAttribute("aria-current", "location");
  await expect(target.getByRole("status")).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __yuluScrollBehavior?: ScrollBehavior }).__yuluScrollBehavior,
  )).toBe("auto");
  expect(probes).toBe(0);

  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();

  await page.route("**/trpc/config.get*", (route) => fulfill(route, { ui: { language: "zh" } }));
  await page.addInitScript(() => localStorage.setItem("yulu_ui.lang", "zh"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "连接", exact: true })).toBeVisible();
  expect(probes).toBe(0);
});

test("Settings — capabilities remain readable at the native default window size", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 680 });
  await page.goto("/settings/llm?connection=direct-xai&capability=transcription");
  const target = page.locator("#agent-connection-direct-xai-transcription");
  await expect(target).toBeFocused();

  for (const width of [960, 1280, 1440, 760, 390]) {
    await page.setViewportSize({ width, height: 680 });
    for (const capability of ["transcription", "summary"]) {
      const card = page.locator(`#agent-connection-direct-xai-${capability}`);
      const bounds = await card.boundingBox();
      expect(bounds, `${capability} must be rendered at ${width}px`).not.toBeNull();
      expect.soft(bounds!.width, `${capability} must fit readable controls at ${width}px`).toBeGreaterThanOrEqual(180);
    }
    const detail = page.locator(".root-body");
    const overflow = await detail.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect.soft(overflow, `connection controls must not need horizontal scrolling at ${width}px`).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath(`settings-${width}.png`) });
  }

  await expect(page.locator("#agent-connection-direct-xai-conversation")).toHaveCount(0);

  // Wide: the settings list sits beside the page. Narrow: one at a time, with a way back.
  const navigation = page.locator(".root-pane .settings-nav");
  for (const width of [1440, 960]) {
    await page.setViewportSize({ width, height: 680 });
    await expect(navigation).toBeVisible();
    await expect(navigation.getByTestId("settings-category")).toHaveCount(5);
    await navigation.locator('a[href="/settings/recording"]').click();
    await expect(page.getByRole("heading", { name: "Recording & summaries", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recording", exact: true })).toBeVisible();
    await navigation.locator('a[href="/settings/connections"]').click();
    await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 680 });
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
  await expect(navigation).toBeHidden();
  await page.locator(".topbar-back").click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(navigation).toBeVisible();
  await navigation.locator('a[href="/settings/recording"]').click();
  await expect(page.getByRole("heading", { name: "Recording & summaries", exact: true })).toBeVisible();
  await expect(navigation).toBeHidden();
});

test("Retired assistant links land on recordings", async ({ page }) => {
  for (const path of ["/agent-console", "/agent-console?session=old", "/voice-chat"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/inbox(\/.+)?$/);
  }
  await page.goto("/voice-input");
  await expect(page).toHaveURL(/\/settings\/voice$/);
  await expect(page.getByRole("heading", { name: "Voice Input", level: 1 })).toBeVisible();
});

test("Knowledge/Prompts — new prompt mode hides Delete, Save disabled until valid", async ({ page }) => {
  await page.goto("/knowledge/prompts");
  await page.getByRole("link", { name: /\+ new template/i }).click();
  await expect(page).toHaveURL(/\/knowledge\/prompts\/new/);
  await expect(page.getByRole("button", { name: /^delete$/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^save$/i })).toBeDisabled();
  await page.getByLabel(/^name$/i).fill("E2E Test Prompt");
  await page.getByLabel(/^slug$/i).fill("e2e-test-prompt");
  await page.getByLabel(/^content$/i).fill("Body");
  await expect(page.getByRole("button", { name: /^save$/i })).toBeEnabled();
});

test("Knowledge/Glossary — proper-noun editor renders", async ({ page }) => {
  await page.goto("/knowledge/glossary");
  await expect(page.getByRole("heading", { name: "Glossary" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Enter a proper noun, then press Return" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
});

test("Health — folds diagnostics by default and exposes the current daemon grid", async ({ page }) => {
  await page.goto("/health");
  await expect(page.locator('[data-testid="health-summary"]')).toBeVisible();
  await expect(page.locator('[data-testid="tab-doctor"]')).toHaveCount(0);
  await page.getByRole("button", { name: /Advanced diagnostics/ }).click();
  await expect(page.locator('[data-testid="tab-doctor"][aria-selected="true"]')).toBeVisible();
  await page.locator('[data-testid="tab-daemons"]').click();
  await expect(page).toHaveURL(/\/health#daemons$/);
  const knownDaemons = ["audiodaemon", "statusagent", "scheduler", "detector", "calendar", "ui"];
  for (const d of knownDaemons) {
    await expect(page.locator(".daemon-card-name", { hasText: d })).toBeVisible({ timeout: 10_000 });
  }
});

test("Health — old /health/daemons redirects to /health#daemons", async ({ page }) => {
  await page.goto("/health/daemons");
  await expect(page).toHaveURL(/\/health#daemons$/);
});

test("Health — Logs tab via #logs hash + dropdown defaults to audiodaemon", async ({ page }) => {
  await page.goto("/health#logs");
  await expect(page.locator('[data-testid="tab-logs"][aria-selected="true"]')).toBeVisible();
  const select = page.locator('[data-testid="logs-daemon"]');
  await expect(select).toHaveValue("com.yulu.audiodaemon");
  await expect(page.getByRole("button", { name: /pause auto-scroll/i })).toBeVisible();
});

test("AudioPlayer survives A → B → A switch (Phase I regression)", async ({ page }) => {
  await page.goto("/inbox");
  const rows = page.getByTestId("recording-row");
  const count = await rows.count();
  if (count < 2) {
    test.info().annotations.push({ type: "skip", description: "need at least 2 recordings" });
    return;
  }
  await rows.nth(0).click();
  const playA = page.getByRole("button", { name: /^play$/i });
  await expect(playA).toBeEnabled({ timeout: 10_000 });
  await playA.click();
  await expect(page.getByRole("button", { name: /^pause$/i })).toBeVisible({ timeout: 5_000 });

  await rows.nth(1).click();
  const playB = page.getByRole("button", { name: /^play$/i });
  await expect(playB).toBeEnabled({ timeout: 10_000 });

  await rows.nth(0).click();
  const playA2 = page.getByRole("button", { name: /^play$/i });
  await expect(playA2).toBeEnabled({ timeout: 10_000 });
  await playA2.click();
  await expect(page.getByRole("button", { name: /^pause$/i })).toBeVisible({ timeout: 5_000 });
});

test("RecordingReader exposes independent transcription, summary, and share actions", async ({ page }) => {
  await page.goto("/inbox");
  const rows = page.getByTestId("recording-row");
  const count = await rows.count();
  if (count === 0) {
    test.info().annotations.push({ type: "skip", description: "no recordings" });
    return;
  }
  await rows.first().click();
  // Share is up front; reprocessing waits in the menu.
  await expect(page.getByRole("button", { name: "Share summary" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Re-transcribe" })).toHaveCount(0);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("button", { name: "Re-transcribe" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Re-generate summary" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Let Hermes process/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Process and send to Notion/i })).toHaveCount(0);
});
