import { test, expect } from "@playwright/test";

test("cleanup preferences persist and original text remains available", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("yulu_ui.lang", "zh"));
  await page.route("**/trpc/config.get*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.result.data.ui.language = "zh";
    await route.fulfill({ response, json: body });
  });
  for (const [name, data] of [
    ["onboarding.status", { version: "phase-13-v1", entry: { shouldAutoEnter: false, installationKind: "returning" }, coreActivation: { completed: true, href: "/activate", attempt: null }, completion: { completed: true, currentVersionCompleted: true }, optionalCapabilities: [] }],
    ["activation.status", { state: "activated", evidence: {}, journey: {} }],
    ["permissions.status", { macosMajor: 27, voiceInputEnabled: true, microphone: "ready", systemAudio: "ready", input: "ready", notifications: "granted", checkedAt: new Date().toISOString() }],
  ] as const) await page.route(`**/trpc/${name}*`, route => route.fulfill({ json: { result: { data } } }));

  await page.goto("/settings/voice");
  await expect(page.getByText("听写模板", { exact: true })).toHaveCount(0);
  await expect(page.getByText("翻译偏好", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "翻译模板" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "翻译目标语言" })).toBeVisible();
  const preferences = page.getByRole("region", { name: "听写文字整理" });
  await expect(preferences.getByRole("radio", { name: /^中度/ })).toBeChecked();
  await expect(preferences.getByRole("radio", { name: /^日常/ })).toBeChecked();
  await preferences.getByRole("button", { name: "整理模型" }).click();
  await preferences.getByRole("combobox", { name: "整理模型" }).selectOption("grok-4.20-0309-non-reasoning");
  await expect(preferences.getByRole("button", { name: "整理模型" })).toHaveText("快速 · Grok 4.20（推荐）");
  await preferences.getByRole("radio", { name: /^重度/ }).click();
  await expect(preferences.getByRole("radio", { name: /^重度/ })).toBeChecked();
  await preferences.getByRole("switch", { name: "自动整理" }).click();
  await expect(preferences.getByRole("switch", { name: "自动整理" })).not.toBeChecked();
  await expect(preferences.getByRole("radio", { name: /^重度/ })).toBeDisabled();
  await preferences.getByRole("switch", { name: "自动整理" }).click();
  await expect(preferences.getByRole("switch", { name: "自动整理" })).toBeChecked();
  await expect(preferences.getByRole("radio", { name: /^重度/ })).toBeChecked();
  await preferences.getByRole("radio", { name: /^随意/ }).click();
  await expect(preferences.getByRole("radio", { name: /^随意/ })).toBeChecked();
  await page.reload();
  await expect(preferences.getByRole("button", { name: "整理模型" })).toHaveText("快速 · Grok 4.20（推荐）");
  await expect(preferences.getByRole("radio", { name: /^重度/ })).toBeChecked();
  await expect(preferences.getByRole("radio", { name: /^随意/ })).toBeChecked();
  await preferences.getByRole("radio", { name: /^中度/ }).click();
  await expect(preferences.getByRole("radio", { name: /^中度/ })).toBeChecked();
  await preferences.getByRole("radio", { name: /^日常/ }).click();
  await expect(preferences.getByRole("radio", { name: /^日常/ })).toBeChecked();
  for (const width of [1280, 960, 420, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await page.locator(".settings-content").evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    if (width === 1280 || width === 420) await preferences.screenshot({ path: `/private/tmp/yulu-cleanup-settings-${width}.png` });
  }
  await page.route("**/trpc/recording.history*", route => route.fulfill({ json: { result: { data: [{
    id: "synthetic", createdAt: "2026-09-21T09:00:00", action: "dictate", text: "明天下午四点开会，先不要发草稿",
    rawText: "嗯，明天下午三点。不对，四点。我们开会。先不要发草稿。", cleanupStatus: "cleaned", cleanupWarning: "",
  }] } } }));
  await page.goto("/voice-input");
  await page.getByText("查看识别原文").click();
  await expect(page.getByText("嗯，明天下午三点。不对，四点。我们开会。先不要发草稿。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "复制原文" })).toBeVisible();
});
