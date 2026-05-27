// e2e/critical.spec.ts
import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("shell loads + redirects /  to /inbox/voicemails", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/inbox\/voicemails/);
  // Sidebar present
  await expect(page.getByText("yulu").first()).toBeVisible();
  await expect(page.getByText("Voicemails").first()).toBeVisible();
});

test("Inbox/Voicemails — list renders + clicking a row opens reader", async ({ page }) => {
  await page.goto("/inbox/voicemails");
  // Filter chips present
  await expect(page.getByRole("button", { name: "All", exact: true })).toBeVisible();
  // At least one row OR empty state — both acceptable
  const rows = page.getByTestId("voicemail-row");
  const count = await rows.count();
  if (count === 0) {
    test.info().annotations.push({ type: "skip", description: "no voicemails on this machine" });
    return;
  }
  await rows.first().click();
  // Reader is visible (Audio play button + tab bar)
  await expect(page.getByRole("button", { name: /play|pause/i })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Transcript" })).toBeVisible();
});

test("Inbox/Search — input writes to URL", async ({ page }) => {
  await page.goto("/inbox/search");
  const input = page.getByRole("searchbox");
  await input.fill("OKR");
  await expect(page).toHaveURL(/q=OKR/, { timeout: 2_000 });
});

test("Settings/Audio — editing silence_threshold flashes restart banner", async ({ page }) => {
  await page.goto("/settings/audio");
  await expect(page.getByText("Silence threshold")).toBeVisible();
  // Click the displayed value to enter edit
  const valueDisplay = page.locator(".value-display").filter({ hasText: /^\d+(\.\d+)?$/ }).first();
  await valueDisplay.click();
  const input = page.getByRole("spinbutton").first();
  const currentValue = await input.inputValue();
  await input.fill(String(parseFloat(currentValue || "0.01") + 0.001));
  await input.press("Enter");
  await expect(page.getByText(/restart required/i)).toBeVisible({ timeout: 5_000 });
});

test("Knowledge/Prompts — new prompt mode hides Delete, Save disabled until valid", async ({ page }) => {
  await page.goto("/knowledge/prompts");
  await page.getByRole("link", { name: /\+ new prompt/i }).click();
  await expect(page).toHaveURL(/\/knowledge\/prompts\/new/);
  // Delete button should NOT exist in create mode
  await expect(page.getByRole("button", { name: /^delete$/i })).toHaveCount(0);
  // Save disabled
  await expect(page.getByRole("button", { name: /^save$/i })).toBeDisabled();
  // Fill required + Save enables
  await page.getByLabel(/^name$/i).fill("E2E Test Prompt");
  await page.getByLabel(/^slug$/i).fill("e2e-test-prompt");
  await page.getByLabel(/^content$/i).fill("Body");
  await expect(page.getByRole("button", { name: /^save$/i })).toBeEnabled();
});

test("Knowledge/Glossary — table renders + Add term button is visible", async ({ page }) => {
  await page.goto("/knowledge/glossary");
  await expect(page.getByRole("button", { name: /\+ add term/i })).toBeVisible();
  // Column headers are .etable-cell divs; use first() to disambiguate from button/empty-state text.
  await expect(page.locator(".etable-cell", { hasText: /^Term$/ }).first()).toBeVisible();
  await expect(page.locator(".etable-cell", { hasText: /^Last edited$/ }).first()).toBeVisible();
});

test("Health/Daemons — 8 cards render", async ({ page }) => {
  await page.goto("/health/daemons");
  // We expect 8 daemon names rendered (status-pill spans are also present)
  const knownDaemons = ["audiodaemon", "sttdaemon", "agentqueue", "statusagent", "scheduler", "detector", "calendar", "ui"];
  for (const d of knownDaemons) {
    await expect(page.locator(".daemon-card-name", { hasText: d })).toBeVisible({ timeout: 10_000 });
  }
});

test("Health/Logs — dropdown defaults to audiodaemon", async ({ page }) => {
  await page.goto("/health/logs");
  const select = page.getByRole("combobox");
  await expect(select).toHaveValue("com.yulu.audiodaemon");
  await expect(page.getByRole("button", { name: /pause auto-scroll/i })).toBeVisible();
});
