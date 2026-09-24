import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("yulu_ui.lang", "zh"));
  await page.route("**/trpc/config.get*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.result.data.ui.language = "zh";
    await route.fulfill({ response, json: body });
  });
  const onboarding = { version: "phase-13-v1", entry: { shouldAutoEnter: false, installationKind: "returning" },
    coreActivation: { completed: true, href: "/activate", attempt: null },
    completion: { completed: true, currentVersionCompleted: true }, optionalCapabilities: [] };
  for (const [name, data] of [
    ["onboarding.status", onboarding], ["activation.status", { state: "activated", evidence: {}, journey: {} }],
    ["recording.shortcutEditing", { ok: true }],
  ] as const) await page.route(`**/trpc/${name}*`, (route) => route.fulfill({ json: { result: { data } } }));
});

test("permissions and Fn settings fit both window sizes and refresh on return", async ({ page }) => {
  let granted = false;
  const settingsRequests: unknown[] = [];
  await page.route("**/trpc/permissions.status*", (route) => route.fulfill({ json: { result: { data: {
    macosMajor: 27, voiceInputEnabled: true, microphone: "ready", systemAudio: "ready",
    input: granted ? "ready" : "needs_attention", notifications: "not_determined", checkedAt: new Date().toISOString(),
  } } } }));
  await page.route("**/trpc/permissions.openSettings*", (route) => {
    settingsRequests.push(route.request().postDataJSON());
    return route.fulfill({ json: { result: { data: { opened: true } } } });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "权限准备" })).toBeVisible();
  const input = page.locator('[data-permission="input"]');
  await expect(input).toContainText("设备控制和数据访问");
  await input.getByRole("button", { name: "前往设置" }).click();
  await expect.poll(() => settingsRequests).toEqual([{ permission: "input" }]);
  await expect(input).toContainText("待开启或检查");
  granted = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(input).toContainText("已就绪");
  await page.screenshot({ path: "/private/tmp/yulu-patch-permissions-wide.png" });

  await page.goto("/settings/voice");
  await expect(page.getByRole("button", { name: "恢复默认快捷键" })).toBeVisible();
  await expect(page.locator(".voice-hotkey-display kbd")).toHaveText(["Fn", "Fn + ⇧", "Fn + Space"]);
  await page.getByRole("button", { name: "听写快捷键 更改" }).click();
  await expect(page.getByRole("group", { name: "编辑快捷键" })).toBeVisible();
  await page.getByLabel("主按键", { exact: true }).selectOption("RightCommand");
  await expect(page.locator(".hotkey-editor-actions kbd")).toHaveText("右 ⌘");
  for (const width of [1280, 960, 420, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await page.locator(".settings-content").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    if (width === 1280 || width === 420) {
      await page.locator(".hotkey-settings").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/private/tmp/yulu-patch-shortcuts-${width}.png` });
    }
  }
});
