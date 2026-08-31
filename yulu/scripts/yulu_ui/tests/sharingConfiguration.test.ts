import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../src/hostStore.js";
import {
  SharingConfiguration,
  SharingConnectorUnknownOutcomeError,
  YULU_TEST_SHARE_CONTENT,
  type SharingConnectorAdapter,
} from "../src/sharingConfiguration.js";

describe("SharingConfiguration", () => {
  let root = "";
  let host: HostStore | undefined;
  let actionNumber = 0;

  afterEach(() => {
    vi.useRealTimers();
    host?.close();
    host = undefined;
    actionNumber = 0;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "yulu-sharing-"));
    host = new HostStore(join(root, "host.sqlite"));
    host.upsertAgentConnectionRecord({
      id: "codex",
      kind: "supported-agent",
      adapter: "codex",
      label: "Codex",
      lifecycle: "available",
      settings: { executablePath: "/fake/codex" },
    });
    const adapter: SharingConnectorAdapter = {
      discover: vi.fn(),
      probe: vi.fn(),
      testShare: vi.fn(),
      share: vi.fn(),
      verifyReceipt: vi.fn(),
    };
    return { host, adapter, sharing: new SharingConfiguration({ host, adapter }) };
  }

  function testAction(duplicateConfirmed: boolean) {
    actionNumber += 1;
    return {
      actionId: `00000000-0000-4000-8000-${String(actionNumber).padStart(12, "0")}`,
      duplicateConfirmed,
    };
  }

  it("selects one Supported Agent Connection for Sharing without implying connector or destination readiness", () => {
    const { sharing } = setup();

    expect(sharing.view()).toMatchObject({
      selection: null,
      connectorDiscovery: { status: "untested" },
      connectorReadiness: { status: "untested" },
      destination: { configured: false, value: "" },
      sharingReadiness: { status: "untested" },
    });

    expect(sharing.select({ connectionId: "codex", connector: "notion" }))
      .toMatchObject({
        selection: { connectionId: "codex", connector: "notion" },
        connectorDiscovery: { status: "untested" },
        connectorReadiness: { status: "untested" },
        destination: { configured: false, value: "" },
        sharingReadiness: { status: "untested" },
      });
  });

  it("does not offer or select Agents without a Sharing pre-tool boundary", () => {
    const { host: currentHost, sharing } = setup();
    currentHost.upsertAgentConnectionRecord({
      id: "openclaw",
      kind: "supported-agent",
      adapter: "openclaw",
      label: "OpenClaw",
      lifecycle: "available",
      settings: { executablePath: "/fake/openclaw" },
    });
    currentHost.upsertAgentConnectionRecord({
      id: "hermes",
      kind: "supported-agent",
      adapter: "hermes",
      label: "Hermes",
      lifecycle: "available",
      settings: { executablePath: "/fake/hermes" },
    });

    expect(sharing.view().connections.map((connection) => connection.id)).toEqual(["codex"]);
    expect(() => sharing.select({ connectionId: "openclaw", connector: "notion" }))
      .toThrow(/Conversation-only/);
    expect(() => sharing.select({ connectionId: "hermes", connector: "notion" }))
      .toThrow(/Conversation-only/);
  });

  it("keeps destination discovery distinct from a bounded Connector Readiness probe", async () => {
    const { adapter, sharing } = setup();
    vi.mocked(adapter.discover).mockResolvedValue({
      options: [{ label: "Product Notes", value: "Product Notes" }],
      detail: "Found 1 Notion destination",
    });
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    sharing.select({ connectionId: "codex", connector: "notion" });

    expect(await sharing.discover()).toMatchObject({
      connectorDiscovery: {
        status: "ready",
        options: [{ label: "Product Notes", value: "Product Notes" }],
      },
      connectorReadiness: { status: "untested" },
      destination: { configured: false, value: "" },
    });

    expect(await sharing.probe()).toMatchObject({
      connectorDiscovery: { status: "ready" },
      connectorReadiness: { status: "ready", detail: "Notion read access verified" },
      destination: { configured: false, value: "" },
    });
  });

  it("gives exact remediation when the selected Agent cannot prove its pre-tool guard", async () => {
    const { adapter, sharing } = setup();
    vi.mocked(adapter.probe).mockRejectedValue(
      new Error("Sharing guard did not execute; connector operation was not authorized"),
    );
    sharing.select({ connectionId: "codex", connector: "notion" });

    await expect(sharing.probe()).resolves.toMatchObject({
      connectorReadiness: {
        status: "failed",
        remediation: 'Run "/fake/codex features list" and update Codex until it reports "hooks stable true", then return to Settings > Sharing and test connector access again.',
      },
    });
  });

  it("keeps a proven pre-write Test Share rejection retryable with exact hook remediation", async () => {
    const { adapter, sharing } = setup();
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    vi.mocked(adapter.testShare).mockRejectedValue(
      new Error('Codex hooks are unavailable; update Codex until "codex features list" reports "hooks stable true"'),
    );
    sharing.select({ connectionId: "codex", connector: "notion" });
    await sharing.probe();
    sharing.saveDestination({ destination: JSON.stringify({ page_id: "parent-123" }) });

    await expect(sharing.testShare(testAction(false))).resolves.toMatchObject({
      sharingReadiness: {
        status: "failed",
        remediation: 'Run "/fake/codex features list" and update Codex until it reports "hooks stable true", then return to Settings > Sharing and start a new Test Share.',
      },
    });
    await sharing.testShare(testAction(false));
    expect(adapter.testShare).toHaveBeenCalledTimes(2);
  });

  it("never reports a suggested target as configured until it is explicitly saved and read back", async () => {
    const { adapter, host: currentHost, sharing } = setup();
    vi.mocked(adapter.discover).mockResolvedValue({
      options: [{ label: "Product Notes", value: "Product Notes" }],
      detail: "Found Product Notes",
    });
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    sharing.select({ connectionId: "codex", connector: "notion" });

    const discovered = await sharing.discover();
    expect(discovered.connectorDiscovery.options[0]).toMatchObject({ value: "Product Notes" });
    expect(discovered.destination).toEqual({ configured: false, value: "", savedAt: null });
    expect(() => sharing.saveDestination({ destination: "Product Notes" }))
      .toThrow(/Test connector access/);

    await sharing.probe();
    expect(sharing.saveDestination({ destination: "Product Notes" })).toMatchObject({
      destination: {
        configured: true,
        value: "Product Notes",
        savedAt: expect.any(String),
      },
      sharingReadiness: { status: "untested" },
    });
    expect(currentHost.getSharingConfiguration()?.destination).toBe("Product Notes");
  });

  it("establishes Sharing Readiness only from a verified meeting-free Test Share receipt", async () => {
    const { adapter, sharing } = setup();
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    vi.mocked(adapter.testShare).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    vi.mocked(adapter.verifyReceipt).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    sharing.select({ connectionId: "codex", connector: "notion" });
    await sharing.probe();
    sharing.saveDestination({ destination: "Product Notes" });

    expect(sharing.view().sharingReadiness.status).toBe("untested");
    expect(await sharing.testShare(testAction(false))).toMatchObject({
      sharingReadiness: {
        status: "ready",
        receipt: {
          id: "page-123",
          url: "https://notion.so/page-123",
          verifiedAt: expect.any(String),
        },
      },
    });
    expect(adapter.testShare).toHaveBeenCalledWith(expect.objectContaining({
      connector: "notion",
      destination: "Product Notes",
      content: YULU_TEST_SHARE_CONTENT,
    }));
    expect(adapter.verifyReceipt).toHaveBeenCalledWith(expect.objectContaining({
      connector: "notion",
      destination: "Product Notes",
      content: YULU_TEST_SHARE_CONTENT,
      receipt: expect.objectContaining({ receiptId: "page-123" }),
    }));
    expect(YULU_TEST_SHARE_CONTENT).toBe(
      "Yulu Test Share — connection verification only. This message contains no meeting content.",
    );
  });

  it("exposes exact meeting-free Test Share evidence only after the current receipt is verified", async () => {
    const { adapter, sharing } = setup();
    vi.mocked(adapter.discover).mockResolvedValue({
      options: [{ label: "Product Notes", value: "Product Notes" }],
      detail: "Found Product Notes",
    });
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    vi.mocked(adapter.testShare).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-adoption-1",
      receiptUrl: "https://notion.so/page-adoption-1",
    });
    vi.mocked(adapter.verifyReceipt).mockImplementation(async (input) => input.receipt);

    sharing.select({ connectionId: "codex", connector: "notion" });
    await sharing.discover();
    expect(() => sharing.adoptionEvidence()).toThrow(/verified Test Share/i);
    await sharing.probe();
    sharing.saveDestination({ destination: "Product Notes" });
    expect(() => sharing.adoptionEvidence()).toThrow(/verified Test Share/i);

    const action = testAction(false);
    await sharing.testShare(action);
    expect(sharing.adoptionEvidence()).toEqual({
      kind: "sharing-test-share",
      reference: `sharing-test-share:${action.actionId}`,
      snapshot: {
        capability: "sharing",
        connectionId: "codex",
        adapter: "codex",
        connectionRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
        connector: "notion",
        destination: "Product Notes",
        destinationSavedAt: expect.any(String),
        actionId: action.actionId,
        contentSha256: "6efa1b2d90a7d7946bd0942ebdb55bef26b6ee71b37489b77a9592b723f9ebde",
        receiptId: "page-adoption-1",
        receiptUrl: "https://notion.so/page-adoption-1",
        verifiedAt: expect.any(String),
      },
    });
    expect(JSON.stringify(sharing.adoptionEvidence())).not.toMatch(/recording|transcript|summary/i);
  });

  it("fences an unverifiable receipt as Unknown Outcome until the user abandons it", async () => {
    const { adapter, sharing } = setup();
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    vi.mocked(adapter.testShare).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-unknown",
      receiptUrl: "https://notion.so/page-unknown",
    });
    vi.mocked(adapter.verifyReceipt).mockRejectedValue(
      new SharingConnectorUnknownOutcomeError("receipt read-back timed out"),
    );
    sharing.select({ connectionId: "codex", connector: "notion" });
    await sharing.probe();
    sharing.saveDestination({ destination: "Product Notes" });

    const unknown = await sharing.testShare(testAction(false));
    expect(unknown).toMatchObject({
      sharingReadiness: {
        status: "unknown",
        receipt: null,
        actionId: expect.any(String),
        remediation: expect.stringMatching(/Do not retry.*reconcile or abandon/i),
      },
    });
    expect(() => sharing.adoptionEvidence()).toThrow(/verified Test Share/i);
    await expect(sharing.testShare(testAction(true))).rejects.toThrow(/Unknown Outcome/);
    expect(adapter.testShare).toHaveBeenCalledTimes(1);

    sharing.abandonUnknown({ actionId: unknown.sharingReadiness.actionId! });
    expect(sharing.view().sharingReadiness.status).toBe("untested");
    await sharing.testShare(testAction(false));
    expect(adapter.testShare).toHaveBeenCalledTimes(2);
  });

  it("requires duplicate confirmation after a verified Test Share and can reconcile an Unknown Outcome", async () => {
    const { adapter, sharing } = setup();
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    vi.mocked(adapter.testShare).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    vi.mocked(adapter.verifyReceipt).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    sharing.select({ connectionId: "codex", connector: "notion" });
    await sharing.probe();
    sharing.saveDestination({ destination: "Product Notes" });

    await sharing.testShare(testAction(false));
    await expect(sharing.testShare(testAction(false))).rejects.toThrow(/duplicate/i);
    expect(adapter.testShare).toHaveBeenCalledTimes(1);
    await sharing.testShare(testAction(true));
    expect(adapter.testShare).toHaveBeenCalledTimes(2);

    vi.mocked(adapter.verifyReceipt).mockRejectedValueOnce(
      new SharingConnectorUnknownOutcomeError("read-back interrupted"),
    );
    const unknown = await sharing.testShare(testAction(true));
    vi.mocked(adapter.verifyReceipt).mockResolvedValueOnce({
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    await expect(sharing.reconcileUnknown({
      actionId: unknown.sharingReadiness.actionId!,
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    })).resolves.toMatchObject({ sharingReadiness: { status: "ready" } });
  });

  it("requires a current Connector Readiness proof after a process restart", async () => {
    const { adapter, host: currentHost, sharing } = setup();
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    vi.mocked(adapter.testShare).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    vi.mocked(adapter.verifyReceipt).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    sharing.select({ connectionId: "codex", connector: "notion" });
    await sharing.probe();
    sharing.saveDestination({ destination: "Product Notes" });
    await sharing.testShare(testAction(false));

    const restarted = new SharingConfiguration({ host: currentHost, adapter });
    expect(restarted.view()).toMatchObject({
      connectorReadiness: { status: "untested" },
      sharingReadiness: { status: "untested", duplicateWarningRequired: true },
    });
    expect(await restarted.probe()).toMatchObject({
      connectorReadiness: { status: "ready" },
      sharingReadiness: { status: "ready" },
    });
    vi.mocked(adapter.probe).mockRejectedValueOnce(new Error("Notion OAuth expired"));
    expect(await restarted.probe()).toMatchObject({
      connectorReadiness: { status: "failed" },
      sharingReadiness: { status: "failed", receipt: null },
    });
  });

  it("requires a fresh Test Share when the selected Agent Connection revision changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T04:00:00.000Z"));
    const { adapter, host: currentHost, sharing } = setup();
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    vi.mocked(adapter.testShare).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-revision-a",
      receiptUrl: "https://notion.so/page-revision-a",
    });
    vi.mocked(adapter.verifyReceipt).mockImplementation(async (input) => input.receipt);
    sharing.select({ connectionId: "codex", connector: "notion" });
    await sharing.probe();
    sharing.saveDestination({ destination: "Product Notes" });
    await sharing.testShare(testAction(false));
    expect(sharing.adoptionEvidence().snapshot.adapter).toBe("codex");

    currentHost.upsertAgentConnectionRecord({
      id: "codex",
      kind: "supported-agent",
      adapter: "codex",
      label: "Codex",
      lifecycle: "available",
      settings: { executablePath: "/fake/codex-revision-b" },
    });
    await sharing.probe();

    expect(sharing.view().sharingReadiness).toMatchObject({
      status: "untested",
      receipt: null,
    });
    expect(() => sharing.adoptionEvidence()).toThrow(/current verified Test Share/i);
  });

  it("replays one client action id without creating another external write", async () => {
    const { adapter, sharing } = setup();
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    vi.mocked(adapter.testShare).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    vi.mocked(adapter.verifyReceipt).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    sharing.select({ connectionId: "codex", connector: "notion" });
    await sharing.probe();
    sharing.saveDestination({ destination: "Product Notes" });
    const input = {
      actionId: "00000000-0000-4000-8000-000000000001",
      duplicateConfirmed: true,
    };

    await sharing.testShare(input);
    await sharing.testShare(input);

    expect(adapter.testShare).toHaveBeenCalledTimes(1);
    expect(adapter.verifyReceipt).toHaveBeenCalledTimes(1);
  });

  it("pins one production Share Action snapshot and replays its durable outcome without another write", async () => {
    const { adapter, host: currentHost, sharing } = setup();
    const productionWrite = vi.fn(async () => ({
      destination: "Product Notes",
      receiptId: "page-production-1",
      receiptUrl: "https://notion.so/page-production-1",
    }));
    vi.mocked(adapter.share).mockImplementation(productionWrite);
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    vi.mocked(adapter.testShare).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-test-1",
      receiptUrl: "https://notion.so/page-test-1",
    });
    vi.mocked(adapter.verifyReceipt)
      .mockResolvedValueOnce({
        destination: "Product Notes",
        receiptId: "page-test-1",
        receiptUrl: "https://notion.so/page-test-1",
      })
      .mockResolvedValue({
        destination: "Product Notes",
        receiptId: "page-production-1",
        receiptUrl: "https://notion.so/page-production-1",
      });
    sharing.select({ connectionId: "codex", connector: "notion" });
    await sharing.probe();
    sharing.saveDestination({ destination: "Product Notes" });
    await sharing.testShare(testAction(false));

    const summary = "# Product decision\n\nShip the verified manual flow.";
    const preview = (sharing as unknown as {
      recordingShareView(input: { recordingStem: string; summary: string }): {
        status: string;
        actionCounts: { total: number; verified: number };
        snapshot: { hash: string; summary: string; connection: { id: string; label: string; adapter: string }; destination: string };
      };
    }).recordingShareView({ recordingStem: "TeamSync_20260828_090000", summary });
    expect(preview).toMatchObject({
      status: "ready",
      actionCounts: { total: 0, verified: 0 },
      snapshot: {
        summary,
        connection: { id: "codex", label: "Codex", adapter: "codex" },
        destination: "Product Notes",
      },
    });

    const input = {
      actionId: "00000000-0000-4000-8000-000000000099",
      recordingStem: "TeamSync_20260828_090000",
      summary,
      snapshotHash: preview.snapshot.hash,
      duplicateConfirmed: false,
    };
    const first = await (sharing as unknown as {
      shareRecording(input: {
        actionId: string; recordingStem: string; summary: string;
        snapshotHash: string; duplicateConfirmed: boolean;
      }): Promise<unknown>;
    }).shareRecording(input);
    const replay = await (sharing as unknown as {
      shareRecording(input: {
        actionId: string; recordingStem: string; summary: string;
        snapshotHash: string; duplicateConfirmed: boolean;
      }): Promise<unknown>;
    }).shareRecording(input);

    expect(first).toMatchObject({
      actionCounts: { total: 1, verified: 1 },
      latestAction: { id: input.actionId, status: "verified" },
    });
    expect(replay).toEqual(first);
    expect(productionWrite).toHaveBeenCalledTimes(1);
    expect(adapter.verifyReceipt).toHaveBeenCalledTimes(2);
    expect(currentHost.getRecordingShareAction(input.actionId)).toMatchObject({
      id: input.actionId,
      recordingStem: input.recordingStem,
      summary,
      connectionId: "codex",
      connectionAdapter: "codex",
      connectionLabel: "Codex",
      destination: "Product Notes",
      status: "verified",
      receiptId: "page-production-1",
    });
  });

  it("warns before a verified duplicate and fences an Unknown Outcome from ordinary retry", async () => {
    const { adapter, sharing } = setup();
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    vi.mocked(adapter.testShare).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-test-1",
      receiptUrl: "https://notion.so/page-test-1",
    });
    vi.mocked(adapter.share).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-production-1",
      receiptUrl: "https://notion.so/page-production-1",
    });
    vi.mocked(adapter.verifyReceipt).mockImplementation(async (input) => input.receipt);
    sharing.select({ connectionId: "codex", connector: "notion" });
    await sharing.probe();
    sharing.saveDestination({ destination: "Product Notes" });
    await sharing.testShare(testAction(false));

    const summary = "# Decision\n\nShip it.";
    const view = sharing.recordingShareView({ recordingStem: "TeamSync_20260828_090000", summary });
    const action = (suffix: string, duplicateConfirmed: boolean) => ({
      actionId: `00000000-0000-4000-8000-${suffix}`,
      recordingStem: "TeamSync_20260828_090000",
      summary,
      snapshotHash: view.snapshot!.hash,
      duplicateConfirmed,
    });
    await sharing.shareRecording(action("000000000101", false));
    expect(sharing.recordingShareView({ recordingStem: "TeamSync_20260828_090000", summary }))
      .toMatchObject({ duplicateWarningRequired: true });
    await expect(sharing.shareRecording(action("000000000102", false))).rejects.toThrow(/already delivered/i);
    await sharing.shareRecording(action("000000000102", true));

    vi.mocked(adapter.verifyReceipt).mockRejectedValueOnce(
      new SharingConnectorUnknownOutcomeError("production receipt read-back timed out"),
    );
    const unknown = await sharing.shareRecording(action("000000000103", true));
    expect(unknown).toMatchObject({
      status: "unknown",
      latestAction: { id: "00000000-0000-4000-8000-000000000103", status: "unknown" },
      remediation: expect.stringMatching(/Do not retry/i),
    });
    await expect(sharing.shareRecording(action("000000000104", true))).rejects.toThrow(/Unknown Outcome/i);
    expect(adapter.share).toHaveBeenCalledTimes(3);

    (sharing as unknown as { abandonRecordingUnknown(input: { actionId: string }): unknown })
      .abandonRecordingUnknown({ actionId: "00000000-0000-4000-8000-000000000103" });
    await sharing.shareRecording(action("000000000104", true));
    expect(adapter.share).toHaveBeenCalledTimes(4);
  });
});
