import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { HostStore, type ArtifactRecord, type CoreActivationEvidence } from "../src/hostStore.js";

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

  function gatewaySummaryTask(idempotencyKey: string, sendToNotion = false) {
    const current = store ?? createStore();
    return current.enqueueRecording({
      idempotencyKey,
      recordingStem: "Demo_20260711_120000",
      title: "Gateway Summary",
      audioPath: join(root, "Demo_20260711_120000.wav"),
      sendToNotion,
      destinationHint: "",
      agentProvider: "cliproxyapi",
      summaryProvider: "cliproxyapi",
      summaryModel: "gateway-summary-exact",
      summaryConnectionId: "cliproxyapi",
      summaryCredentialClass: "api-key",
      summaryCredentialIdentity: "gateway.cliproxyapi.00000000-0000-4000-8000-000000000137",
      summaryDisclosureVersion: "cliproxyapi-summary-v1",
      summaryEndpointIdentity: "http://127.0.0.1:8317/v1",
      instructions: "Use only the committed transcript.",
    }).task;
  }

  function claimedGatewaySummary(idempotencyKey: string, sendToNotion = false) {
    const task = gatewaySummaryTask(idempotencyKey, sendToNotion);
    const claimed = store!.claim(task.id)!;
    const transcript = artifacts(task.id)[0]!;
    store!.recordTranscript(task.id, claimed.leaseToken!, transcript);
    store!.recordSummaryInputSnapshot(task.id, claimed.leaseToken!, transcript);
    return { task, claimed, transcript };
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
    const unknown = store!.markClaudeSummaryUnknownOutcome(
      task.id,
      claimed.leaseToken!,
      "Claude Code Summary entered Unknown Outcome",
      "unknown-session-140",
      {
        adapter: "claude-code",
        transport: "claude-code-print-stream-json",
        runtimeVersion: "2.1.169",
        requestedProvider: null,
        requestedModel: "claude-sonnet-5",
        actualProvider: null,
        actualModel: "claude-sonnet-5",
        requestId: null,
        sessionId: "unknown-session-140",
        terminalStatus: "unknown",
        fallbackOccurred: false,
      },
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
    expect(() => store!.prepareRecordingDeletion(task.recordingStem)).toThrow("execution_unverified");
  });

  it.each([
    ["preflight" as const, "failed", "no transcript was sent"],
    ["summary" as const, "execution_unverified", "outcome is unknown"],
  ])("does not replay an interrupted Gateway %s invocation after Host restart", (stage, state, error) => {
    createStore();
    const { task, claimed } = claimedGatewaySummary(`recording:gateway-crash-${stage}`);
    if (stage === "summary") {
      store!.beginGatewaySummaryExecution(task.id, claimed.leaseToken!, "preflight");
    }
    const executionId = store!.beginGatewaySummaryExecution(task.id, claimed.leaseToken!, stage);
    const dbPath = join(root, "host.sqlite");

    store!.close();
    store = new HostStore(dbPath);

    expect(store.getTask(task.id)).toMatchObject({
      state,
      phase: "failed",
      leaseToken: null,
      ...(stage === "summary"
        ? { nativeSessionId: executionId, artifactSessionId: executionId }
        : { nativeSessionId: null, artifactSessionId: null }),
      error: expect.stringContaining(error),
    });
    expect(store.claimNext()).toBeNull();
    expect(store.listEvents(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: stage === "summary"
          ? "gateway.summary_unknown_outcome"
          : "gateway.summary_preflight_interrupted",
        payload: expect.objectContaining({ executionId, stage, recoveredAfterRestart: true }),
      }),
    ]));
    if (stage === "summary") {
      expect(() => store!.retry(task.id)).toThrow("cannot retry from execution_unverified");
    } else {
      expect(store.retry(task.id)).toMatchObject({ state: "transcript_committed", leaseToken: null });
    }
  });

  it("fails closed on malformed Gateway Unknown Outcome evidence and keeps the fence after restart", () => {
    createStore();
    const { task, claimed } = claimedGatewaySummary("recording:gateway-malformed-unknown");
    store!.beginGatewaySummaryExecution(task.id, claimed.leaseToken!, "summary");

    expect(() => store!.markGatewaySummaryUnknownOutcome(
      task.id,
      claimed.leaseToken!,
      "attacker-controlled-error-secret",
      "\ninvalid-execution-secret",
      {
        adapter: "attacker-provider",
        transport: "attacker-transport",
        runtimeVersion: "attacker-runtime-secret",
        endpoint: "https://attacker.example/secret",
        requestedProvider: "attacker",
        requestedModel: "different-model",
        actualProvider: "attacker",
        actualModel: "different-model",
        requestId: "attacker-request-secret",
        sessionId: "attacker-session-secret",
        terminalStatus: "unknown",
        fallbackOccurred: true,
        toolsEnabled: true,
      },
    )).not.toThrow();

    const fenced = store!.getTask(task.id)!;
    expect(fenced).toMatchObject({
      state: "execution_unverified",
      phase: "failed",
      leaseToken: null,
      error: "CLIProxyAPI Gateway Summary entered Unknown Outcome; do not retry this execution",
    });
    const serializedEvents = JSON.stringify(store!.listEvents(task.id));
    expect(serializedEvents).not.toContain("attacker");
    expect(serializedEvents).not.toContain("secret");
    expect(store!.listEvents(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "gateway.summary_unknown_outcome",
        payload: expect.objectContaining({
          evidenceValidated: false,
          runtimeEvidence: expect.objectContaining({
            adapter: "cliproxyapi",
            endpoint: "http://127.0.0.1:8317/v1",
            requestedModel: "gateway-summary-exact",
            actualModel: null,
            requestId: null,
            sessionId: null,
            terminalStatus: "unknown",
            fallbackOccurred: false,
            toolsEnabled: false,
          }),
        }),
      }),
    ]));

    const dbPath = join(root, "host.sqlite");
    store!.close();
    store = new HostStore(dbPath);
    expect(store.getTask(task.id)).toMatchObject({ state: "execution_unverified", leaseToken: null });
    expect(store.claimNext()).toBeNull();
    expect(() => store!.retry(task.id)).toThrow("cannot retry from execution_unverified");
  });

  it.each([
    [false, "completed"],
    [true, "artifacts_committed"],
  ])("recovers a durably committed Gateway Summary without replay when sendToNotion=%s", (sendToNotion, state) => {
    createStore();
    const { task, claimed } = claimedGatewaySummary(
      `recording:gateway-artifacts-committed:${sendToNotion}`,
      sendToNotion,
    );
    store!.beginGatewaySummaryExecution(task.id, claimed.leaseToken!, "summary");
    store!.recordArtifacts(task.id, claimed.leaseToken!, artifacts(task.id));
    const dbPath = join(root, "host.sqlite");

    store!.close();
    store = new HostStore(dbPath);

    expect(store.getTask(task.id)).toMatchObject({
      state,
      leaseToken: null,
      error: null,
    });
    expect(store.listEvents(task.id).filter(({ type }) => type === "gateway.summary_unknown_outcome"))
      .toEqual([]);
    if (sendToNotion) {
      expect(store.claimNext()).toMatchObject({ id: task.id, state: "artifacts_committed" });
    } else {
      expect(store.claimNext()).toBeNull();
    }
  });

  it.each([
    ["wrong terminal", { terminalStatus: "ready" as const }],
    ["wrong model", { actualModel: "claude-fallback" }],
    ["wrong provider", { actualProvider: "anthropic" }],
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
    const evidence = {
      adapter: "claude-code",
      transport: "claude-code-print-stream-json",
      runtimeVersion: "2.1.169",
      requestedProvider: null,
      requestedModel: "claude-sonnet-5",
      actualProvider: null,
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

  it("authorizes a Claude Code Summary commit only from exact observable null-provider Runtime Evidence", () => {
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
      requestedProvider: null,
      requestedModel: "claude-sonnet-5",
      actualProvider: null,
      actualModel: "claude-sonnet-5",
      requestId: "request-summary-140",
      sessionId: "019f0000-0000-7000-8000-000000000140",
      terminalStatus: "ready" as const,
      fallbackOccurred: false,
    };

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
      runtimeEvidence: { ...runtimeEvidence, actualProvider: "anthropic" },
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

    expect(store!.recordCoreActivationEvidence(activationEvidence(task.id))).toEqual(activationEvidence(task.id));
    expect(store!.recordCoreActivationEvidence({
      ...activationEvidence("later-task"),
      summaryProvider: "xai",
      summaryModel: "grok-later",
    })).toEqual(activationEvidence(task.id));
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

  it("requires the current lease and commits artifacts before Notion", () => {
    createStore();
    const queued = enqueue().task;
    const claimed = store!.claimNext()!;
    expect(claimed.id).toBe(queued.id);
    expect(claimed.leaseToken).toBeTruthy();
    expect(() => store!.recordArtifacts(claimed.id, "stale", artifacts(claimed.id))).toThrow(/stale lease/);

    const committed = store!.recordArtifacts(claimed.id, claimed.leaseToken!, artifacts(claimed.id));
    expect(committed.state).toBe("artifacts_committed");
    const delivery = store!.beginNotionDelivery(claimed.id, claimed.leaseToken!);
    expect(delivery.deliveryKey).toBe(`yulu-${claimed.id}`);
    expect(store!.getTask(claimed.id)?.state).toBe("sending");
    expect(store!.beginNotionDelivery(claimed.id, claimed.leaseToken!)).toEqual(delivery);

    store!.recordNotionDelivery(claimed.id, claimed.leaseToken!, {
      url: `https://notion.so/page-${NOTION_PAGE_ID}`,
      pageId: NOTION_PAGE_ID,
    });
    const completed = store!.complete(claimed.id, claimed.leaseToken!, { verifiedTools: true });
    expect(completed.state).toBe("completed");
    expect(completed.leaseToken).toBeNull();
    expect(store!.listEvents(claimed.id).map((event) => event.type)).toEqual([
      "task.queued",
      "task.claimed",
      "artifacts.committed",
      "notion.delivery_started",
      "notion.delivery_reported",
      "task.completed",
    ]);
  });

  it("records separate phase sessions and backfills only the audited artifact session", () => {
    createStore();
    const claimed = (() => { enqueue(true); return store!.claimNext()!; })();
    store!.recordArtifacts(claimed.id, claimed.leaseToken!, artifacts(claimed.id));
    store!.recordPhaseSession(claimed.id, claimed.leaseToken!, "artifact", "artifact-session");
    store!.beginNotionDelivery(claimed.id, claimed.leaseToken!);
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
    store!.recordArtifacts(claimed.id, claimed.leaseToken!, artifacts(claimed.id));
    expect(() => store!.beginNotionDelivery(claimed.id, claimed.leaseToken!)).toThrow(/not authorized/);
    expect(store!.complete(claimed.id, claimed.leaseToken!, {}).state).toBe("completed");
  });

  it("does not accept an unverifiable Notion delivery report", () => {
    createStore();
    const claimed = (() => { enqueue(true); return store!.claimNext()!; })();
    store!.recordArtifacts(claimed.id, claimed.leaseToken!, artifacts(claimed.id));
    store!.beginNotionDelivery(claimed.id, claimed.leaseToken!);

    expect(() => store!.recordNotionDelivery(claimed.id, claimed.leaseToken!, {
    })).toThrow("page URL or page ID");
  });

  it("keeps the Host-authorized destination when the Agent reports delivery", () => {
    createStore();
    const claimed = (() => { enqueue(true); return store!.claimNext()!; })();
    store!.recordArtifacts(claimed.id, claimed.leaseToken!, artifacts(claimed.id));
    store!.beginNotionDelivery(claimed.id, claimed.leaseToken!);

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
    store!.recordArtifacts(claimed.id, claimed.leaseToken!, artifacts(claimed.id));
    store!.beginNotionDelivery(claimed.id, claimed.leaseToken!);

    expect(() => store!.recordNotionDelivery(claimed.id, claimed.leaseToken!, {
      ...identifier,
    })).toThrow(/Notion delivery (URL|page ID)/);
    expect(store!.getTask(claimed.id)?.state).toBe("sending");
  });

  it("rejects conflicting Notion URL and page ID identities", () => {
    createStore();
    const claimed = (() => { enqueue(true); return store!.claimNext()!; })();
    store!.recordArtifacts(claimed.id, claimed.leaseToken!, artifacts(claimed.id));
    store!.beginNotionDelivery(claimed.id, claimed.leaseToken!);

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
    store!.recordArtifacts(claimed.id, claimed.leaseToken!, artifacts(claimed.id));
    store!.recordPhaseSession(claimed.id, claimed.leaseToken!, "artifact", "old-artifact-session");
    store!.beginNotionDelivery(claimed.id, claimed.leaseToken!);
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
    store!.recordArtifacts(claimed.id, claimed.leaseToken!, artifacts(claimed.id));
    store!.beginNotionDelivery(claimed.id, claimed.leaseToken!);
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
    store!.recordArtifacts(claimed.id, claimed.leaseToken!, artifacts(claimed.id));
    store!.beginNotionDelivery(claimed.id, claimed.leaseToken!);
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
    store.upsertAgentConnectionRecord({
      id: "cliproxyapi",
      kind: "gateway",
      adapter: "cliproxyapi",
      label: "CLIProxyAPI",
      lifecycle: "available",
      settings: {
        endpoint: "http://127.0.0.1:8317/v1",
        summaryModel: "gateway-summary-exact",
        conversationModel: "gateway-conversation-exact",
      },
    });
    expect(store.listAgentConnectionRecords().find((record) => record.id === "cliproxyapi")).toMatchObject({
      kind: "gateway",
      settings: { endpoint: "http://127.0.0.1:8317/v1" },
    });
  });
});
