import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("yulu_ui.lang", "en");
    document.addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.yuluNative = "true"; });
  });
  await page.route("**/trpc/activation.status*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ result: { data: { state: "activated", evidence: {}, journey: { shouldAutoEnter: false } } } }),
  }));
  await page.route("**/trpc/onboarding.status*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ result: { data: { entry: { shouldAutoEnter: false } } } }),
  }));
  const recording = {
    stem: "Design_Review_20260917_140000", title: "Design review · 设计讨论", tags: ["Design"],
    recordedAt: "2026-09-17T14:00:00", durationSeconds: 120, mtimeMs: Date.parse("2026-09-17T14:00:00+08:00"),
    hasTranscript: true, hasSummary: true, firstWords: "Discussed the new workspace.", status: "idle",
    transcript: "Discussed the new workspace.",
    summary: "# Design review\n\nA quieter toolbar keeps the meeting notes in focus.\n\n## Next steps\n\n- Verify reminders\n- Test narrow windows\n- Keep recording controls within reach",
  };
  for (const [procedure, data] of [["list", [recording]], ["get", recording]] as const) {
    await page.route(`**/trpc/recordings.${procedure}*`, (route) => route.fulfill({
      contentType: "application/json", body: JSON.stringify({ result: { data } }),
    }));
  }
});

test("the list and the reader share a wide window and take turns in a narrow one", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/inbox");
  // A wide window opens the newest recording straight away.
  await expect(page).toHaveURL(/\/inbox\/Design_Review_20260917_140000$/);
  await expect(page.locator(".reader")).toBeVisible();
  const row = page.locator(".recording-row").first();
  await expect(row).toContainText("Design review · 设计讨论");
  // One quiet line under the title: when, and how long.
  await expect(row.locator(".recording-row-meta")).toHaveText(/ · 2 min$/);

  for (const width of [1440, 1100, 960, 768, 540, 420]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const controls = await page.locator(".topbar-controls").boundingBox();
    expect(controls!.x + controls!.width).toBeLessThanOrEqual(width);
    const main = await page.locator(".root-main").boundingBox();
    expect(main!.width).toBeGreaterThan(300);
    if (width >= 760) {
      await expect(page.locator(".root-pane")).toBeVisible();
      await expect(page.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
    } else {
      await expect(page.locator(".root-pane")).toBeHidden();
      await expect(page.getByRole("button", { name: /sidebar/ })).toBeHidden();
    }
    if (width === 420 || width === 960 || width === 1440) {
      await page.screenshot({ path: test.info().outputPath(`window-${width}.png`) });
    }
  }
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.locator(".recording-row").first()).toBeVisible();
  await expect(page.locator(".root-main")).toBeHidden();
});

test("the toolbar holds only the pane toggle, settings and recording", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 720 });
  await page.goto("/inbox");
  await expect(page.locator(".reader")).toBeVisible();
  const toolbar = page.locator(".topbar");
  // Besides the record control there are exactly two things to press.
  expect(await toolbar.locator("a:visible, button:visible").evaluateAll((controls) =>
    controls.filter((control) => !control.closest(".topbar-record")).map((control) => control.getAttribute("aria-label")),
  )).toEqual(["Hide sidebar", "Settings"]);
  await expect(toolbar.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
  await expect(toolbar.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(toolbar.locator(".topbar-record")).toBeVisible();

  await toolbar.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(page.locator("#app-pane")).toBeHidden();
  await expect(page.locator(".reader")).toBeVisible();
  // Browser history still works without toolbar buttons for it.
  await toolbar.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await expect(page.locator("#app-pane")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/inbox\/Design_Review_20260917_140000$/);
  await expect(page.locator("#app-pane")).toBeHidden();
  await page.goForward();
  await expect(page).toHaveURL(/\/settings\/general$/);
});

test("narrow window keeps search accessible from its field and shortcut", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 720 });
  await page.goto("/inbox");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".gs-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".gs-palette")).toBeHidden();
  await page.locator(".recording-row").first().click();
  await expect(page.locator(".reader")).toBeVisible();
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".gs-input")).toBeFocused();
});

test("initial app route renders the shell without a resize or navigation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 960, height: 680 });
  await page.goto("/");
  await expect(page.locator("[data-yulu-ready]")).toBeVisible();
  await expect(page).toHaveURL(/\/inbox\/Design_Review_20260917_140000$/);
  await expect(page.locator(".recording-row.active")).toHaveCount(1);
  await expect(page.locator(".reader")).toBeVisible();
  // The native window draws its controls over the top-left corner; the toolbar clears them.
  const toggle = await page.getByRole("button", { name: "Hide sidebar" }).boundingBox();
  expect(toggle!.x).toBeGreaterThanOrEqual(80);
  expect(errors).toEqual([]);
});
