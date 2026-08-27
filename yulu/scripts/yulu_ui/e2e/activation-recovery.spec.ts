import { expect, test, type Page, type Route } from "@playwright/test";

const journey = {
  shouldAutoEnter: false,
  automaticEntryAcknowledgedAt: "2026-08-25T04:00:00.000Z",
  deferredAt: null,
};

function readyActivation() {
  return {
    state: "unresolved",
    evidence: null,
    nextStep: null,
    blocker: null,
    readiness: {
      microphonePermission: { state: "ready", detail: null, remediation: null },
      audioInput: { state: "ready", selectedDeviceUid: "BuiltInMic", detail: null, remediation: null },
      transcription: {
        selected: "local",
        state: "ready",
        local: { available: true, ready: true, detail: null },
        xai: {
          ready: false,
          detail: "Connect xAI",
          disclosureVersion: "xai-audio-v1",
          acceptedDisclosureVersion: null,
          disclosureRequired: true,
        },
        remediation: null,
      },
      summary: {
        selected: { provider: "xai", model: "grok-summary-exact" },
        state: "ready",
        detail: "ready",
        credentialSource: "oauth",
        testedAt: "2026-08-25T04:00:00.000Z",
        disclosure: {
          provider: "xai",
          disclosureVersion: "xai-summary-v1",
          acceptedDisclosureVersion: "xai-summary-v1",
          declined: false,
          required: false,
          data: "transcript_text",
          destination: "xAI",
        },
        publicOnboardingSupported: true,
        remediation: null,
      },
      recordingPipeline: {
        state: "ready",
        enabled: true,
        autoProcessRecordings: true,
        detail: null,
        remediation: null,
      },
    },
    journey,
  };
}

function processingActivation() {
  return {
    state: "processing",
    evidence: null,
    journey,
    attempt: {
      id: "attempt-e2e",
      startedAt: "2026-08-25T06:15:00.000Z",
      taskId: "task-e2e",
      recordingStem: "Activation_20260825_141500",
      handoffError: null,
    },
    task: {
      id: "task-e2e",
      state: "running",
      phase: "transcribing",
      error: null,
    },
    blocker: null,
    summaryRecovery: null,
  };
}

function fulfill(route: Route, data: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ result: { data } }),
  });
}

function rejectTrpc(route: Route, path: string, message: string) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      error: {
        message,
        code: -32603,
        data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path },
      },
    }),
  });
}

function readySummaryActivation() {
  return {
    directXaiAvailable: true,
    selected: {
      connectionId: "direct-xai",
      provider: "xai",
      label: "xAI",
      model: "grok-summary-exact",
    },
    state: "ready",
    detail: "ready",
    credentialSource: "oauth",
    testedAt: "2026-08-25T04:00:00.000Z",
    disclosure: null,
    publicOnboardingSupported: true,
    remediation: null,
    blocker: null,
    options: [
      { connectionId: "direct-xai", provider: "xai", label: "xAI", model: "grok-summary-exact", selected: true },
      { connectionId: "codex", provider: "codex", label: "Codex", model: "gpt-5.6-sol", selected: false },
      { connectionId: "claude-code", provider: "claude-code", label: "Claude Code", model: "claude-sonnet-5", selected: false },
      { connectionId: "cliproxyapi", provider: "cliproxyapi", label: "CLIProxyAPI", model: "gateway-summary", selected: false },
    ],
  };
}

async function isolateActivation(page: Page, current: () => unknown) {
  await page.addInitScript(() => localStorage.setItem("yulu_ui.lang", "en"));
  await page.route("**/trpc/config.get*", (route) => fulfill(route, { ui: { language: "en" } }));
  await page.route("**/trpc/recording.state*", (route) => fulfill(route, { state: "idle", hotkey: "⌘⇧V" }));
  await page.route("**/trpc/scheduler.current*", (route) => fulfill(route, { meeting: null }));
  await page.route("**/trpc/activation.status*", (route) => fulfill(route, current()));
  await page.route("**/trpc/agentConnections.summaryActivation*", (route) =>
    fulfill(route, readySummaryActivation()));
  await page.route("**/trpc/activation.acknowledgeAutomaticEntry*", (route) => fulfill(route, {
    acknowledged: true,
    journey,
  }));
}

test("unresolved activation defers, re-enters, skips proven steps, and discloses both xAI data paths", async ({ page }) => {
  let status = readyActivation();
  await isolateActivation(page, () => status);
  await page.route("**/trpc/activation.defer*", (route) => fulfill(route, { journey }));

  await page.goto("/activate");
  await expect(page.getByRole("heading", { name: "Start your Activation Journey" })).toBeVisible();
  await expect(page.getByText("Microphone permission ready")).toBeVisible();
  await expect(page.getByText("Selected Summary Provider ready")).toBeVisible();
  await expect(page.getByText("grok-summary-exact")).toBeVisible();
  await expect(page.getByRole("radio", { name: "xAI" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Codex" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Claude Code" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "CLIProxyAPI" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Hermes|OpenClaw/ })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Local transcription" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start recording" })).toBeVisible();

  await page.getByRole("button", { name: "Do this later" }).click();
  await expect(page).toHaveURL(/\/agent-console$/);
  await page.goto("/activate");
  await expect(page.getByRole("heading", { name: "Start your Activation Journey" })).toBeVisible();

  status = readyActivation();
  status.nextStep = "transcription";
  status.blocker = {
    capability: "xai_transcription",
    detail: "disclosure required",
    remediation: { href: "/settings/transcription" },
  };
  status.readiness.transcription.selected = "xai";
  status.readiness.transcription.state = "disclosure_required";
  status.readiness.summary.state = "disclosure_required";
  status.readiness.summary.disclosure.acceptedDisclosureVersion = null;
  status.readiness.summary.disclosure.required = true;
  await page.reload();

  await expect(page.getByRole("dialog", { name: "xAI cloud transcription disclosure" }))
    .toContainText("recording audio leaves this computer");
  await expect(page.getByRole("dialog", { name: "xAI summary Data Path Disclosure" }))
    .toContainText("Transcript text will be sent to xAI");
});

test("a drifted connection model stays unselected until the exact tested model is explicitly saved", async ({ page }) => {
  let status = readyActivation();
  status.nextStep = "summary_provider";
  status.blocker = {
    capability: "summary_readiness",
    reason: "readiness_required",
    detail: "Claude Code Summary model config-drift has not been tested in this Host process",
    remediation: { href: "/settings/llm?connection=claude-code&capability=summary" },
  };
  status.readiness.summary.selected = { provider: "claude-code", model: "config-drift" };
  status.readiness.summary.state = "blocked";
  let contract = {
    ...readySummaryActivation(),
    state: "blocked",
    selected: {
      connectionId: "claude-code",
      provider: "claude-code",
      label: "Claude Code",
      model: "config-drift",
    },
    blocker: {
      capability: "summary_readiness",
      reason: "readiness_required",
      detail: "Claude Code Summary model config-drift has not been tested in this Host process",
      remediation: { href: "/settings/llm?connection=claude-code&capability=summary" },
    },
    options: [{
      connectionId: "claude-code",
      provider: "claude-code",
      label: "Claude Code",
      model: "claude-sonnet-5",
      selected: false,
    }],
  };
  await isolateActivation(page, () => status);
  await page.unroute("**/trpc/agentConnections.summaryActivation*");
  await page.route("**/trpc/agentConnections.summaryActivation*", (route) => fulfill(route, contract));
  let savedInput: unknown = null;
  await page.route("**/trpc/agentConnections.select*", (route) => {
    savedInput = route.request().postDataJSON();
    status = readyActivation();
    status.readiness.summary.selected = { provider: "claude-code", model: "claude-sonnet-5" };
    contract = {
      ...readySummaryActivation(),
      selected: {
        connectionId: "claude-code",
        provider: "claude-code",
        label: "Claude Code",
        model: "claude-sonnet-5",
      },
      options: [{
        connectionId: "claude-code",
        provider: "claude-code",
        label: "Claude Code",
        model: "claude-sonnet-5",
        selected: true,
      }],
    };
    return fulfill(route, {});
  });

  await page.goto("/activate");
  const claude = page.getByRole("radio", { name: "Claude Code" });
  await expect(claude).not.toBeChecked();
  await claude.click();
  await expect.poll(() => JSON.stringify(savedInput)).toContain(
    '"connectionId":"claude-code","capability":"summary","model":"claude-sonnet-5"',
  );
  await expect(claude).toBeChecked();
  await expect(page.getByRole("button", { name: "Start recording" })).toBeVisible();
});

test("recording UI state survives restart, ignores background completion, and opens its guided note", async ({ page }) => {
  let status: ReturnType<typeof readyActivation> | ReturnType<typeof processingActivation> | Record<string, unknown> =
    readyActivation();
  let starts = 0;
  let stops = 0;
  await isolateActivation(page, () => status);
  await page.route("**/trpc/activation.startAttempt*", (route) => {
    starts += 1;
    status = {
      ...processingActivation(),
      state: "recording",
      task: null,
      attempt: { ...processingActivation().attempt, taskId: null, recordingStem: null },
    };
    return fulfill(route, status);
  });
  await page.route("**/trpc/activation.stopAttempt*", (route) => {
    stops += 1;
    status = processingActivation();
    return fulfill(route, status);
  });

  await page.goto("/activate");
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByText("Recording in progress", { exact: true })).toBeVisible();
  await page.locator(".activate-card").getByRole("button", { name: "Stop recording" }).click();
  await expect(page.getByRole("status")).toContainText("Transcribing your recording");
  expect({ starts, stops }).toEqual({ starts: 1, stops: 1 });

  await page.reload();
  await expect(page.getByRole("status")).toContainText("Transcribing your recording");
  status = {
    ...processingActivation(),
    backgroundEvidence: {
      recordingStem: "Unrelated_20260825_141510",
      taskId: "background-task",
    },
  };
  await page.reload();
  await expect(page.getByText("Core Activation is complete.")).toBeVisible();
  await expect(page).toHaveURL(/\/activate$/);

  status = {
    state: "activated",
    evidence: {
      recordingStem: "Activation_20260825_141500",
      taskId: "task-e2e",
      transcriptionProvider: "local",
      summaryProvider: "xai",
      summaryModel: "grok-summary-exact",
      artifacts: {},
      completedAt: "2026-08-25T06:16:00.000Z",
    },
    guidedCompletionPending: true,
    guidedCompletion: {
      taskId: "task-e2e",
      recordingStem: "Activation_20260825_141500",
    },
    sourceArtifacts: { audio: true, transcript: true, summary: true },
    completedNoteAvailable: true,
    completedNote: "# Activated",
  };
  await page.reload();
  await expect(page).toHaveURL(
    /\/inbox\/Activation_20260825_141500\?activation=complete&activationTaskId=task-e2e$/,
  );
});

test("a qualifying recording uses record_audio, the production task pipeline, artifact commit, and reader", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("yulu_ui.lang", "en"));
  await page.goto("/activate");

  await page.getByRole("button", { name: "Accept and select xAI" }).click();
  await page.getByRole("button", { name: "Retry transcription check" }).click();
  await page.getByRole("button", { name: "Retry Summary Provider check" }).click();
  await page.getByRole("button", { name: "Accept Data Path Disclosure" }).click();
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByText("Recording in progress", { exact: true })).toBeVisible();
  await page.locator(".activate-card").getByRole("button", { name: "Stop recording" }).click();
  await expect(page.getByText(/Transcribing your recording|Creating your saved note/)).toBeVisible();

  await expect(page).toHaveURL(
    /\/inbox\/Core_Activation_20260825_141500\?activation=complete&activationTaskId=/,
    { timeout: 15_000 },
  );
  await expect(page.getByText(/Core Activation complete/)).toBeVisible();
  await expect(page.getByText("Activation fixture summary")).toBeVisible();
});

test("named provider and invalid-audio blockers expose only their exact recoveries", async ({ page }) => {
  let status: Record<string, unknown> = {
    ...processingActivation(),
    task: {
      ...processingActivation().task,
      state: "awaiting_provider",
      phase: "failed",
      error: "Pinned Summary Provider is unavailable",
    },
    blocker: {
      capability: "provider",
      detail: "Pinned Summary Provider is unavailable",
      retry: "same_task",
      remediation: { href: "/settings/llm" },
    },
    summaryRecovery: {
      selected: { provider: "xai", model: "grok-new-explicit" },
      state: "ready",
      detail: "ready",
      remediation: null,
      canReplace: true,
    },
  };
  let retries = 0;
  let replacements = 0;
  await isolateActivation(page, () => status);
  await page.route("**/trpc/activation.retryAttempt*", (route) => {
    retries += 1;
    return fulfill(route, status);
  });
  await page.route("**/trpc/activation.replaceSummaryProvider*", (route) => {
    replacements += 1;
    return fulfill(route, status);
  });

  await page.goto("/activate");
  await expect(page.locator(".activate-card").getByRole("alert"))
    .toContainText("Summary Provider blocked activation");
  await expect(page.getByRole("link", { name: "Open AI Provider Settings" }))
    .toHaveAttribute("href", "/settings/llm");
  await page.getByRole("button", { name: "Retry saved work" }).click();
  await page.getByRole("button", { name: "Use xai · grok-new-explicit" }).click();
  await expect.poll(() => ({ retries, replacements })).toEqual({ retries: 1, replacements: 1 });

  status = {
    ...processingActivation(),
    task: { ...processingActivation().task, state: "failed", phase: "failed", error: "no audio frames" },
    blocker: {
      capability: "audio",
      detail: "The saved recording does not contain valid audio",
      retry: "rerecord",
      remediation: { href: "/settings/general" },
    },
  };
  await page.reload();
  await expect(page.getByRole("button", { name: "Record again" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry saved work" })).toHaveCount(0);
});

test("Summary mutation failures preserve exact identity and localized reasons in English and Chinese", async ({ page }) => {
  const status = readyActivation();
  status.nextStep = "summary_provider";
  status.blocker = {
    capability: "summary_readiness",
    reason: "readiness_failed",
    detail: "Claude Code Summary is not ready",
    remediation: { href: "/settings/llm?connection=claude-code&capability=summary" },
  };
  status.readiness.summary.selected = { provider: "claude-code", model: "claude-sonnet-5" };
  status.readiness.summary.state = "blocked";
  await isolateActivation(page, () => status);
  await page.unroute("**/trpc/agentConnections.summaryActivation*");
  await page.route("**/trpc/agentConnections.summaryActivation*", (route) => fulfill(route, {
    ...readySummaryActivation(),
    selected: {
      connectionId: "claude-code",
      provider: "claude-code",
      label: "Claude Code",
      model: "claude-sonnet-5",
    },
  }));
  await page.route("**/trpc/agentConnections.probe*", (route) => rejectTrpc(
    route,
    "agentConnections.probe",
    "Claude runtime denied the exact model",
  ));

  await page.goto("/activate");
  await expect(page.getByRole("definition").filter({ hasText: "Claude Code" })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "claude-sonnet-5" })).toBeVisible();
  await page.getByRole("button", { name: "Retry Summary Provider check" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The activation action failed" }))
    .toContainText("The activation action failed: Claude runtime denied the exact model");

  await page.unroute("**/trpc/config.get*");
  await page.route("**/trpc/config.get*", (route) => fulfill(route, { ui: { language: "zh" } }));
  await page.evaluate(() => localStorage.setItem("yulu_ui.lang", "zh"));
  await page.reload();
  await expect(page.getByRole("definition").filter({ hasText: "Claude Code" })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "claude-sonnet-5" })).toBeVisible();
  await page.getByRole("button", { name: "重试摘要提供商检查" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "激活操作失败" }))
    .toContainText("激活操作失败：Claude runtime denied the exact model");
});
