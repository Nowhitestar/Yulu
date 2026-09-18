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

test("window toolbar and recording reader fit wide and narrow windows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/inbox");
  await expect(page.locator(".recording-row").first()).toBeVisible();
  await page.locator(".recording-row").first().click();
  await expect(page.locator(".reader")).toBeVisible();
  for (const width of [1440, 1100, 960, 768, 540, 420]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.getByRole("button", { name: "Toggle sidebar" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const controls = await page.locator(".topbar-controls").boundingBox();
    expect(controls!.x + controls!.width).toBeLessThanOrEqual(width);
    const detail = await page.locator(".masterdetail-detail").boundingBox();
    expect(detail!.width).toBeGreaterThan(300);
    if (width === 420 || width === 960 || width === 1440) {
      await page.screenshot({ path: `/private/tmp/yulu-window-${width}.png` });
    }
  }
  await expect(page.locator(".masterdetail-list")).toBeHidden();
  await page.locator(".reader-mobile-back").click();
  await expect(page.locator(".recording-row").first()).toBeVisible();
});

test("sidebar and back/forward work from the unified toolbar", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 720 });
  await page.goto("/inbox");
  await expect(page.locator("#app-sidebar")).toBeHidden();
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await expect(page.locator("#app-sidebar")).toBeVisible();
  await page.locator(".sidebar-item[href='/settings']").click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await page.getByRole("button", { name: "Forward", exact: true }).click();
  await expect(page).toHaveURL(/\/settings(?:\/.*)?$/);
});

test("narrow window keeps search accessible from its button and shortcut", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 720 });
  await page.goto("/inbox");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".gs-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".topbar-search")).toBeHidden();
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".gs-input")).toBeFocused();
});

test("initial app route renders the toolbar without a resize or navigation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 960, height: 680 });
  await page.goto("/");
  await expect(page.locator("[data-yulu-ready]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Toggle sidebar" })).toBeVisible();
  await expect(page).toHaveURL(/\/agent-console$/);
  expect(errors).toEqual([]);
});
