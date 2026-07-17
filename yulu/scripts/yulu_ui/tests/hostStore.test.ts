import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore, type ArtifactRecord } from "../src/hostStore.js";

const NOTION_PAGE_ID = "0123456789abcdef0123456789abcdef";

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

  it("deduplicates recording completion by idempotency key", () => {
    createStore();
    const first = enqueue();
    const second = enqueue();
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(store!.listTasks()).toHaveLength(1);
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

  it("requires the current lease and commits artifacts before Notion", () => {
    createStore();
    const queued = enqueue().task;
    const claimed = store!.claimNext("hermes")!;
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
    const claimed = (() => { enqueue(true); return store!.claimNext("hermes")!; })();
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
    const claimed = (() => { enqueue(false); return store!.claimNext("hermes")!; })();
    store!.recordArtifacts(claimed.id, claimed.leaseToken!, artifacts(claimed.id));
    expect(() => store!.beginNotionDelivery(claimed.id, claimed.leaseToken!)).toThrow(/not authorized/);
    expect(store!.complete(claimed.id, claimed.leaseToken!, {}).state).toBe("completed");
  });

  it("does not accept an unverifiable Notion delivery report", () => {
    createStore();
    const claimed = (() => { enqueue(true); return store!.claimNext("hermes")!; })();
    store!.recordArtifacts(claimed.id, claimed.leaseToken!, artifacts(claimed.id));
    store!.beginNotionDelivery(claimed.id, claimed.leaseToken!);

    expect(() => store!.recordNotionDelivery(claimed.id, claimed.leaseToken!, {
    })).toThrow("page URL or page ID");
  });

  it("keeps the Host-authorized destination when the Agent reports delivery", () => {
    createStore();
    const claimed = (() => { enqueue(true); return store!.claimNext("hermes")!; })();
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
    const claimed = (() => { enqueue(true); return store!.claimNext("hermes")!; })();
    store!.recordArtifacts(claimed.id, claimed.leaseToken!, artifacts(claimed.id));
    store!.beginNotionDelivery(claimed.id, claimed.leaseToken!);

    expect(() => store!.recordNotionDelivery(claimed.id, claimed.leaseToken!, {
      ...identifier,
    })).toThrow(/Notion delivery (URL|page ID)/);
    expect(store!.getTask(claimed.id)?.state).toBe("sending");
  });

  it("rejects conflicting Notion URL and page ID identities", () => {
    createStore();
    const claimed = (() => { enqueue(true); return store!.claimNext("hermes")!; })();
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
      trigger: "manual",
    }).task;

    expect(store!.pauseDispatchableForPolicy("Automatic processing disabled", "automatic")).toHaveLength(1);
    expect(store!.getTask(task.id)).toMatchObject({
      state: "awaiting_policy",
      error: "Automatic processing disabled",
    });
    expect(store!.claimNext("hermes")?.id).toBe(manual.id);

    expect(store!.resumePolicyPaused("automatic")).toHaveLength(1);
    expect(store!.getTask(task.id)?.state).toBe("queued");
    expect(store!.claimNext("hermes")?.id).toBe(task.id);
  });

  it("blocks recording deletion while an Agent task owns the audio", () => {
    createStore();
    const task = enqueue(false).task;
    store!.claim(task.id, "hermes");

    expect(() => store!.prepareRecordingDeletion(task.recordingStem)).toThrow(/cannot be deleted.*running/);
    expect(() => store!.purgeRecordingTasks(task.recordingStem)).toThrow(/cannot be deleted.*running/);
    expect(store!.getTask(task.id)?.state).toBe("running");
  });

  it("keeps a committed transcript and resumes summary work after Host restart", () => {
    createStore();
    const claimed = (() => { enqueue(false); return store!.claimNext("hermes")!; })();
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
    expect(store.claimNext("hermes")).toMatchObject({
      id: claimed.id,
      state: "transcript_committed",
      phase: "summarizing",
    });
  });

  it("moves an interrupted external delivery to delivery_unverified on restart", () => {
    createStore();
    const claimed = (() => { enqueue(true); return store!.claimNext("hermes")!; })();
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
    const claimed = (() => { enqueue(true); return store!.claimNext("hermes")!; })();
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
    const claimed = (() => { enqueue(true); return store!.claimNext("hermes")!; })();
    store!.recordArtifacts(claimed.id, claimed.leaseToken!, artifacts(claimed.id));
    store!.beginNotionDelivery(claimed.id, claimed.leaseToken!);
    store!.fail(claimed.id, claimed.leaseToken!, "delivery outcome unknown");

    expect(() => store!.confirmNotionDelivery(claimed.id, {
      url: `https://app.notion.com/p/${NOTION_PAGE_ID}`,
      pageId: "fedcba9876543210fedcba9876543210",
    })).toThrow("must identify the same page");
    expect(store!.getTask(claimed.id)?.state).toBe("delivery_unverified");
  });
});
