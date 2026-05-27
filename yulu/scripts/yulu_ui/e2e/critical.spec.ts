// e2e/critical.spec.ts
import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("shell loads + redirects / to /inbox/voicemails", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/inbox\/voicemails/);
  // Sidebar brand text capitalized
  await expect(page.getByText("Yulu", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Voicemails").first()).toBeVisible();
});

test("Sidebar has no count badges and no Search link", async ({ page }) => {
  await page.goto("/inbox/voicemails");
  await expect(page.locator(".sidebar-count")).toHaveCount(0);
  await expect(page.locator(".sidebar a", { hasText: /^Search$/ })).toHaveCount(0);
  // Bottom region with Settings + Health
  const bottom = page.locator('[data-testid="sidebar-bottom"]');
  await expect(bottom).toContainText("Settings");
  await expect(bottom).toContainText("Health");
});

test("Inbox/Voicemails — list renders + clicking a row opens reader", async ({ page }) => {
  await page.goto("/inbox/voicemails");
  await expect(page.getByRole("button", { name: "All", exact: true })).toBeVisible();
  const rows = page.getByTestId("voicemail-row");
  const count = await rows.count();
  if (count === 0) {
    test.info().annotations.push({ type: "skip", description: "no voicemails on this machine" });
    return;
  }
  await rows.first().click();
  await expect(page.getByRole("button", { name: /play|pause/i })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Transcript" })).toBeVisible();
});

test("GlobalSearch popover opens via ⌘K, lists results, closes on Esc", async ({ page }) => {
  await page.goto("/inbox/voicemails");
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

test("Settings — single page with all 6 sections", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Audio", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Transcription", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "LLM", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hotkey & UI", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Integrations", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Storage", exact: true })).toBeVisible();
});

test("Settings — old /settings/audio redirects to /settings#audio", async ({ page }) => {
  await page.goto("/settings/audio");
  await expect(page).toHaveURL(/\/settings#audio$/);
});

test("Knowledge/Prompts — new prompt mode hides Delete, Save disabled until valid", async ({ page }) => {
  await page.goto("/knowledge/prompts");
  await page.getByRole("link", { name: /\+ new prompt/i }).click();
  await expect(page).toHaveURL(/\/knowledge\/prompts\/new/);
  await expect(page.getByRole("button", { name: /^delete$/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^save$/i })).toBeDisabled();
  await page.getByLabel(/^name$/i).fill("E2E Test Prompt");
  await page.getByLabel(/^slug$/i).fill("e2e-test-prompt");
  await page.getByLabel(/^content$/i).fill("Body");
  await expect(page.getByRole("button", { name: /^save$/i })).toBeEnabled();
});

test("Knowledge/Glossary — table renders + Add term button is visible", async ({ page }) => {
  await page.goto("/knowledge/glossary");
  await expect(page.getByRole("button", { name: /\+ add term/i })).toBeVisible();
  await expect(page.locator(".etable-cell", { hasText: /^Term$/ }).first()).toBeVisible();
  await expect(page.locator(".etable-cell", { hasText: /^Last edited$/ }).first()).toBeVisible();
});

test("Health — single page shows summary + Daemons grid by default", async ({ page }) => {
  await page.goto("/health");
  await expect(page.locator('[data-testid="health-summary"]')).toBeVisible();
  await expect(page.locator('[data-testid="tab-daemons"][aria-selected="true"]')).toBeVisible();
  const knownDaemons = ["audiodaemon", "sttdaemon", "agentqueue", "statusagent", "scheduler", "detector", "calendar", "ui"];
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
