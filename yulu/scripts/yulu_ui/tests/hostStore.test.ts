import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { HostStore, type AgentTask, type ArtifactRecord, type CoreActivationEvidence } from "../src/hostStore.js";
import { CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS } from "../src/onboarding.js";

const NOTION_PAGE_ID = "0123456789abcdef0123456789abcdef";
const SUMMARY_IDENTITY = { summaryProvider: "hermes", summaryModel: "runtime-managed" } as const;

describe("HostStore", () => {
  let root = "";
  let store: HostStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  function createStore() {
    root = mkdtempSync(join(tmpdir(), "yulu-host-store-"));
    store = new HostStore(join(root, "host.sqlite"));
    return store;
  }

  function enqueue(sendToNotion = true) {
    const current = store ?? createStore();
    return current.enqueueRecording({
      idempotencyKey: "recording:demo:1",
      recordingStem: "Demo_20260711_120000",
      title: "Demo",
      audioPath: join(root, "Demo_20260711_120000.wav"),
      sendToNotion,
      destinationHint: "Yulu Meeting",
      agentProvider: "hermes",
      ...SUMMARY_IDENTITY,
    });
  }

  function artifacts(taskId: string): ArtifactRecord[] {
    return [
      {
        id: "transcript-id",
        taskId,
        recordingStem: "Demo_20260711_120000",
        kind: "transcript",
        path: join(root, "Demo_20260711_120000.transcript.txt"),
        sha256: "a".repeat(64),
        bytes: 10,
        mimeType: "text/plain",
        provenance: { agent: "hermes" },
        createdAt: new Date().toISOString(),
      },
      {
        id: "summary-id",
        taskId,
        recordingStem: "Demo_20260711_120000",
        kind: "summary",
        path: join(root, "Demo_20260711_120000.summary.md"),
        sha256: "b".repeat(64),
        bytes: 12,
        mimeType: "text/markdown",
        provenance: { agent: "hermes" },
        createdAt: new Date().toISOString(),
      },
    ];
  }

  function recordPublishedArtifacts(taskId: string, leaseToken: string): AgentTask {
    const committed = store!.recordArtifacts(taskId, leaseToken, artifacts(taskId));
    store!.markArtifactsPublished(taskId, leaseToken);
    return committed;
  }

  function seedStartedNotionDelivery(task: AgentTask): void {
    const timestamp = "2026-07-11T12:10:00.000Z";
    store!.db.prepare(`
      INSERT INTO notion_deliveries (
        task_id, delivery_key, status, destination, created_at, updated_at
      ) VALUES (?, ?, 'sending', 'Yulu Meeting', ?, ?)
    `).run(task.id, `yulu-${task.id}`, timestamp, timestamp);
    store!.db.prepare("UPDATE agent_tasks SET state = 'sending', phase = 'sending_notion' WHERE id = ?")
      .run(task.id);
  }

  function activationEvidence(taskId: string): CoreActivationEvidence {
    return {
      recordingStem: "Demo_20260711_120000",
      taskId,
      transcriptionProvider: "local",
      summaryProvider: "hermes",
      summaryModel: "runtime-managed",
      artifacts: {
        audio: { sha256: "c".repeat(64), bytes: 44 },
        transcript: { sha256: "a".repeat(64), bytes: 10 },
        summary: { sha256: "b".repeat(64), bytes: 12 },
      },
      completedAt: "2026-07-11T12:10:00.000Z",
    };
  }

  it("snapshots Codex connection, credential class, disclosure, and committed transcript identity before Summary execution", () => {
    createStore();
    const task = store!.enqueueRecording({
      idempotencyKey: "recording:codex-summary-snapshot",
      recordingStem: "Demo_20260711_120000",
      title: "Demo",
      audioPath: join(root, "Demo_20260711_120000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "gpt-5.6-sol",
      summaryConnectionId: "codex",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "codex-summary-v1",
    }).task;
    expect(task).toMatchObject({
      summaryConnectionId: "codex",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "codex-summary-v1",
      summaryInputArtifactId: null,
      summaryInputArtifactSha256: null,
      summaryInputArtifactBytes: null,
    });

    const claimed = store!.claim(task.id)!;
    const transcript = artifacts(task.id)[0]!;
    store!.recordTranscript(task.id, claimed.leaseToken!, transcript);
    const snapshotted = store!.recordSummaryInputSnapshot(task.id, claimed.leaseToken!, transcript);

    expect(snapshotted).toMatchObject({
      summaryConnectionId: "codex",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "codex-summary-v1",
      summaryInputArtifactId: "transcript-id",
      summaryInputArtifactSha256: "a".repeat(64),
      summaryInputArtifactBytes: 10,
    });
  });

  it("persists and projects only secret-safe Runtime Evidence fields", () => {
    createStore();
    store!.upsertAgentConnectionRecord({
      id: "codex",
      kind: "supported-agent",
      adapter: "codex",
      label: "Codex",
      lifecycle: "available",
      settings: { executablePath: "/fake/codex" },
    });

    const recorded = store!.recordAgentConnectionReadiness({
      connectionId: "codex",
      capability: "conversation",
      status: "ready",
      model: "gpt-5.6-sol",
      credentialSource: null,
      detail: "Exact model ready",
      reason: null,
      runtimeEvidence: {
        adapter: "codex",
        transport: "codex-app-server-stdio",
        runtimeVersion: "0.144.4",
        authorizationClass: "chatgpt",
        requestedProvider: "openai",
        requestedModel: "gpt-5.6-sol",
        actualProvider: "openai",
        actualModel: "gpt-5.6-sol",
        requestId: "turn-safe",
        sessionId: "thread-safe",
        terminalStatus: "ready",
        fallbackOccurred: false,
        token: "never-persist-token",
        prompt: "never-persist-prompt",
        transcript: "never-persist-transcript",
        responseBody: "never-persist-response",
      } as never,
      testedAt: "2026-08-28T01:00:00.000Z",
    });

    expect(recorded.runtimeEvidence).toEqual({
      adapter: "codex",
      transport: "codex-app-server-stdio",
      runtimeVersion: "0.144.4",
      authorizationClass: "chatgpt",
      requestedProvider: "openai",
      requestedModel: "gpt-5.6-sol",
      actualProvider: "openai",
      actualModel: "gpt-5.6-sol",
      requestId: "turn-safe",
      sessionId: "thread-safe",
      terminalStatus: "ready",
      fallbackOccurred: false,
    });
    const serialized = JSON.stringify(store!.listAgentConnectionReadinessHistory("codex", "conversation"));
    expect(serialized).not.toMatch(/never-persist|token|prompt|transcript|responseBody/);
    const stored = store!.db.prepare("SELECT runtime_evidence_json FROM agent_connection_readiness_history").get() as {
      runtime_evidence_json: string;
    };
    expect(stored.runtime_evidence_json).not.toMatch(/never-persist|token|prompt|transcript|responseBody/);
  });

  it.each([
    "invalid_model",
    "missing_credentials",
    "entitlement_failed",
    "credential_refresh_failed",
    "identity_mismatch",
    "readiness_failed",
    "unknown_outcome",
  ] as const)("persists the exact secret-safe readiness reason %s", (reason) => {
    createStore();
    store!.upsertAgentConnectionRecord({
      id: "direct-xai",
      kind: "direct-provider",
      adapter: "direct-xai",
      label: "xAI",
      lifecycle: "available",
      settings: { credentialSource: "oauth" },
    });

    store!.recordAgentConnectionReadiness({
      connectionId: "direct-xai",
      capability: "summary",
      status: "failed",
      model: "grok-summary-exact",
      credentialSource: "oauth",
      detail: "Secret-safe repair detail",
      reason,
      runtimeEvidence: {
        adapter: "direct-xai",
        transport: "xai-http",
        runtimeVersion: null,
        requestedProvider: "xai",
        requestedModel: "grok-summary-exact",
        actualProvider: null,
        actualModel: null,
        requestId: null,
        sessionId: null,
        terminalStatus: reason === "unknown_outcome" ? "unknown" : "failed",
        fallbackOccurred: false,
      },
      testedAt: "2026-08-29T01:00:00.000Z",
    });

    expect(store!.listAgentConnectionReadinessHistory("direct-xai", "summary")[0]?.reason).toBe(reason);
  });

  it("migrates the legacy readiness-reason constraint without losing history", () => {
    root = mkdtempSync(join(tmpdir(), "yulu-host-store-"));
    const databasePath = join(root, "host.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE agent_connections (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('direct-provider', 'supported-agent', 'legacy-custom')),
        adapter TEXT NOT NULL,
        label TEXT NOT NULL,
        lifecycle TEXT NOT NULL CHECK(lifecycle IN ('available', 'legacy')),
        settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE agent_connection_readiness_history (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
        capability TEXT NOT NULL CHECK(capability IN ('transcription', 'summary', 'conversation')),
        status TEXT NOT NULL CHECK(status IN ('ready', 'failed')),
        model TEXT NOT NULL,
        credential_source TEXT CHECK(credential_source IN ('oauth', 'api-key')),
        detail TEXT NOT NULL,
        reason TEXT CHECK(reason IN ('invalid_model', 'readiness_failed')),
        runtime_evidence_json TEXT NOT NULL DEFAULT '{}',
        tested_at TEXT NOT NULL
      );
      INSERT INTO agent_connections VALUES (
        'direct-xai', 'direct-provider', 'direct-xai', 'xAI', 'available',
        '{"credentialSource":"oauth"}', '2026-08-28T01:00:00.000Z', '2026-08-28T01:00:00.000Z'
      );
      INSERT INTO agent_connection_readiness_history VALUES (
        'legacy-ready', 'direct-xai', 'summary', 'failed', 'grok-summary-exact', 'oauth',
        'Legacy failure', 'readiness_failed', '{}', '2026-08-28T01:00:00.000Z'
      );
    `);
    legacy.close();

    store = new HostStore(databasePath);

    expect(store.listAgentConnectionReadinessHistory("direct-xai", "summary"))
      .toEqual([expect.objectContaining({ id: "legacy-ready", reason: "readiness_failed" })]);
    const schema = store.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_connection_readiness_history'",
    ).get() as { sql: string };
    expect(schema.sql).toContain("'credential_refresh_failed'");
  });

  it("reads back an explicit Share Destination and invalidates its Test Share receipt when configuration changes", () => {
    createStore();
    store!.upsertAgentConnectionRecord({
      id: "codex",
      kind: "supported-agent",
      adapter: "codex",
      label: "Codex",
      lifecycle: "available",
      settings: { executablePath: "/fake/codex" },
    });

    expect(store!.selectSharingConfiguration({ connectionId: "codex", connector: "notion" }))
      .toMatchObject({
        connectionId: "codex",
        connector: "notion",
        destination: null,
        destinationSavedAt: null,
        testReceipt: null,
      });

    const saved = store!.saveShareDestination({
      connectionId: "codex",
      connector: "notion",
      destination: "Product Notes",
    });
    expect(saved).toMatchObject({
      destination: "Product Notes",
      destinationSavedAt: expect.any(String),
      testReceipt: null,
    });
    expect(store!.getSharingConfiguration()).toEqual(saved);

    const { action } = store!.beginSharingTestAction({
      id: "00000000-0000-4000-8000-000000000001",
      connectionId: "codex",
      connectionAdapter: "codex",
      connectionLabel: "Codex",
      connector: "notion",
      destination: "Product Notes",
      contentSha256: "a".repeat(64),
      duplicateConfirmed: false,
    });
    store!.markSharingTestActionVerified(action.id, {
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
      detail: "Connector read-back matched",
    });
    expect(store!.getSharingConfiguration()?.testReceipt).toEqual({
      id: "page-123",
      url: "https://notion.so/page-123",
      verifiedAt: expect.any(String),
    });

    store!.saveShareDestination({
      connectionId: "codex",
      connector: "notion",
      destination: "Research Notes",
    });
    expect(store!.getSharingConfiguration()).toMatchObject({
      destination: "Research Notes",
      testReceipt: null,
    });
  });

  it("persists every Test Share action and fences an interrupted action as Unknown Outcome across restart", () => {
    createStore();
    store!.upsertAgentConnectionRecord({
      id: "codex",
      kind: "supported-agent",
      adapter: "codex",
      label: "Codex",
      lifecycle: "available",
      settings: { executablePath: "/fake/codex" },
    });
    store!.selectSharingConfiguration({ connectionId: "codex", connector: "notion" });
    store!.saveShareDestination({ connectionId: "codex", connector: "notion", destination: "Product Notes" });

    const { action: pending } = store!.beginSharingTestAction({
      id: "00000000-0000-4000-8000-000000000002",
      connectionId: "codex",
      connectionAdapter: "codex",
      connectionLabel: "Codex",
      connector: "notion",
      destination: "Product Notes",
      contentSha256: "a".repeat(64),
      duplicateConfirmed: false,
    });
    expect(pending).toMatchObject({ status: "pending", destination: "Product Notes" });
    expect(store!.beginSharingTestAction({
      id: pending.id,
      connectionId: "codex",
      connectionAdapter: "codex",
      connectionLabel: "Codex",
      connector: "notion",
      destination: "Product Notes",
      contentSha256: "a".repeat(64),
      duplicateConfirmed: false,
    })).toMatchObject({ created: false, action: { id: pending.id, status: "pending" } });
    expect(() => store!.beginSharingTestAction({
      id: "00000000-0000-4000-8000-000000000003",
      connectionId: "codex",
      connectionAdapter: "codex",
      connectionLabel: "Codex",
      connector: "notion",
      destination: "Product Notes",
      contentSha256: "a".repeat(64),
      duplicateConfirmed: false,
    })).toThrow(/pending or has an Unknown Outcome/);

    const dbPath = join(root, "host.sqlite");
    store!.close();
    store = new HostStore(dbPath);
    expect(store!.getSharingTestAction(pending.id)).toMatchObject({
      status: "unknown",
      detail: "Host restarted before the Test Share receipt was verified",
    });
    expect(() => store!.beginSharingTestAction({
      id: "00000000-0000-4000-8000-000000000004",
      connectionId: "codex",
      connectionAdapter: "codex",
      connectionLabel: "Codex",
      connector: "notion",
      destination: "Product Notes",
      contentSha256: "a".repeat(64),
      duplicateConfirmed: false,
    })).toThrow(/Unknown Outcome/);

    store!.abandonSharingTestAction(pending.id);
    const { action: next } = store!.beginSharingTestAction({
      id: "00000000-0000-4000-8000-000000000005",
      connectionId: "codex",
      connectionAdapter: "codex",
      connectionLabel: "Codex",
      connector: "notion",
      destination: "Product Notes",
      contentSha256: "a".repeat(64),
      duplicateConfirmed: false,
    });
    store!.markSharingTestActionVerified(next.id, {
      receiptId: "page-456",
      receiptUrl: "https://notion.so/page-456",
      detail: "Connector read-back matched",
    });
    expect(store!.listSharingTestActions()).toEqual([
      expect.objectContaining({ id: next.id, status: "verified", receiptId: "page-456" }),
      expect.objectContaining({ id: pending.id, status: "abandoned" }),
    ]);
  });

  it("persists a Share Action snapshot and fences an interrupted production write across restart", () => {
    createStore();
    store!.upsertAgentConnectionRecord({
      id: "codex",
      kind: "supported-agent",
      adapter: "codex",
      label: "Codex",
      lifecycle: "available",
      settings: { executablePath: "/fake/codex" },
    });
    store!.selectSharingConfiguration({ connectionId: "codex", connector: "notion" });
    store!.saveShareDestination({ connectionId: "codex", connector: "notion", destination: "Product Notes" });
    const { action: testShare } = store!.beginSharingTestAction({
      id: "00000000-0000-4000-8000-000000000110",
      connectionId: "codex",
      connectionAdapter: "codex",
      connectionLabel: "Codex",
      connector: "notion",
      destination: "Product Notes",
      contentSha256: "a".repeat(64),
      duplicateConfirmed: false,
    });
    store!.markSharingTestActionVerified(testShare.id, {
      receiptId: "page-test-110",
      receiptUrl: "https://notion.so/page-test-110",
      detail: "Connector read-back matched",
    });
    const connection = store!.listAgentConnectionRecords().find((record) => record.id === "codex")!;
    const snapshot = {
      recordingStem: "TeamSync_20260828_090000",
      summary: "# Decision\n\nShip it.",
      summarySha256: "b".repeat(64),
      snapshotSha256: "c".repeat(64),
      connectionId: "codex",
      connectionAdapter: "codex",
      connectionLabel: "Codex",
      connectionUpdatedAt: connection.updatedAt,
      connector: "notion" as const,
      destination: "Product Notes",
      duplicateConfirmed: false,
    };
    const { action: pending } = store!.beginRecordingShareAction({
      id: "00000000-0000-4000-8000-000000000111",
      ...snapshot,
    });
    expect(pending).toMatchObject({ status: "pending", summary: snapshot.summary });

    const dbPath = join(root, "host.sqlite");
    store!.close();
    store = new HostStore(dbPath);
    expect(store!.getRecordingShareAction(pending.id)).toMatchObject({
      status: "unknown",
      detail: "Host restarted before the Share Action receipt was verified",
    });
    expect(() => store!.beginRecordingShareAction({
      id: "00000000-0000-4000-8000-000000000112",
      ...snapshot,
    })).toThrow(/pending or has an Unknown Outcome/);

    store!.abandonRecordingShareAction(pending.id);
    const { action: verified } = store!.beginRecordingShareAction({
      id: "00000000-0000-4000-8000-000000000113",
      ...snapshot,
    });
    store!.markRecordingShareActionVerified(verified.id, {
      receiptId: "page-production-113",
      receiptUrl: "https://notion.so/page-production-113",
      detail: "Connector read-back matched",
    });
    expect(store!.getRecordingShareAction(verified.id)).toMatchObject({
      status: "verified",
      receiptId: "page-production-113",
    });
    expect(store!.getRecordingShareAction(pending.id)).toMatchObject({
      status: "abandoned",
      summary: snapshot.summary,
    });
  });

  it("clears the Summary input snapshot only when an explicit retry discards its transcript artifact", () => {
    createStore();
    const task = store!.enqueueRecording({
      idempotencyKey: "recording:codex-summary-discard",
      recordingStem: "Demo_20260711_120000",
      title: "Demo",
      audioPath: join(root, "Demo_20260711_120000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "gpt-5.6-sol",
      summaryConnectionId: "codex",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "codex-summary-v1",
    }).task;
    const claimed = store!.claim(task.id)!;
    const transcript = artifacts(task.id)[0]!;
    store!.recordTranscript(task.id, claimed.leaseToken!, transcript);
    store!.recordSummaryInputSnapshot(task.id, claimed.leaseToken!, transcript);
    store!.fail(task.id, claimed.leaseToken, "failed before commit");

    expect(store!.retry(task.id, { discardArtifacts: true })).toMatchObject({
      state: "queued",
      summaryInputArtifactId: null,
      summaryInputArtifactSha256: null,
      summaryInputArtifactBytes: null,
    });
    expect(store!.listArtifacts(task.id)).toEqual([]);
  });

  it("durably fences an Agent execution Unknown Outcome from retry, claim, and recording deletion", () => {
    createStore();
    const task = store!.enqueueRecording({
      idempotencyKey: "recording:claude-unknown-outcome",
      recordingStem: "Demo_20260711_120000",
      title: "Demo",
      audioPath: join(root, "Demo_20260711_120000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "claude-code",
      summaryProvider: "claude-code",
      summaryModel: "claude-sonnet-5",
      summaryConnectionId: "claude-code",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "claude-code-summary-v1",
    }).task;
    const claimed = store!.claim(task.id)!;
    const transcript = artifacts(task.id)[0]!;
    store!.recordTranscript(task.id, claimed.leaseToken!, transcript);
    store!.recordSummaryInputSnapshot(task.id, claimed.leaseToken!, transcript);
    store!.beginSummaryExecution(task.id, claimed.leaseToken!);
    const unknown = store!.markClaudeSummaryUnknownOutcome(
      task.id,
      claimed.leaseToken!,
      "Claude Code Summary entered Unknown Outcome",
      "unknown-session-140",
      {
        adapter: "claude-code",
        transport: "claude-code-print-stream-json",
        runtimeVersion: "2.1.169",
        requestedProvider: "firstParty",
        requestedModel: "claude-sonnet-5",
        actualProvider: "firstParty",
        actualModel: "claude-sonnet-5",
        requestId: null,
        sessionId: "unknown-session-140",
        terminalStatus: "unknown",
        fallbackOccurred: false,
        token: "never-persist-summary-token",
        prompt: "never-persist-summary-prompt",
        responseBody: "never-persist-summary-response",
      } as never,
    );

    expect(unknown).toMatchObject({
      state: "execution_unverified",
      phase: "failed",
      leaseToken: null,
      nativeSessionId: "unknown-session-140",
      error: "Claude Code Summary entered Unknown Outcome",
    });
    expect(store!.claimNext()).toBeNull();
    expect(() => store!.retry(task.id)).toThrow("cannot retry from execution_unverified");
    expect(store!.listEvents(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "claude.summary_unknown_outcome",
        payload: expect.objectContaining({
          nativeSessionId: "unknown-session-140",
          runtimeEvidence: expect.objectContaining({ terminalStatus: "unknown" }),
        }),
      }),
    ]));
    expect(JSON.stringify(store!.listEvents(task.id))).not.toMatch(/never-persist-summary|token|prompt|responseBody/);
    const persisted = store!.db.prepare("SELECT audit_json FROM agent_tasks WHERE id = ?").get(task.id) as {
      audit_json: string;
    };
    expect(persisted.audit_json).not.toMatch(/never-persist-summary|token|prompt|responseBody/);
    expect(() => store!.prepareRecordingDeletion(task.recordingStem)).toThrow("execution_unverified");
  });

  it("does not replay an interrupted Codex Summary after Host restart", () => {
    createStore();
    const task = store!.enqueueRecording({
      idempotencyKey: "recording:codex-crash-after-dispatch",
      recordingStem: "Demo_20260711_120000",
      title: "Codex crash fence",
      audioPath: join(root, "Demo_20260711_120000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "gpt-5.6-sol",
      summaryConnectionId: "codex",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "codex-summary-v1",
      instructions: "Use only the committed transcript.",
    }).task;
    const claimed = store!.claim(task.id)!;
    const transcript = artifacts(task.id)[0]!;
    store!.recordTranscript(task.id, claimed.leaseToken!, transcript);
    store!.recordSummaryInputSnapshot(task.id, claimed.leaseToken!, transcript);
    const executionId = store!.beginSummaryExecution(task.id, claimed.leaseToken!);
    const dbPath = join(root, "host.sqlite");

    store!.close();
    store = new HostStore(dbPath);

    expect(store.getTask(task.id)).toMatchObject({
      state: "execution_unverified",
      phase: "failed",
      leaseToken: null,
      nativeSessionId: executionId,
      artifactSessionId: executionId,
      error: expect.stringContaining("outcome is unknown"),
    });
    expect(store.claimNext()).toBeNull();
    expect(() => store!.retry(task.id)).toThrow("cannot retry from execution_unverified");
    expect(store.listEvents(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "summary.unknown_outcome",
        payload: expect.objectContaining({
          executionId,
          provider: "codex",
          model: "gpt-5.6-sol",
          recoveredAfterRestart: true,
        }),
      }),
    ]));
  });

  it("fails closed instead of replaying a Summary with a corrupted dispatch journal", () => {
    createStore();
    const task = store!.enqueueRecording({
      idempotencyKey: "recording:codex-corrupted-dispatch-journal",
      recordingStem: "Demo_20260711_120000",
      title: "Codex corrupted dispatch fence",
      audioPath: join(root, "Demo_20260711_120000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "gpt-5.6-sol",
      summaryConnectionId: "codex",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "codex-summary-v1",
      instructions: "Use only the committed transcript.",
    }).task;
    const claimed = store!.claim(task.id)!;
    const transcript = artifacts(task.id)[0]!;
    store!.recordTranscript(task.id, claimed.leaseToken!, transcript);
    store!.recordSummaryInputSnapshot(task.id, claimed.leaseToken!, transcript);
    store!.beginSummaryExecution(task.id, claimed.leaseToken!);
    store!.db.prepare("UPDATE agent_tasks SET audit_json = ? WHERE id = ?")
      .run(JSON.stringify({ summaryExecution: { model: "attacker-secret-model" } }), task.id);
    const dbPath = join(root, "host.sqlite");

    store!.close();
    store = new HostStore(dbPath);

    expect(store.getTask(task.id)).toMatchObject({
      state: "execution_unverified",
      phase: "failed",
      leaseToken: null,
      nativeSessionId: null,
      artifactSessionId: null,
      error: "Host restarted with an unverifiable Summary dispatch journal; outcome is unknown",
    });
    expect(store.claimNext()).toBeNull();
    expect(() => store!.retry(task.id)).toThrow("cannot retry from execution_unverified");
    expect(JSON.stringify(store.listEvents(task.id))).not.toContain("attacker-secret-model");
  });

  it.each([
    [false, "completed"],
    [true, "artifacts_committed"],
  ])("recovers a durably committed Codex Summary without replay when sendToNotion=%s", (sendToNotion, state) => {
    createStore();
    const task = store!.enqueueRecording({
      idempotencyKey: `recording:codex-artifacts-committed:${sendToNotion}`,
      recordingStem: "Demo_20260711_120000",
      title: "Codex committed recovery",
      audioPath: join(root, "Demo_20260711_120000.wav"),
      sendToNotion,
      destinationHint: "Yulu Meeting",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "gpt-5.6-sol",
      summaryConnectionId: "codex",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "codex-summary-v1",
    }).task;
    const claimed = store!.claim(task.id)!;
    const transcript = artifacts(task.id)[0]!;
    store!.recordTranscript(task.id, claimed.leaseToken!, transcript);
    store!.recordSummaryInputSnapshot(task.id, claimed.leaseToken!, transcript);
    store!.beginSummaryExecution(task.id, claimed.leaseToken!);
    recordPublishedArtifacts(task.id, claimed.leaseToken!);
    const dbPath = join(root, "host.sqlite");

    store!.close();
    store = new HostStore(dbPath);

    expect(store.getTask(task.id)).toMatchObject({ state, leaseToken: null, error: null });
    expect(store.listEvents(task.id).filter(({ type }) => type === "summary.unknown_outcome")).toEqual([]);
    if (sendToNotion) {
      expect(store.claimNext()).toMatchObject({ id: task.id, state: "artifacts_committed" });
    } else {
      expect(store.claimNext()).toBeNull();
    }
  });

  it("recovers a Host-accounted but unpublished Summary without completing or replaying it", () => {
    createStore();
    const task = store!.enqueueRecording({
      idempotencyKey: "recording:summary-publish-pending",
      recordingStem: "Demo_20260711_120000",
      title: "Codex publish recovery",
      audioPath: join(root, "Demo_20260711_120000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "gpt-5.6-sol",
      summaryConnectionId: "codex",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "codex-summary-v1",
    }).task;
    const claimed = store!.claim(task.id)!;
    const transcript = artifacts(task.id)[0]!;
    store!.recordTranscript(task.id, claimed.leaseToken!, transcript);
    store!.recordSummaryInputSnapshot(task.id, claimed.leaseToken!, transcript);
    store!.beginSummaryExecution(task.id, claimed.leaseToken!);
    store!.recordArtifacts(task.id, claimed.leaseToken!, artifacts(task.id));
    expect(store!.isArtifactPublishPending(task.id)).toBe(true);
    expect(() => store!.complete(task.id, claimed.leaseToken!, {})).toThrow(/publication is pending/);
    const dbPath = join(root, "host.sqlite");

    store!.close();
    store = new HostStore(dbPath);

    expect(store.getTask(task.id)).toMatchObject({ state: "artifacts_committed", leaseToken: null });
    expect(store.isArtifactPublishPending(task.id)).toBe(true);
    const recovered = store.claim(task.id)!;
    expect(store.isArtifactPublishPending(task.id)).toBe(true);
    store.markArtifactsPublished(task.id, recovered.leaseToken!);
    expect(store.isArtifactPublishPending(task.id)).toBe(false);
    expect(store.complete(task.id, recovered.leaseToken!, { recovered: true }).state).toBe("completed");
  });

  it.each([
    ["wrong terminal", { terminalStatus: "ready" as const }],
    ["wrong model", { actualModel: "claude-fallback" }],
    ["wrong provider", { actualProvider: "anthropic" }],
    ["missing provider", { requestedProvider: null, actualProvider: null }],
  ])("rejects Unknown Outcome persistence with %s evidence", (_label, evidenceOverride) => {
    createStore();
    const task = store!.enqueueRecording({
      idempotencyKey: `recording:claude-unknown-${_label}`,
      recordingStem: "Demo_20260711_120000",
      title: "Demo",
      audioPath: join(root, "Demo_20260711_120000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "claude-code",
      summaryProvider: "claude-code",
      summaryModel: "claude-sonnet-5",
      summaryConnectionId: "claude-code",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "claude-code-summary-v1",
    }).task;
    const claimed = store!.claim(task.id)!;
    const transcript = artifacts(task.id)[0]!;
    store!.recordTranscript(task.id, claimed.leaseToken!, transcript);
    store!.recordSummaryInputSnapshot(task.id, claimed.leaseToken!, transcript);
    store!.beginSummaryExecution(task.id, claimed.leaseToken!);
    const evidence = {
      adapter: "claude-code",
      transport: "claude-code-print-stream-json",
      runtimeVersion: "2.1.169",
      requestedProvider: "firstParty",
      requestedModel: "claude-sonnet-5",
      actualProvider: "firstParty",
      actualModel: "claude-sonnet-5",
      requestId: "unknown-result-140",
      sessionId: "unknown-session-140",
      terminalStatus: "unknown" as const,
      fallbackOccurred: false,
      ...evidenceOverride,
    };

    expect(() => store!.markClaudeSummaryUnknownOutcome(
      task.id,
      claimed.leaseToken!,
      "Unknown Outcome",
      "unknown-session-140",
      evidence,
    )).toThrow("does not match the pinned Summary task identity");
    expect(store!.getTask(task.id)?.state).toBe("transcript_committed");
  });

  it("authorizes a Codex Summary commit only for unchanged lease/input and exact terminal Runtime Evidence", () => {
    createStore();
    const task = store!.enqueueRecording({
      idempotencyKey: "recording:codex-summary-commit-fence",
      recordingStem: "Demo_20260711_120000",
      title: "Demo",
      audioPath: join(root, "Demo_20260711_120000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "gpt-5.6-sol",
      summaryConnectionId: "codex",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "codex-summary-v1",
    }).task;
    const claimed = store!.claim(task.id)!;
    const transcript = artifacts(task.id)[0]!;
    store!.recordTranscript(task.id, claimed.leaseToken!, transcript);
    store!.recordSummaryInputSnapshot(task.id, claimed.leaseToken!, transcript);
    const runtimeEvidence = {
      adapter: "codex",
      transport: "codex-app-server-stdio",
      runtimeVersion: "0.144.4",
      requestedProvider: "openai",
      requestedModel: "gpt-5.6-sol",
      actualProvider: "openai",
      actualModel: "gpt-5.6-sol",
      requestId: "turn-139",
      sessionId: "thread-139",
      terminalStatus: "ready" as const,
      fallbackOccurred: false,
    };

    expect(() => store!.validateSummaryCommit(task.id, claimed.leaseToken!, {
      connectionId: "codex",
      credentialClass: "runtime-oauth",
      disclosureVersion: "codex-summary-v1",
      inputArtifact: transcript,
      runtimeEvidence,
      toolCalls: [],
    })).toThrow(/durable dispatch journal/i);
    store!.beginSummaryExecution(task.id, claimed.leaseToken!);
    expect(store!.validateSummaryCommit(task.id, claimed.leaseToken!, {
      connectionId: "codex",
      credentialClass: "runtime-oauth",
      disclosureVersion: "codex-summary-v1",
      inputArtifact: transcript,
      runtimeEvidence,
      toolCalls: [],
    })).toMatchObject({ id: task.id, state: "transcript_committed" });
    expect(() => store!.validateSummaryCommit(task.id, claimed.leaseToken!, {
      connectionId: "codex",
      credentialClass: "runtime-oauth",
      disclosureVersion: "codex-summary-v1",
      inputArtifact: transcript,
      runtimeEvidence: { ...runtimeEvidence, actualModel: "gpt-5.6-terra" },
      toolCalls: [],
    })).toThrow(/Runtime Evidence/i);
    expect(() => store!.validateSummaryCommit(task.id, claimed.leaseToken!, {
      connectionId: "codex",
      credentialClass: "runtime-oauth",
      disclosureVersion: "codex-summary-v1",
      inputArtifact: transcript,
      runtimeEvidence,
      toolCalls: ["commandExecution"],
    })).toThrow(/tool call/i);

    store!.db.prepare("UPDATE artifacts SET sha256 = ? WHERE task_id = ? AND kind = 'transcript'")
      .run("c".repeat(64), task.id);
    expect(() => store!.validateSummaryCommit(task.id, claimed.leaseToken!, {
      connectionId: "codex",
      credentialClass: "runtime-oauth",
      disclosureVersion: "codex-summary-v1",
      inputArtifact: transcript,
      runtimeEvidence,
      toolCalls: [],
    })).toThrow(/input artifact identity changed/i);
  });

  it("authorizes a Claude Code Summary commit only from exact non-empty provider Runtime Evidence", () => {
    createStore();
    const task = store!.enqueueRecording({
      idempotencyKey: "recording:claude-summary-commit-fence",
      recordingStem: "Demo_20260711_120000",
      title: "Demo",
      audioPath: join(root, "Demo_20260711_120000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "claude-code",
      summaryProvider: "claude-code",
      summaryModel: "claude-sonnet-5",
      summaryConnectionId: "claude-code",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "claude-code-summary-v1",
    }).task;
    const claimed = store!.claim(task.id)!;
    const transcript = artifacts(task.id)[0]!;
    store!.recordTranscript(task.id, claimed.leaseToken!, transcript);
    store!.recordSummaryInputSnapshot(task.id, claimed.leaseToken!, transcript);
    const runtimeEvidence = {
      adapter: "claude-code",
      transport: "claude-code-print-stream-json",
      runtimeVersion: "2.1.169",
      requestedProvider: "firstParty",
      requestedModel: "claude-sonnet-5",
      actualProvider: "firstParty",
      actualModel: "claude-sonnet-5",
      requestId: "request-summary-140",
      sessionId: "019f0000-0000-7000-8000-000000000140",
      terminalStatus: "ready" as const,
      fallbackOccurred: false,
    };

    expect(() => store!.validateSummaryCommit(task.id, claimed.leaseToken!, {
      connectionId: "claude-code",
      credentialClass: "runtime-oauth",
      disclosureVersion: "claude-code-summary-v1",
      inputArtifact: transcript,
      runtimeEvidence,
      toolCalls: [],
    })).toThrow(/durable dispatch journal/i);
    store!.beginSummaryExecution(task.id, claimed.leaseToken!);
    expect(store!.validateSummaryCommit(task.id, claimed.leaseToken!, {
      connectionId: "claude-code",
      credentialClass: "runtime-oauth",
      disclosureVersion: "claude-code-summary-v1",
      inputArtifact: transcript,
      runtimeEvidence,
      toolCalls: [],
    })).toMatchObject({ id: task.id, state: "transcript_committed" });
    expect(() => store!.validateSummaryCommit(task.id, claimed.leaseToken!, {
      connectionId: "claude-code",
      credentialClass: "runtime-oauth",
      disclosureVersion: "claude-code-summary-v1",
      inputArtifact: transcript,
      runtimeEvidence: { ...runtimeEvidence, actualProvider: "thirdParty" },
      toolCalls: [],
    })).toThrow(/Runtime Evidence/i);
    expect(() => store!.validateSummaryCommit(task.id, claimed.leaseToken!, {
      connectionId: "claude-code",
      credentialClass: "runtime-oauth",
      disclosureVersion: "claude-code-summary-v1",
      inputArtifact: transcript,
      runtimeEvidence: { ...runtimeEvidence, requestedProvider: null, actualProvider: null },
      toolCalls: [],
    })).toThrow(/Runtime Evidence/i);
    expect(() => store!.validateSummaryCommit(task.id, claimed.leaseToken!, {
      connectionId: "claude-code",
      credentialClass: "runtime-oauth",
      disclosureVersion: "claude-code-summary-v1",
      inputArtifact: transcript,
      runtimeEvidence: { ...runtimeEvidence, fallbackOccurred: true },
      toolCalls: [],
    })).toThrow(/Runtime Evidence/i);
  });

  it("keeps Core Activation Evidence after task cleanup and Host restart", () => {
    createStore();
    const task = enqueue(false).task;
    store!.db.prepare("UPDATE agent_tasks SET state = 'completed', phase = 'completed' WHERE id = ?").run(task.id);

    expect(store!.recordCoreActivationEvidence(
      activationEvidence(task.id),
      CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS,
    )).toEqual(activationEvidence(task.id));
    expect(store!.recordCoreActivationEvidence({
      ...activationEvidence("later-task"),
      summaryProvider: "xai",
      summaryModel: "grok-later",
    }, CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS)).toEqual(activationEvidence(task.id));
    store!.purgeRecordingTasks(task.recordingStem);
    expect(store!.getCoreActivationEvidence()).toEqual(activationEvidence(task.id));

    const dbPath = join(root, "host.sqlite");
    store!.close();
    store = new HostStore(dbPath);
    expect(store.getCoreActivationEvidence()).toEqual(activationEvidence(task.id));
  });

  it("bounds historical Core Activation candidates by recency", () => {
    createStore();
    for (let index = 0; index < 5; index += 1) {
      store!.enqueueRecording({
        idempotencyKey: `recording:activation-candidate:${index}`,
        recordingStem: `Candidate_20260711_12000${index}`,
        title: `Candidate ${index}`,
        audioPath: join(root, `Candidate_20260711_12000${index}.wav`),
        sendToNotion: false,
        destinationHint: "",
        agentProvider: "hermes",
        ...SUMMARY_IDENTITY,
      });
    }

    expect(store!.listCoreActivationCandidates(2)).toHaveLength(2);
  });

  it("durably correlates an Activation Attempt to the production task identity", () => {
    createStore();
    const activationAttempt = store!.beginActivationAttempt().attempt;
    const task = enqueue(false).task;

    expect(store!.correlateActivationAttempt(activationAttempt.id, task.id)).toMatchObject({
      id: activationAttempt.id,
      taskId: task.id,
      recordingStem: task.recordingStem,
      startedAt: activationAttempt.startedAt,
    });

    const dbPath = join(root, "host.sqlite");
    store!.close();
    store = new HostStore(dbPath);
    expect(store.getActivationAttempt()).toMatchObject({
      id: activationAttempt.id,
      taskId: task.id,
      recordingStem: task.recordingStem,
    });
  });

  it("creates a new pinned summary attempt over the correlated committed transcript", () => {
    createStore();
    const activationAttempt = store!.beginActivationAttempt().attempt;
    const original = enqueue(false).task;
    store!.correlateActivationAttempt(activationAttempt.id, original.id);
    const claimed = store!.claim(original.id)!;
    store!.recordTranscript(claimed.id, claimed.leaseToken!, artifacts(claimed.id)[0]!);
    store!.releaseToAwaitingProvider(claimed.id, claimed.leaseToken!, "Hermes offline");

    const replacement = store!.replaceSummaryAttempt(original.id, {
      summaryProvider: "xai",
      summaryModel: "grok-pinned",
      summaryCredentialSource: "oauth",
    });

    expect(store!.getTask(original.id)).toMatchObject({
      state: "cancelled",
      summaryProvider: "hermes",
      summaryModel: "runtime-managed",
    });
    expect(replacement).toMatchObject({
      recordingStem: original.recordingStem,
      state: "transcript_committed",
      phase: "summarizing",
      trigger: "manual",
      agentProvider: "xai",
      summaryProvider: "xai",
      summaryModel: "grok-pinned",
    });
    expect(replacement.id).not.toBe(original.id);
    expect(store!.listArtifacts(original.id)).toEqual([
      expect.objectContaining({ kind: "transcript", provenance: { agent: "hermes" } }),
    ]);
    expect(store!.listArtifacts(replacement.id)).toEqual([
      expect.objectContaining({
        kind: "transcript",
        provenance: expect.objectContaining({ reusedFromTaskId: original.id }),
      }),
    ]);
    expect(store!.getActivationAttempt()).toMatchObject({ taskId: replacement.id });
    expect(store!.listEvents(original.id).at(-1)).toMatchObject({
      type: "task.superseded",
      payload: { replacementTaskId: replacement.id },
    });
  });

  it("creates an explicit same-provider Summary attempt from Unknown without mutating the original fence", () => {
    createStore();
    const original = store!.enqueueRecording({
      idempotencyKey: "recording:codex-unknown-explicit-attempt",
      recordingStem: "Demo_20260711_120000",
      title: "Codex Unknown",
      audioPath: join(root, "Demo_20260711_120000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "gpt-5.6-sol",
      summaryConnectionId: "codex",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "codex-summary-v1",
    }).task;
    const claimed = store!.claim(original.id)!;
    const transcript = artifacts(original.id)[0]!;
    store!.recordTranscript(original.id, claimed.leaseToken!, transcript);
    store!.recordSummaryInputSnapshot(original.id, claimed.leaseToken!, transcript);
    store!.beginSummaryExecution(original.id, claimed.leaseToken!);
    store!.markSummaryUnknownOutcome(original.id, claimed.leaseToken!);
    const originalAudit = (store!.db.prepare("SELECT audit_json FROM agent_tasks WHERE id = ?")
      .get(original.id) as { audit_json: string }).audit_json;

    const replacement = store!.replaceSummaryAttempt(original.id, {
      summaryProvider: original.summaryProvider,
      summaryModel: original.summaryModel,
      summaryConnectionId: original.summaryConnectionId,
      summaryCredentialClass: original.summaryCredentialClass,
      summaryDisclosureVersion: original.summaryDisclosureVersion,
    });

    expect(store!.getTask(original.id)).toMatchObject({ state: "execution_unverified" });
    expect((store!.db.prepare("SELECT audit_json FROM agent_tasks WHERE id = ?")
      .get(original.id) as { audit_json: string }).audit_json).toBe(originalAudit);
    expect(replacement).toMatchObject({
      state: "transcript_committed",
      summaryProvider: "codex",
      summaryModel: "gpt-5.6-sol",
      summaryConnectionId: "codex",
      summaryCredentialClass: "runtime-oauth",
    });
    expect(store!.listArtifacts(replacement.id)).toEqual([
      expect.objectContaining({
        kind: "transcript",
        sha256: transcript.sha256,
        provenance: expect.objectContaining({ reusedFromTaskId: original.id }),
      }),
    ]);
  });

  it("creates an explicit xAI replacement when only the credential source changes", () => {
    createStore();
    const original = store!.enqueueRecording({
      idempotencyKey: "recording:xai-credential-replacement",
      recordingStem: "Credential_20260711_120000",
      title: "Credential",
      audioPath: join(root, "Credential_20260711_120000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "xai",
      summaryProvider: "xai",
      summaryModel: "grok-pinned",
      summaryCredentialSource: "oauth",
    }).task;
    const claimed = store!.claim(original.id)!;
    const transcript = { ...artifacts(claimed.id)[0]!, taskId: claimed.id, recordingStem: claimed.recordingStem };
    store!.recordTranscript(claimed.id, claimed.leaseToken!, transcript);
    store!.releaseToAwaitingProvider(claimed.id, claimed.leaseToken!, "OAuth unavailable");

    const replacement = store!.replaceSummaryAttempt(original.id, {
      summaryProvider: "xai",
      summaryModel: "grok-pinned",
      summaryCredentialSource: "api-key",
    });

    expect(replacement).toMatchObject({
      state: "transcript_committed",
      summaryProvider: "xai",
      summaryModel: "grok-pinned",
      summaryCredentialSource: "api-key",
    });
    expect(store!.listArtifacts(replacement.id)).toEqual([
      expect.objectContaining({
        kind: "transcript",
        provenance: expect.objectContaining({ reusedFromTaskId: original.id }),
      }),
    ]);
  });

  it("pins the replacement Agent provenance when moving from xAI to a Supported Agent", () => {
    createStore();
    const original = store!.enqueueRecording({
      idempotencyKey: "recording:xai-to-agent-replacement",
      recordingStem: "Meeting_20260710_103000",
      title: "Meeting",
      audioPath: "/tmp/Meeting_20260710_103000.wav",
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "xai",
      summaryProvider: "xai",
      summaryModel: "grok-old",
      summaryCredentialSource: "oauth",
    }).task;
    const claimed = store!.claim(original.id)!;
    store!.recordTranscript(claimed.id, claimed.leaseToken!, artifacts(claimed.id)[0]!);
    store!.fail(claimed.id, claimed.leaseToken, "xAI summary failed");

    const replacement = store!.replaceSummaryAttempt(original.id, {
      summaryProvider: "codex",
      summaryModel: "runtime-managed",
    });

    expect(replacement).toMatchObject({
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "runtime-managed",
    });
    expect(store!.getTask(original.id)).toMatchObject({
      agentProvider: "xai",
      summaryProvider: "xai",
      summaryModel: "grok-old",
    });
  });

  it("preserves committed-transcript progress across policy pause and resume", () => {
    createStore();
    const task = enqueue(false).task;
    const claimed = store!.claim(task.id)!;
    store!.recordTranscript(claimed.id, claimed.leaseToken!, artifacts(claimed.id)[0]!);
    store!.releaseToAwaitingProvider(claimed.id, claimed.leaseToken!, "provider offline");
    store!.retry(task.id);

    expect(store!.pauseDispatchableForPolicy("pipeline disabled")).toEqual([
      expect.objectContaining({ id: task.id, state: "awaiting_policy" }),
    ]);
    expect(store!.resumePolicyPaused()).toEqual([
      expect.objectContaining({ id: task.id, state: "transcript_committed", phase: "summarizing" }),
    ]);
    expect(store!.listArtifacts(task.id)).toEqual([
      expect.objectContaining({ kind: "transcript" }),
    ]);
  });

  it("recovers legacy Activation Attempt correlation only from work created after it began", () => {
    createStore();
    const oldTask = enqueue(false).task;
    store!.db.prepare("UPDATE agent_tasks SET created_at = ? WHERE id = ?")
      .run("2026-01-01T00:00:00.000Z", oldTask.id);
    const attempt = store!.beginActivationAttempt().attempt;
    store!.markActivationAttemptStopping(attempt.id);
    store!.recordActivationAttemptStopped(attempt.id, "Activation_20260825_141500");
    const newTask = store!.enqueueRecording({
      idempotencyKey: "recording:activation:after-start",
      recordingStem: "Activation_20260825_141500",
      title: "Activation",
      audioPath: join(root, "Activation_20260825_141500.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "hermes",
      ...SUMMARY_IDENTITY,
    }).task;

    expect(store!.recoverActivationAttemptTask(attempt.id)).toMatchObject({
      taskId: newTask.id,
      recordingStem: newTask.recordingStem,
    });
  });

  it("leaves legacy Activation Attempt correlation unresolved when post-start work is ambiguous", () => {
    createStore();
    const attempt = store!.beginActivationAttempt().attempt;
    store!.markActivationAttemptStopping(attempt.id);
    store!.recordActivationAttemptStopped(attempt.id, "Activation_20260825_141500");
    const first = store!.enqueueRecording({
      idempotencyKey: "recording:activation:first",
      recordingStem: "Activation_20260825_141500",
      title: "Activation",
      audioPath: join(root, "Activation_20260825_141500.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "hermes",
      ...SUMMARY_IDENTITY,
    }).task;
    store!.db.prepare("UPDATE agent_tasks SET state = 'failed' WHERE id = ?").run(first.id);
    store!.enqueueRecording({
      idempotencyKey: "recording:activation:second",
      recordingStem: "Activation_20260825_141500",
      title: "Activation",
      audioPath: join(root, "Activation_20260825_141500.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "hermes",
      trigger: "manual",
      ...SUMMARY_IDENTITY,
    });

    expect(store!.recoverActivationAttemptTask(attempt.id)).toMatchObject({
      taskId: null,
      recordingStem: "Activation_20260825_141500",
    });
  });

  it("never recovers a sole unrelated task after guided recording stops", () => {
    createStore();
    const attempt = store!.beginActivationAttempt().attempt;
    store!.markActivationAttemptStopping(attempt.id);
    store!.recordActivationAttemptStopped(attempt.id, "Guided_20260825_141500");
    const unrelated = store!.enqueueRecording({
      idempotencyKey: "recording:unrelated-after-stop",
      recordingStem: "Scheduled_20260825_141501",
      title: "Scheduled",
      audioPath: join(root, "Scheduled_20260825_141501.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "hermes",
      ...SUMMARY_IDENTITY,
    }).task;

    expect(store!.recoverActivationAttemptTask(attempt.id)).toMatchObject({
      taskId: null,
      recordingStem: "Guided_20260825_141500",
    });
    expect(store!.getTask(unrelated.id)).not.toBeNull();
  });

  it("persists only the accepted cloud transcription disclosure version", () => {
    createStore();

    expect(store!.getCloudTranscriptionConsent()).toBeNull();
    expect(store!.recordCloudTranscriptionConsent("xai-audio-v1")).toEqual({
      disclosureVersion: "xai-audio-v1",
      acceptedAt: expect.any(String),
    });

    const dbPath = join(root, "host.sqlite");
    store!.close();
    store = new HostStore(dbPath);
    expect(store.getCloudTranscriptionConsent()).toEqual({
      disclosureVersion: "xai-audio-v1",
      acceptedAt: expect.any(String),
    });
    const columns = store.db.prepare("PRAGMA table_info(cloud_transcription_consent)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(["id", "disclosure_version", "accepted_at"]);
  });

  it("persists summary Data Path Disclosure separately by provider", () => {
    createStore();

    expect(store!.getSummaryDataPathDisclosure("xai")).toBeNull();
    expect(store!.recordSummaryDataPathDisclosure("xai", "xai-summary-v1")).toEqual({
      provider: "xai",
      disclosureVersion: "xai-summary-v1",
      decision: "accepted",
      decidedAt: expect.any(String),
    });
    expect(store!.recordSummaryDataPathDisclosure("codex", "codex-summary-v2")).toEqual({
      provider: "codex",
      disclosureVersion: "codex-summary-v2",
      decision: "accepted",
      decidedAt: expect.any(String),
    });
    expect(store!.declineSummaryDataPathDisclosure("xai", "xai-summary-v1")).toEqual({
      provider: "xai",
      disclosureVersion: "xai-summary-v1",
      decision: "declined",
      decidedAt: expect.any(String),
    });

    const dbPath = join(root, "host.sqlite");
    store!.close();
    store = new HostStore(dbPath);
    expect(store.getSummaryDataPathDisclosure("xai")).toMatchObject({
      provider: "xai",
      disclosureVersion: "xai-summary-v1",
      decision: "declined",
      decidedAt: expect.any(String),
    });
    expect(store.getSummaryDataPathDisclosure("codex")).toMatchObject({
      provider: "codex",
      disclosureVersion: "codex-summary-v2",
    });
  });

  it("deduplicates recording completion by idempotency key", () => {
    createStore();
    const first = enqueue();
    const second = enqueue();
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(store!.listTasks()).toHaveLength(1);
  });

  it("pins summary provider and model at enqueue and never rebinds them while claiming", () => {
    createStore();
    const queued = store!.enqueueRecording({
      idempotencyKey: "recording:pinned:1",
      recordingStem: "Pinned_20260711_120000",
      title: "Pinned",
      audioPath: join(root, "Pinned_20260711_120000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "xai",
      summaryModel: "grok-4.6-exact",
      summaryCredentialSource: "oauth",
    }).task;

    expect(queued).toMatchObject({ summaryProvider: "xai", summaryModel: "grok-4.6-exact" });
    expect(store!.listEvents(queued.id)[0]).toMatchObject({
      type: "task.queued",
      payload: { summaryProvider: "xai", summaryModel: "grok-4.6-exact" },
    });

    const claimed = store!.claimNext()!;
    expect(claimed).toMatchObject({ summaryProvider: "xai", summaryModel: "grok-4.6-exact" });
    expect(store!.listEvents(queued.id).at(-1)).toMatchObject({
      type: "task.claimed",
      payload: { summaryProvider: "xai", summaryModel: "grok-4.6-exact" },
    });
  });

  it("migrates legacy task rows to non-null provider-backed summary identity", () => {
    root = mkdtempSync(join(tmpdir(), "yulu-host-store-legacy-"));
    const dbPath = join(root, "host.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE agent_tasks (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        recording_stem TEXT NOT NULL,
        title TEXT NOT NULL,
        audio_path TEXT NOT NULL,
        transcription_language TEXT NOT NULL DEFAULT 'zh',
        trigger TEXT NOT NULL DEFAULT 'automatic',
        state TEXT NOT NULL,
        phase TEXT NOT NULL,
        send_to_notion INTEGER NOT NULL DEFAULT 0,
        destination_hint TEXT NOT NULL DEFAULT '',
        agent_provider TEXT NOT NULL DEFAULT 'hermes',
        instructions TEXT NOT NULL DEFAULT '',
        native_session_id TEXT,
        artifact_session_id TEXT,
        delivery_session_id TEXT,
        lease_token TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        audit_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy.prepare(`
      INSERT INTO agent_tasks (
        id, idempotency_key, recording_stem, title, audio_path, state, phase,
        agent_provider, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', 'queued', ?, ?, ?)
    `).run(
      "legacy-task", "legacy-key", "Legacy_20260711_120000", "Legacy",
      join(root, "Legacy_20260711_120000.wav"), "codex", new Date().toISOString(), new Date().toISOString(),
    );
    legacy.close();

    store = new HostStore(dbPath);
    expect(store.getTask("legacy-task")).toMatchObject({
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "runtime-managed",
      summaryConnectionId: null,
      summaryCredentialClass: null,
      summaryDisclosureVersion: null,
      summaryInputArtifactId: null,
      summaryInputArtifactSha256: null,
      summaryInputArtifactBytes: null,
    });
    const columns = store.db.prepare("PRAGMA table_info(agent_tasks)").all() as Array<{ name: string; notnull: number }>;
    expect(columns.find((column) => column.name === "summary_provider")?.notnull).toBe(1);
    expect(columns.find((column) => column.name === "summary_model")?.notnull).toBe(1);
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "summary_connection_id",
      "summary_credential_class",
      "summary_disclosure_version",
      "summary_input_artifact_id",
      "summary_input_artifact_sha256",
      "summary_input_artifact_bytes",
    ]));
  });

  it("refuses retry when the recording already has another active task", () => {
    createStore();
    const historical = enqueue(false).task;
    store!.db.prepare("UPDATE agent_tasks SET state = 'failed', phase = 'failed' WHERE id = ?")
      .run(historical.id);
    const active = store!.enqueueRecording({
      idempotencyKey: "manual:active-replacement",
      recordingStem: historical.recordingStem,
      title: "Active replacement",
      audioPath: historical.audioPath,
      sendToNotion: false,
      destinationHint: "Yulu Meeting",
      agentProvider: "hermes",
      ...SUMMARY_IDENTITY,
      trigger: "manual",
    }).task;

    expect(() => store!.retry(historical.id)).toThrow(`already has active Agent task ${active.id}`);
    expect(store!.listTasks().filter((task) => [
      "queued", "awaiting_agent", "awaiting_policy", "running",
      "artifacts_committed", "sending", "delivery_reported", "delivery_unverified",
    ].includes(task.state))).toHaveLength(1);
  });

  it("admits only one active task per recording across HostStore connections", () => {
    const firstStore = createStore();
    const dbPath = join(root, "host.sqlite");
    const first = enqueue().task;
    const secondStore = new HostStore(dbPath);
    try {
      const second = secondStore.enqueueRecording({
        idempotencyKey: "manual:other-writer",
        recordingStem: first.recordingStem,
        title: "Manual Demo",
        audioPath: first.audioPath,
        sendToNotion: false,
        destinationHint: "Yulu Meeting",
        agentProvider: "hermes",
        ...SUMMARY_IDENTITY,
        trigger: "manual",
      });
      expect(second).toMatchObject({ created: false, task: { id: first.id } });
      expect(firstStore.listTasks()).toHaveLength(1);
    } finally {
      secondStore.close();
    }
  });

  it("restricts the Host database directory and SQLite files", () => {
    root = mkdtempSync(join(tmpdir(), "yulu-host-store-permissions-"));
    chmodSync(root, 0o777);
    const dbPath = join(root, "host.sqlite");
    writeFileSync(dbPath, "", { mode: 0o666 });
    chmodSync(dbPath, 0o666);
    store = new HostStore(dbPath);

    expect(statSync(root).mode & 0o777).toBe(0o700);
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(path)) expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("retires imported legacy work without touching current durable tasks", () => {
    createStore();
    const legacy = store!.enqueueRecording({
      idempotencyKey: "legacy-agent-queue:old-task",
      recordingStem: "Legacy_20260711_010101",
      title: "Legacy",
      audioPath: join(root, "Legacy_20260711_010101.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "hermes",
      ...SUMMARY_IDENTITY,
    }).task;
    const current = enqueue(false).task;

    expect(store!.retireLegacyImportedTasks()).toEqual([legacy.id]);
    expect(store!.getTask(legacy.id)?.state).toBe("cancelled");
    expect(store!.getTask(current.id)?.state).toBe("queued");
    expect(store!.listEvents(legacy.id).at(-1)?.type).toBe("legacy.task_retired");
  });

  it("retires legacy manual tasks as cancelled unless delivery may have started", () => {
    createStore();
    const reason = "Retired legacy combined manual task after atomic meeting actions migration";
    const states = [
      "queued", "awaiting_agent", "awaiting_policy", "running",
      "artifacts_committed", "sending", "delivery_reported",
    ] as const;
    const ids = new Map<string, string>();
    for (const [index, state] of states.entries()) {
      const task = store!.enqueueRecording({
        idempotencyKey: `manual:legacy:${state}`,
        recordingStem: `Legacy${index}_20260711_01010${index}`,
        title: `Legacy ${state}`,
        audioPath: join(root, `Legacy${index}.wav`),
        sendToNotion: state === "sending" || state === "delivery_reported",
        destinationHint: "Yulu Meeting",
        agentProvider: "hermes",
        ...SUMMARY_IDENTITY,
        trigger: "manual",
      }).task;
      store!.db.prepare("UPDATE agent_tasks SET state = ? WHERE id = ?").run(state, task.id);
      ids.set(state, task.id);
    }
    const previouslyMisclassified = store!.enqueueRecording({
      idempotencyKey: "manual:legacy:previously-failed",
      recordingStem: "LegacyFailed_20260711_020000",
      title: "Legacy failed",
      audioPath: join(root, "LegacyFailed.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "hermes",
      ...SUMMARY_IDENTITY,
      trigger: "manual",
    }).task;
    store!.db.prepare("UPDATE agent_tasks SET state = 'failed', phase = 'failed', error = ? WHERE id = ?")
      .run(reason, previouslyMisclassified.id);

    const retired = store!.retireLegacyManualTasks();

    expect(new Set(retired)).toEqual(new Set([...ids.values(), previouslyMisclassified.id]));
    for (const [state, id] of ids) {
      expect(store!.getTask(id)?.state).toBe(["sending", "delivery_reported"].includes(state) ? "delivery_unverified" : "cancelled");
    }
    expect(store!.getTask(previouslyMisclassified.id)?.state).toBe("cancelled");
  });

  it("retires only unstarted legacy automatic delivery intent and preserves started delivery audit fences", () => {
    createStore();
    const legacyTask = (suffix: string) => store!.enqueueRecording({
      idempotencyKey: `recording:legacy-auto-share:${suffix}`,
      recordingStem: `Legacy_${suffix}_20260711_120000`,
      title: `Legacy ${suffix}`,
      audioPath: join(root, `Legacy_${suffix}_20260711_120000.wav`),
      sendToNotion: true,
      destinationHint: "Yulu Meeting",
      agentProvider: "hermes",
      ...SUMMARY_IDENTITY,
    }).task;
    const unstarted = legacyTask("unstarted");
    const started = legacyTask("started");
    const completed = legacyTask("completed");
    const unknown = legacyTask("unknown");
    const summaryUnknown = legacyTask("summary-unknown");
    const timestamp = "2026-07-11T12:10:00.000Z";
    for (const [task, state, status] of [
      [started, "sending", "sending"],
      [completed, "completed", "reported"],
      [unknown, "delivery_unverified", "sending"],
    ] as const) {
      store!.db.prepare("UPDATE agent_tasks SET state = ?, phase = ? WHERE id = ?")
        .run(state, state === "completed" ? "completed" : state === "sending" ? "sending_notion" : "failed", task.id);
      store!.db.prepare(`
        INSERT INTO notion_deliveries (
          task_id, delivery_key, status, destination, url, created_at, updated_at
        ) VALUES (?, ?, ?, 'Yulu Meeting', ?, ?, ?)
      `).run(
        task.id,
        `yulu-${task.id}`,
        status,
        status === "reported" ? `https://notion.so/${NOTION_PAGE_ID}` : null,
        timestamp,
        timestamp,
      );
    }
    store!.db.prepare("UPDATE agent_tasks SET state = 'execution_unverified', phase = 'failed' WHERE id = ?")
      .run(summaryUnknown.id);
    const dbPath = join(root, "host.sqlite");
    store!.close();
    store = new HostStore(dbPath);

    expect(store.getTask(unstarted.id)).toMatchObject({ state: "queued", sendToNotion: false });
    expect(store.listEvents(unstarted.id).at(-1)).toMatchObject({
      type: "legacy.automatic_delivery_intent_retired",
      payload: { previousState: "queued", automaticRetryPrevented: true },
    });
    expect(store.getNotionDelivery(unstarted.id)).toBeNull();

    expect(store.getTask(started.id)).toMatchObject({ state: "delivery_unverified", sendToNotion: true });
    expect(store.getTask(completed.id)).toMatchObject({ state: "completed", sendToNotion: true });
    expect(store.getTask(unknown.id)).toMatchObject({ state: "delivery_unverified", sendToNotion: true });
    expect(store.getNotionDelivery(started.id)?.status).toBe("sending");
    expect(store.getNotionDelivery(completed.id)?.status).toBe("reported");
    expect(store.getNotionDelivery(unknown.id)?.status).toBe("sending");
    expect(store.getTask(summaryUnknown.id)).toMatchObject({
      state: "execution_unverified",
      sendToNotion: false,
    });

    expect(store.claimNext()?.id).toBe(unstarted.id);
    expect(store.claimNext()).toBeNull();

    store.close();
    store = new HostStore(dbPath);
    expect(store.listEvents(unstarted.id).filter(({ type }) => (
      type === "legacy.automatic_delivery_intent_retired"
    ))).toHaveLength(1);
    expect(store.listEvents(summaryUnknown.id).filter(({ type }) => (
      type === "legacy.automatic_delivery_intent_retired"
    ))).toHaveLength(1);
  });

  it("cannot reuse a completed legacy delivery authorization after retry", () => {
    createStore();
    const task = enqueue(true).task;
    const timestamp = "2026-07-11T12:10:00.000Z";
    store!.db.prepare("UPDATE agent_tasks SET state = 'completed', phase = 'completed' WHERE id = ?")
      .run(task.id);
    store!.db.prepare(`
      INSERT INTO notion_deliveries (
        task_id, delivery_key, status, destination, url, created_at, updated_at
      ) VALUES (?, ?, 'reported', 'Yulu Meeting', ?, ?, ?)
    `).run(task.id, `yulu-${task.id}`, `https://notion.so/${NOTION_PAGE_ID}`, timestamp, timestamp);

    expect(store!.retry(task.id, { allowCompleted: true })).toMatchObject({
      state: "queued",
      sendToNotion: false,
    });
    const claimed = store!.claim(task.id)!;
    recordPublishedArtifacts(claimed.id, claimed.leaseToken!);

    expect(() => store!.beginNotionDelivery(claimed.id, claimed.leaseToken!)).toThrow(/retired/);
    expect(store!.complete(claimed.id, claimed.leaseToken!, {}).state).toBe("completed");
    expect(store!.getNotionDelivery(task.id)?.status).toBe("reported");
  });

  it("cancels only policy-paused automatic work before a manual action", () => {
    createStore();
    const automatic = enqueue(false).task;
    store!.pauseDispatchableForPolicy("Automatic processing disabled", "automatic");

    expect(store!.cancelPolicyPausedAutomaticForManualAction(automatic.recordingStem)).toEqual([automatic.id]);
    expect(store!.getTask(automatic.id)).toMatchObject({
      state: "cancelled",
      error: "Superseded by an explicit manual meeting action",
    });
    expect(store!.listEvents(automatic.id).at(-1)?.type).toBe("task.cancelled");
  });

  it("persists unavailable checks and resets the retry budget on explicit retry", () => {
    createStore();
    const task = enqueue(false).task;

    expect(store!.markAwaitingAgent(task.id, "offline").attempt).toBe(1);
    expect(store!.markAwaitingAgent(task.id, "still offline").attempt).toBe(2);
    store!.fail(task.id, null, "unavailable");
    expect(store!.retry(task.id).attempt).toBe(0);
  });

  it("durably pauses committed summary work until an explicit same-provider retry", () => {
    createStore();
    const queued = store!.enqueueRecording({
      idempotencyKey: "recording:provider-pause:1",
      recordingStem: "Paused_20260711_120000",
      title: "Paused",
      audioPath: join(root, "Paused_20260711_120000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "xai",
      summaryModel: "grok-4.6-exact",
      summaryCredentialSource: "oauth",
    }).task;
    const claimed = store!.claim(queued.id)!;
    store!.recordTranscript(claimed.id, claimed.leaseToken!, artifacts(claimed.id)[0]!);
    const reason = "provider unavailable ".repeat(100);
    const paused = store!.releaseToAwaitingProvider(claimed.id, claimed.leaseToken!, reason);

    expect(paused).toMatchObject({
      state: "awaiting_provider",
      phase: "summarizing",
      leaseToken: null,
      summaryProvider: "xai",
      summaryModel: "grok-4.6-exact",
    });
    expect(paused.error).toHaveLength(1000);
    expect(store!.listArtifacts(claimed.id)).toEqual([
      expect.objectContaining({ kind: "transcript", sha256: "a".repeat(64) }),
    ]);
    expect(store!.hasDispatchableTask()).toBe(false);
    expect(store!.claimNext()).toBeNull();
    expect(store!.listEvents(claimed.id).at(-1)).toMatchObject({
      type: "task.awaiting_provider",
      payload: {
        summaryProvider: "xai",
        summaryModel: "grok-4.6-exact",
        reason: paused.error,
      },
    });

    const dbPath = join(root, "host.sqlite");
    store!.close();
    store = new HostStore(dbPath);
    expect(store.getTask(claimed.id)?.state).toBe("awaiting_provider");

    const retried = store.retry(claimed.id);
    expect(retried).toMatchObject({
      state: "transcript_committed",
      phase: "summarizing",
      summaryProvider: "xai",
      summaryModel: "grok-4.6-exact",
    });
    expect(store.claimNext()).toMatchObject({
      summaryProvider: "xai",
      summaryModel: "grok-4.6-exact",
    });
  });

  it("requires the current lease and completes after committing artifacts", () => {
    createStore();
    const queued = enqueue().task;
    const claimed = store!.claimNext()!;
    expect(claimed.id).toBe(queued.id);
    expect(claimed.leaseToken).toBeTruthy();
    expect(() => store!.recordArtifacts(claimed.id, "stale", artifacts(claimed.id))).toThrow(/stale lease/);

    const committed = recordPublishedArtifacts(claimed.id, claimed.leaseToken!);
    expect(committed.state).toBe("artifacts_committed");
    const completed = store!.complete(claimed.id, claimed.leaseToken!, { verifiedTools: true });
    expect(completed.state).toBe("completed");
    expect(completed.leaseToken).toBeNull();
    expect(store!.listEvents(claimed.id).map((event) => event.type)).toEqual([
      "task.queued",
      "task.claimed",
      "artifacts.committed",
      "artifacts.published",
      "task.completed",
    ]);
  });

  it("records separate phase sessions and backfills only the audited artifact session", () => {
    createStore();
    const claimed = (() => { enqueue(true); return store!.claimNext()!; })();
    recordPublishedArtifacts(claimed.id, claimed.leaseToken!);
    store!.recordPhaseSession(claimed.id, claimed.leaseToken!, "artifact", "artifact-session");
    seedStartedNotionDelivery(claimed);
    store!.recordPhaseSession(claimed.id, claimed.leaseToken!, "delivery", "delivery-session");

    expect(store!.getTask(claimed.id)).toMatchObject({
      artifactSessionId: "artifact-session",
      deliverySessionId: "delivery-session",
      nativeSessionId: "delivery-session",
    });
    expect(store!.listArtifacts(claimed.id).every((record) => (
      record.provenance.artifactSessionId === "artifact-session" &&
      record.provenance.nativeSessionId === "artifact-session"
    ))).toBe(true);
  });

  it("never starts Notion when the task did not authorize it", () => {
    createStore();
    const claimed = (() => { enqueue(false); return store!.claimNext()!; })();
    recordPublishedArtifacts(claimed.id, claimed.leaseToken!);
    expect(() => store!.beginNotionDelivery(claimed.id, claimed.leaseToken!)).toThrow(/retired/);
    expect(store!.complete(claimed.id, claimed.leaseToken!, {}).state).toBe("completed");
  });

  it("never starts a new Notion delivery from a saved legacy authorization", () => {
    createStore();
    const claimed = (() => { enqueue(true); return store!.claimNext()!; })();
    recordPublishedArtifacts(claimed.id, claimed.leaseToken!);

    expect(() => store!.beginNotionDelivery(claimed.id, claimed.leaseToken!)).toThrow(/retired/);
    expect(store!.getNotionDelivery(claimed.id)).toBeNull();
    expect(store!.complete(claimed.id, claimed.leaseToken!, {}).state).toBe("completed");
  });

  it("does not accept an unverifiable Notion delivery report", () => {
    createStore();
    const claimed = (() => { enqueue(true); return store!.claimNext()!; })();
    recordPublishedArtifacts(claimed.id, claimed.leaseToken!);
    seedStartedNotionDelivery(claimed);

    expect(() => store!.recordNotionDelivery(claimed.id, claimed.leaseToken!, {
    })).toThrow("page URL or page ID");
  });

  it("keeps the Host-authorized destination when the Agent reports delivery", () => {
    createStore();
    const claimed = (() => { enqueue(true); return store!.claimNext()!; })();
    recordPublishedArtifacts(claimed.id, claimed.leaseToken!);
    seedStartedNotionDelivery(claimed);

    const reported = store!.recordNotionDelivery(claimed.id, claimed.leaseToken!, {
      destination: "Agent-controlled destination",
      url: `https://app.notion.com/p/${NOTION_PAGE_ID}`,
      pageId: NOTION_PAGE_ID,
    } as Parameters<HostStore["recordNotionDelivery"]>[2] & { destination: string });

    expect(reported.destination).toBe("Yulu Meeting");
    expect(store!.getNotionDelivery(claimed.id)?.destination).toBe("Yulu Meeting");
  });

  it.each([
    { url: "javascript:alert(1)" },
    { url: "http://www.notion.so/page" },
    { url: "https://app.notion.com.evil.example/page" },
    { pageId: "page" },
  ])("rejects an untrusted Notion delivery identifier: %j", (identifier) => {
    createStore();
    const claimed = (() => { enqueue(true); return store!.claimNext()!; })();
    recordPublishedArtifacts(claimed.id, claimed.leaseToken!);
    seedStartedNotionDelivery(claimed);

    expect(() => store!.recordNotionDelivery(claimed.id, claimed.leaseToken!, {
      ...identifier,
    })).toThrow(/Notion delivery (URL|page ID)/);
    expect(store!.getTask(claimed.id)?.state).toBe("sending");
  });

  it("rejects conflicting Notion URL and page ID identities", () => {
    createStore();
    const claimed = (() => { enqueue(true); return store!.claimNext()!; })();
    recordPublishedArtifacts(claimed.id, claimed.leaseToken!);
    seedStartedNotionDelivery(claimed);

    expect(() => store!.recordNotionDelivery(claimed.id, claimed.leaseToken!, {
      url: `https://app.notion.com/p/${NOTION_PAGE_ID}`,
      pageId: "fedcba9876543210fedcba9876543210",
    })).toThrow("must identify the same page");
    expect(store!.getTask(claimed.id)?.state).toBe("sending");
  });

  it("cancels queued work before deletion and purges its durable rows", () => {
    createStore();
    const task = enqueue(false).task;

    expect(store!.prepareRecordingDeletion(task.recordingStem)).toEqual([task.id]);
    expect(store!.getTask(task.id)?.state).toBe("cancelled");
    expect(store!.purgeRecordingTasks(task.recordingStem)).toEqual([task.id]);
    expect(store!.getTask(task.id)).toBeNull();
    expect(store!.listEvents(task.id)).toEqual([]);
  });

  it("pauses dispatchable tasks for policy and resumes them only explicitly", () => {
    createStore();
    const task = enqueue(false).task;
    const manual = store!.enqueueRecording({
      idempotencyKey: "manual:policy-test",
      recordingStem: "Manual_20260711_120000",
      title: "Manual",
      audioPath: join(root, "Manual_20260711_120000.wav"),
      sendToNotion: false,
      destinationHint: "Yulu Meeting",
      agentProvider: "hermes",
      ...SUMMARY_IDENTITY,
      trigger: "manual",
    }).task;

    expect(store!.pauseDispatchableForPolicy("Automatic processing disabled", "automatic")).toHaveLength(1);
    expect(store!.getTask(task.id)).toMatchObject({
      state: "awaiting_policy",
      error: "Automatic processing disabled",
    });
    expect(store!.claimNext()?.id).toBe(manual.id);

    expect(store!.resumePolicyPaused("automatic")).toHaveLength(1);
    expect(store!.getTask(task.id)?.state).toBe("queued");
    expect(store!.claimNext()?.id).toBe(task.id);
  });

  it("blocks recording deletion while an Agent task owns the audio", () => {
    createStore();
    const task = enqueue(false).task;
    store!.claim(task.id);

    expect(() => store!.prepareRecordingDeletion(task.recordingStem)).toThrow(/cannot be deleted.*running/);
    expect(() => store!.purgeRecordingTasks(task.recordingStem)).toThrow(/cannot be deleted.*running/);
    expect(store!.getTask(task.id)?.state).toBe("running");
  });

  it("keeps a committed transcript and resumes summary work after Host restart", () => {
    createStore();
    const claimed = (() => { enqueue(false); return store!.claimNext()!; })();
    store!.recordTranscript(claimed.id, claimed.leaseToken!, artifacts(claimed.id)[0]!);
    const dbPath = join(root, "host.sqlite");

    store!.close();
    store = new HostStore(dbPath);

    expect(store.getTask(claimed.id)).toMatchObject({
      state: "transcript_committed",
      phase: "summarizing",
      leaseToken: null,
      error: "Host restarted after transcript commit",
    });
    expect(store.listArtifacts(claimed.id)).toEqual([
      expect.objectContaining({ kind: "transcript", sha256: "a".repeat(64) }),
    ]);
    expect(store.claimNext()).toMatchObject({
      id: claimed.id,
      state: "transcript_committed",
      phase: "summarizing",
    });
  });

  it("moves an interrupted external delivery to delivery_unverified on restart", () => {
    createStore();
    const claimed = (() => { enqueue(true); return store!.claimNext()!; })();
    recordPublishedArtifacts(claimed.id, claimed.leaseToken!);
    store!.recordPhaseSession(claimed.id, claimed.leaseToken!, "artifact", "old-artifact-session");
    seedStartedNotionDelivery(claimed);
    store!.recordPhaseSession(claimed.id, claimed.leaseToken!, "delivery", "old-delivery-session");
    const dbPath = join(root, "host.sqlite");
    store!.close();
    store = new HostStore(dbPath);
    expect(store.getTask(claimed.id)?.state).toBe("delivery_unverified");
    expect(store.getTask(claimed.id)).toMatchObject({
      nativeSessionId: null,
      artifactSessionId: null,
      deliverySessionId: null,
    });
    const deliveryKey = store.getNotionDelivery(claimed.id)?.deliveryKey;
    const recovered = store;
    expect(() => recovered.retry(claimed.id)).toThrow(/cannot retry from delivery_unverified/);
    expect(store.abandonNotionDelivery(claimed.id).state).toBe("cancelled");
    expect(store.getNotionDelivery(claimed.id)?.status).toBe("abandoned");
    expect(store.getNotionDelivery(claimed.id)?.deliveryKey).toBe(deliveryKey);
    expect(store.prepareRecordingDeletion(claimed.recordingStem)).toEqual([claimed.id]);
    expect(store.purgeRecordingTasks(claimed.recordingStem)).toEqual([claimed.id]);
  });

  it("requires reconciliation when restart interrupts post-delivery session audit", () => {
    createStore();
    const claimed = (() => { enqueue(true); return store!.claimNext()!; })();
    recordPublishedArtifacts(claimed.id, claimed.leaseToken!);
    seedStartedNotionDelivery(claimed);
    store!.recordNotionDelivery(claimed.id, claimed.leaseToken!, {
      url: "https://notion.so/page",
    });
    const dbPath = join(root, "host.sqlite");
    store!.close();
    store = new HostStore(dbPath);

    expect(store.getTask(claimed.id)?.state).toBe("delivery_unverified");
    expect(store.getTask(claimed.id)?.leaseToken).toBeNull();
    expect(store.getNotionDelivery(claimed.id)?.url).toBe("https://notion.so/page");
    expect(store.listEvents(claimed.id).at(-1)?.type).toBe("notion.delivery_unverified");
    const recovered = store;
    expect(() => recovered.retry(claimed.id)).toThrow(/cannot retry from delivery_unverified/);
    expect(store.confirmNotionDelivery(claimed.id).state).toBe("completed");
    expect(store.listEvents(claimed.id).at(-1)?.type).toBe("notion.delivery_reconciled");
    expect(store.getNotionDelivery(claimed.id)?.deliveryKey).toBe(`yulu-${claimed.id}`);
  });

  it("rejects conflicting identities during manual delivery reconciliation", () => {
    createStore();
    const claimed = (() => { enqueue(true); return store!.claimNext()!; })();
    recordPublishedArtifacts(claimed.id, claimed.leaseToken!);
    seedStartedNotionDelivery(claimed);
    store!.fail(claimed.id, claimed.leaseToken!, "delivery outcome unknown");

    expect(() => store!.confirmNotionDelivery(claimed.id, {
      url: `https://app.notion.com/p/${NOTION_PAGE_ID}`,
      pageId: "fedcba9876543210fedcba9876543210",
    })).toThrow("must identify the same page");
    expect(store!.getTask(claimed.id)?.state).toBe("delivery_unverified");
  });

  it("migrates the pre-Codex Agent connection schema without losing existing records", () => {
    root = mkdtempSync(join(tmpdir(), "yulu-host-store-"));
    const dbPath = join(root, "host.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE agent_connections (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('direct-provider', 'legacy-custom')),
        adapter TEXT NOT NULL,
        label TEXT NOT NULL,
        lifecycle TEXT NOT NULL CHECK(lifecycle IN ('available', 'legacy')),
        settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO agent_connections
        (id, kind, adapter, label, lifecycle, settings_json, created_at, updated_at)
      VALUES
        ('direct-xai', 'direct-provider', 'direct-xai', 'xAI', 'available', '{}',
         '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z');
    `);
    legacy.close();

    store = new HostStore(dbPath);
    expect(store.listAgentConnectionRecords()).toEqual([
      expect.objectContaining({ id: "direct-xai", kind: "direct-provider", adapter: "direct-xai" }),
    ]);

    store.upsertAgentConnectionRecord({
      id: "codex",
      kind: "supported-agent",
      adapter: "codex",
      label: "Codex",
      lifecycle: "available",
      settings: { executablePath: "/fake/bin/codex", conversationModel: "gpt-5.6-sol" },
    });
    expect(store.listAgentConnectionRecords().find((record) => record.id === "codex")).toMatchObject({
      kind: "supported-agent",
      settings: { executablePath: "/fake/bin/codex", conversationModel: "gpt-5.6-sol" },
    });
  });

  it("retires unsupported gateway connection records during schema migration", () => {
    root = mkdtempSync(join(tmpdir(), "yulu-host-store-"));
    const dbPath = join(root, "host.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE agent_connections (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('direct-provider', 'supported-agent', 'gateway', 'legacy-custom')),
        adapter TEXT NOT NULL,
        label TEXT NOT NULL,
        lifecycle TEXT NOT NULL CHECK(lifecycle IN ('available', 'legacy')),
        settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO agent_connections
        (id, kind, adapter, label, lifecycle, settings_json, created_at, updated_at)
      VALUES
        ('direct-xai', 'direct-provider', 'direct-xai', 'xAI', 'available', '{}',
         '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z'),
        ('cliproxyapi', 'gateway', 'retired-adapter', 'Retired connection', 'available', '{}',
         '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z');
    `);
    legacy.close();

    store = new HostStore(dbPath);
    expect(store.listAgentConnectionRecords()).toEqual([
      expect.objectContaining({ id: "direct-xai", kind: "direct-provider" }),
    ]);
    const schema = store.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_connections'",
    ).get() as { sql: string };
    expect(schema.sql).not.toContain("'gateway'");

    const pinned = store.enqueueRecording({
      idempotencyKey: "recording:retired-gateway",
      recordingStem: "Retired_20260828_120000",
      title: "Retired connection task",
      audioPath: join(root, "Retired_20260828_120000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "cliproxyapi",
      summaryProvider: "cliproxyapi",
      summaryModel: "retired-model",
      summaryConnectionId: "cliproxyapi",
      summaryCredentialClass: "api-key",
      summaryDisclosureVersion: "retired-summary-v1",
    }).task;
    expect(store.retireTasksForConnection("cliproxyapi")).toEqual([pinned.id]);
    expect(store.retireTasksForConnection("cliproxyapi")).toEqual([]);
    expect(store.getTask(pinned.id)).toMatchObject({
      state: "cancelled",
      phase: "failed",
      leaseToken: null,
      error: expect.stringContaining("retired"),
    });
    expect(store.listEvents(pinned.id).at(-1)).toMatchObject({
      type: "agent_connection.task_retired",
      payload: { connectionId: "cliproxyapi", automaticReplayPrevented: true },
    });
  });
});
