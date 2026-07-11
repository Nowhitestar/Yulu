// e2e/critical.spec.ts
import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("yulu_ui.lang", "en"));
});

test("shell loads + redirects / to the Agent Console workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/agent-console$/);
  await expect(page.getByRole("tablist", { name: "Agent Console mode" })).toBeVisible();
  await expect(page.getByRole("button", { name: "问会议" })).toBeVisible();
});

test("Sidebar: single Recordings entry, no Voicemails/Meetings, no counts", async ({ page }) => {
  await page.goto("/inbox");
  await expect(page.locator(".sidebar-count")).toHaveCount(0);
  await expect(page.locator(".sidebar a", { hasText: /^Recordings$/ })).toHaveCount(1);
  await expect(page.locator(".sidebar a", { hasText: /^Voicemails$/ })).toHaveCount(0);
  await expect(page.locator(".sidebar a", { hasText: /^Meetings$/ })).toHaveCount(0);
  await expect(page.locator('.sidebar a[href="/settings"]')).toHaveCount(1);
  await expect(page.locator('.sidebar a[href="/health"]')).toHaveCount(1);
  // Bottom region reports the local runtime rather than duplicating nav links.
  const bottom = page.locator('[data-testid="sidebar-bottom"]');
  await expect(bottom).toContainText("Local Engine");
});

test("Recordings — list renders + clicking a row opens reader", async ({ page }) => {
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: "Recordings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "More" })).toBeVisible();
  const rows = page.getByTestId("recording-row");
  const count = await rows.count();
  if (count === 0) {
    test.info().annotations.push({ type: "skip", description: "no recordings on this machine" });
    return;
  }
  await rows.first().click();
  await expect(page).toHaveURL(/\/inbox\/.+/);
  await expect(page.getByRole("button", { name: /play|pause/i })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Transcript" })).toBeVisible();
});

test("Recordings — old /inbox/voicemails + /inbox/meetings redirect to /inbox", async ({ page }) => {
  await page.goto("/inbox/voicemails");
  await expect(page).toHaveURL(/\/inbox$/);
  await page.goto("/inbox/meetings");
  await expect(page).toHaveURL(/\/inbox$/);
});

test("GlobalSearch popover opens via ⌘K, lists results, closes on Esc", async ({ page }) => {
  await page.goto("/inbox");
  const input = page.getByPlaceholder("Search");
  // Make sure the input has mounted before firing the hotkey.
  await expect(input).toBeVisible();
  // Click in the page body so focus is on the document (not the URL bar) before pressing the hotkey.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  const meta = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${meta}+KeyK`);
  await expect(input).toBeFocused();
  await input.fill("the");
  // Popover should appear
  await expect(page.locator(".gs-popover")).toBeVisible({ timeout: 5_000 });
  // Footer shows keyboard hints
  await expect(page.locator(".gs-footer")).toContainText(/navigate/i);
  await expect(page.locator(".gs-footer")).toContainText(/open/i);
  // Esc closes
  await page.keyboard.press("Escape");
  await expect(page.locator(".gs-popover")).toBeHidden();
});

test("Settings — Agent-native categories render current detail sections", async ({ page }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/general$/);
  await expect(page.getByTestId("settings-category")).toHaveCount(5);
  await expect(page.getByRole("heading", { name: "Host capabilities", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hotkey & UI", exact: true })).toBeVisible();
  await page.goto("/settings/audio");
  await expect(page.getByRole("heading", { name: "Audio", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Storage", exact: true })).toBeVisible();
});

test("Settings — retired LLM settings route redirects to Agent Console", async ({ page }) => {
  await page.goto("/settings/llm");
  await expect(page).toHaveURL(/\/agent-console$/);
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
  await expect(page.getByRole("heading", { name: "Proper nouns" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Enter a proper noun, then press Return" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
});

test("Health — defaults to Doctor and exposes the current daemon grid", async ({ page }) => {
  await page.goto("/health");
  await expect(page.locator('[data-testid="health-summary"]')).toBeVisible();
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

test("RecordingReader exposes the two durable Hermes pipeline actions", async ({ page }) => {
  await page.goto("/inbox");
  const rows = page.getByTestId("recording-row");
  const count = await rows.count();
  if (count === 0) {
    test.info().annotations.push({ type: "skip", description: "no recordings" });
    return;
  }
  await rows.first().click();
  await expect(page.getByRole("button", { name: /Let Hermes process/i })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: /Process and send to Notion/i })).toBeVisible();
});
