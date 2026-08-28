import { describe, expect, it, vi } from "vitest";
import type { PersistedAgentConnection } from "../src/hostStore.js";
import {
  AgentSharingConnectorAdapter,
  SharingConnectorUnknownOutcomeError,
} from "../src/sharingConnector.js";
import { YULU_TEST_SHARE_CONTENT } from "../src/sharingConfiguration.js";
import { runAgentCliCommand } from "../src/agentCliRunner.js";

const connection: PersistedAgentConnection = {
  id: "codex",
  kind: "supported-agent",
  adapter: "codex",
  label: "Codex",
  lifecycle: "available",
  settings: { executablePath: "/opt/bin/codex" },
  createdAt: "2026-08-28T01:00:00.000Z",
  updatedAt: "2026-08-28T01:00:00.000Z",
};

function codexToolEvidence(input: {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}) {
  return JSON.stringify({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "notion",
      tool: input.name,
      arguments: input.arguments,
      result: input.result,
      status: "completed",
      error: null,
    },
  });
}

function claudeToolEvidence(input: {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}) {
  return [
    JSON.stringify({
      type: "assistant",
      message: { content: [{
        type: "tool_use", id: "tool-1", name: `mcp__notion__${input.name}`, input: input.arguments,
      }] },
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{
        type: "tool_result",
        tool_use_id: "tool-1",
        content: [{ type: "text", text: JSON.stringify(input.result) }],
        is_error: false,
      }] },
    }),
  ].join("\n");
}

describe("AgentSharingConnectorAdapter", () => {
  it("uses separate read-only discovery and bounded readiness invocations", async () => {
    const destination = JSON.stringify({ page_id: "parent-123" });
    const run = vi.fn()
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          options: [
            { label: "Product Notes", value: destination },
            { label: "Unverified title", value: "Product Notes" },
          ],
          detail: "found",
        }),
        stderr: "",
        rawStdout: codexToolEvidence({
          name: "notion_search",
          arguments: { query: "destinations" },
          result: { pages: [{ title: "Product Notes" }] },
        }),
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: '{"status":"ready","connector":"notion","detail":"read access verified"}',
        stderr: "",
        rawStdout: codexToolEvidence({
          name: "notion_search",
          arguments: { query: "Yulu connector readiness" },
          result: { pages: [] },
        }),
      });
    const adapter = new AgentSharingConnectorAdapter({
      scriptDir: "/app/scripts",
      configDir: "/config",
      run,
    });

    await expect(adapter.discover({ connection, connector: "notion" })).resolves.toEqual({
      options: [{ label: "Product Notes", value: destination }],
      detail: "found",
    });
    await expect(adapter.probe({ connection, connector: "notion" })).resolves.toEqual({
      detail: "read access verified",
    });

    expect(run.mock.calls[0]![0].prompt).toMatch(/read-only/i);
    expect(run.mock.calls[0]![0].prompt).toMatch(/do not write/i);
    expect(run.mock.calls[0]![0].connectorToolPolicy).toEqual({
      connector: "notion",
      allowedTools: ["notion_search", "notion_fetch", "search", "fetch"],
    });
    expect(run.mock.calls[1]![0].prompt).toMatch(/bounded/i);
    expect(run.mock.calls[1]![0].prompt).toMatch(/do not create, update, or delete/i);
    expect(run.mock.calls[1]![0].timeoutMs).toBeLessThanOrEqual(30_000);
  });

  it("sends only the fixed meeting-free Test Share and requires a matching receipt", async () => {
    const destination = JSON.stringify({ page_id: "parent-123" });
    const run = vi.fn()
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          status: "sent", connector: "notion", destination,
          id: "page-123", url: "https://notion.so/page-123",
        }),
        stderr: "",
        rawStdout: codexToolEvidence({
          name: "notion_create_pages",
          arguments: {
            parent: { page_id: "parent-123" },
            pages: [{ content: YULU_TEST_SHARE_CONTENT }],
          },
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({ pages: [{ id: "page-123", url: "https://notion.so/page-123" }] }),
            }],
          },
        }),
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          status: "verified",
          connector: "notion",
          destination,
          content: YULU_TEST_SHARE_CONTENT,
          id: "page-123",
          url: "https://notion.so/page-123",
        }),
        stderr: "",
        rawStdout: codexToolEvidence({
          name: "notion_fetch",
          arguments: { id: "page-123" },
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                parent: { type: "page_id", page_id: "parent-123" },
                content: YULU_TEST_SHARE_CONTENT,
                id: "page-123",
                url: "https://notion.so/page-123",
              }),
            }],
          },
        }),
      });
    const adapter = new AgentSharingConnectorAdapter({
      scriptDir: "/app/scripts",
      configDir: "/config",
      run,
    });

    const receipt = await adapter.testShare({
      connection,
      connector: "notion",
      destination,
      content: YULU_TEST_SHARE_CONTENT,
    });
    expect(receipt).toEqual({
      destination,
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    await expect(adapter.verifyReceipt({
      connection,
      connector: "notion",
      destination,
      content: YULU_TEST_SHARE_CONTENT,
      receipt,
    })).resolves.toEqual(receipt);
    const invocation = run.mock.calls[0]![0];
    expect(invocation.prompt).toContain(YULU_TEST_SHARE_CONTENT);
    expect(invocation.prompt).toContain("no meeting title, transcript, summary, participant, or meeting metadata");
    expect(invocation.connectorToolPolicy).toEqual({
      connector: "notion",
      allowedTools: ["notion_create_pages"],
      writeGuard: {
        destination,
        content: YULU_TEST_SHARE_CONTENT,
      },
    });
    expect(invocation.runtime.cwd).toBe("/app/scripts");
    expect(invocation.runtime.command).not.toContain("/movies");
    expect(invocation.nativeSessionId).toBeUndefined();
    expect(invocation.yuluSessionId).toEqual(expect.any(String));
    expect(run.mock.calls[1]![0].prompt).toMatch(/read back/i);
    expect(run.mock.calls[1]![0].prompt).toMatch(/Do not write/i);
    expect(run.mock.calls[1]![0].connectorToolPolicy).toEqual({
      connector: "notion",
      allowedTools: ["notion_search", "notion_fetch", "search", "fetch"],
    });
  });

  it("reports an unverifiable write as Unknown Outcome and rejects Conversation-only OpenClaw", async () => {
    const run = vi.fn(async (_input: Parameters<typeof runAgentCliCommand>[0]) => ({
      code: 1,
      stdout: "",
      stderr: "transport closed",
    }));
    const adapter = new AgentSharingConnectorAdapter({
      scriptDir: "/app/scripts",
      configDir: "/config",
      run,
    });

    await expect(adapter.testShare({
      connection,
      connector: "notion",
      destination: "Product Notes",
      content: YULU_TEST_SHARE_CONTENT,
    })).rejects.toBeInstanceOf(SharingConnectorUnknownOutcomeError);
    await expect(adapter.discover({
      connection: { ...connection, id: "openclaw", adapter: "openclaw", label: "OpenClaw" },
      connector: "notion",
    })).rejects.toThrow(/Conversation-only/);
  });

  it("reports proven pre-write hook rejection as an ordinary configuration failure", async () => {
    const details = [
      'Codex hooks are unavailable; update Codex until "codex features list" reports "hooks stable true"',
      "Sharing guard denied before any connector write was authorized",
    ];
    const run = vi.fn();
    const adapter = new AgentSharingConnectorAdapter({ scriptDir: "/app/scripts", configDir: "/config", run });

    for (const detail of details) {
      run.mockResolvedValueOnce({
        code: 1, stdout: "", stderr: detail, connectorWriteState: "not-started" as const,
      });
      try {
        await adapter.testShare({
          connection,
          connector: "notion",
          destination: JSON.stringify({ page_id: "parent-123" }),
          content: YULU_TEST_SHARE_CONTENT,
        });
        expect.fail("expected pre-write hook rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(SharingConnectorUnknownOutcomeError);
        expect(String(error)).toContain(detail);
      }
    }

    run.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: details[0],
      connectorWriteState: "unknown" as const,
    });
    await expect(adapter.testShare({
      connection,
      connector: "notion",
      destination: JSON.stringify({ page_id: "parent-123" }),
      content: YULU_TEST_SHARE_CONTENT,
    })).rejects.toBeInstanceOf(SharingConnectorUnknownOutcomeError);
  });

  it("rejects matching Agent JSON when no successful selected-connector tool call proves it", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({
        code: 0,
        stdout: '{"status":"ready","connector":"notion","detail":"trust me"}',
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: '{"status":"sent","connector":"notion","destination":"Product Notes","id":"page-fake","url":"https://notion.so/page-fake"}',
        stderr: "",
      });
    const adapter = new AgentSharingConnectorAdapter({
      scriptDir: "/app/scripts",
      configDir: "/config",
      run,
    });

    await expect(adapter.probe({ connection, connector: "notion" }))
      .rejects.toThrow(/tool-call evidence/i);
    await expect(adapter.testShare({
      connection,
      connector: "notion",
      destination: "Product Notes",
      content: YULU_TEST_SHARE_CONTENT,
    })).rejects.toBeInstanceOf(SharingConnectorUnknownOutcomeError);
  });

  it("audits Claude stream events and rejects runtimes without pre-tool authorization", async () => {
    const claudeRun = vi.fn(async (_input: Parameters<typeof runAgentCliCommand>[0]) => ({
      code: 0,
      stdout: '{"status":"ready","connector":"notion","detail":"read access verified"}',
      stderr: "",
      rawStdout: [
        JSON.stringify({
          type: "assistant",
          message: { content: [{
            type: "tool_use",
            id: "tool-1",
            name: "mcp__notion__notion_search",
            input: { query: "Yulu connector readiness" },
          }] },
        }),
        JSON.stringify({
          type: "user",
          message: { content: [{
            type: "tool_result",
            tool_use_id: "tool-1",
            content: '{"pages":[]}',
            is_error: false,
          }] },
        }),
      ].join("\n"),
    }));
    const claude = new AgentSharingConnectorAdapter({
      scriptDir: "/app/scripts",
      configDir: "/config",
      run: claudeRun,
    });
    await expect(claude.probe({
      connection: { ...connection, id: "claude", adapter: "claude-code", label: "Claude Code" },
      connector: "notion",
    })).resolves.toEqual({ detail: "read access verified" });
    expect(claudeRun.mock.calls[0]![0].runtime.command).toEqual(expect.arrayContaining([
      "--output-format",
      "stream-json",
      "--verbose",
    ]));

    const hermesRun = vi.fn();
    const hermes = new AgentSharingConnectorAdapter({
      scriptDir: "/app/scripts",
      configDir: "/config",
      run: hermesRun,
    });
    await expect(hermes.probe({
      connection: { ...connection, id: "hermes", adapter: "hermes", label: "Hermes" },
      connector: "notion",
    })).rejects.toThrow(/pre-tool authorization/i);
    expect(hermesRun).not.toHaveBeenCalled();
  });

  it("verifies Claude writes and read-back through standard text-block tool results", async () => {
    const destination = JSON.stringify({ page_id: "parent-123" });
    const receipt = { destination, receiptId: "page-123", receiptUrl: "https://notion.so/page-123" };
    const run = vi.fn()
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          status: "sent", connector: "notion", destination,
          id: receipt.receiptId, url: receipt.receiptUrl,
        }),
        stderr: "",
        rawStdout: claudeToolEvidence({
          name: "notion_create_pages",
          arguments: {
            parent: { page_id: "parent-123" },
            pages: [{ content: YULU_TEST_SHARE_CONTENT }],
          },
          result: { pages: [{ id: receipt.receiptId, url: receipt.receiptUrl }] },
        }),
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          status: "verified", connector: "notion", destination,
          content: YULU_TEST_SHARE_CONTENT, id: receipt.receiptId, url: receipt.receiptUrl,
        }),
        stderr: "",
        rawStdout: claudeToolEvidence({
          name: "notion_fetch",
          arguments: { id: receipt.receiptId },
          result: {
            parent: { type: "page_id", page_id: "parent-123" },
            content: YULU_TEST_SHARE_CONTENT,
            id: receipt.receiptId,
            url: receipt.receiptUrl,
          },
        }),
      });
    const adapter = new AgentSharingConnectorAdapter({ scriptDir: "/app/scripts", configDir: "/config", run });
    const claudeConnection = { ...connection, id: "claude", adapter: "claude-code" as const, label: "Claude Code" };

    await expect(adapter.testShare({
      connection: claudeConnection, connector: "notion", destination, content: YULU_TEST_SHARE_CONTENT,
    })).resolves.toEqual(receipt);
    await expect(adapter.verifyReceipt({
      connection: claudeConnection,
      connector: "notion",
      destination,
      content: YULU_TEST_SHARE_CONTENT,
      receipt,
    })).resolves.toEqual(receipt);
  });

  it("rejects a read phase that also invokes any selected-connector mutation", async () => {
    const run = vi.fn(async (_input: Parameters<typeof runAgentCliCommand>[0]) => ({
      code: 0,
      stdout: '{"status":"ready","connector":"notion","detail":"read access verified"}',
      stderr: "",
      rawStdout: [
        codexToolEvidence({
          name: "notion_search",
          arguments: { query: "Yulu connector readiness" },
          result: { pages: [] },
        }),
        codexToolEvidence({
          name: "notion_delete_page",
          arguments: { id: "page-other" },
          result: { status: "deleted" },
        }),
      ].join("\n"),
    }));
    const adapter = new AgentSharingConnectorAdapter({
      scriptDir: "/app/scripts",
      configDir: "/config",
      run,
    });

    await expect(adapter.probe({ connection, connector: "notion" }))
      .rejects.toThrow(/mutation tool-call/i);
  });

  it("rejects failed receipts, destination prefixes, and content with appended meeting data", async () => {
    const result = (writeResult: unknown, destination = "Product Notes", content = YULU_TEST_SHARE_CONTENT) => ({
      code: 0,
      stdout: '{"status":"sent","connector":"notion","destination":"Product Notes","id":"page-123","url":"https://notion.so/page-123"}',
      stderr: "",
      rawStdout: codexToolEvidence({
        name: "notion_create_pages",
        arguments: { destination, content },
        result: writeResult,
      }),
    });
    const attempts = [
      result({ status: "failed", id: "page-123", url: "https://notion.so/page-123" }),
      result({ status: "timeout", id: "page-123", url: "https://notion.so/page-123" }),
      result({ status: "partial", id: "page-123", url: "https://notion.so/page-123" }),
      result({ status: "failed: timeout", id: "page-123", url: "https://notion.so/page-123" }),
      result({ data: { status: "timeout" }, id: "page-123", url: "https://notion.so/page-123" }),
      result({ blocks: [{ outcome: "partial" }], id: "page-123", url: "https://notion.so/page-123" }),
      result({ id: "page-123", url: "https://notion.so/page-123", detail: "Operation timed out" }),
      result("failed"),
      result({ id: "page-123", url: "https://notion.so/page-123" }, "Product Notes Archive"),
      result(
        { id: "page-123", url: "https://notion.so/page-123" },
        "Product Notes",
        `${YULU_TEST_SHARE_CONTENT}\nMeeting transcript: secret`,
      ),
    ];
    const run = vi.fn();
    const adapter = new AgentSharingConnectorAdapter({
      scriptDir: "/app/scripts",
      configDir: "/config",
      run,
    });

    for (const attempt of attempts) {
      run.mockResolvedValueOnce(attempt);
      await expect(adapter.testShare({
        connection,
        connector: "notion",
        destination: "Product Notes",
        content: YULU_TEST_SHARE_CONTENT,
      })).rejects.toBeInstanceOf(SharingConnectorUnknownOutcomeError);
    }
  });

  it("accepts a numeric Zulip message id only when the exact receipt is read back", async () => {
    const zulipConnection = { ...connection, id: "codex-zulip" };
    const destination = JSON.stringify({ type: "stream", to: "engineering", topic: "yulu" });
    const run = vi.fn()
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          status: "sent", connector: "zulip", destination, id: 12345, url: "",
        }),
        stderr: "",
        rawStdout: JSON.stringify({
          type: "item.completed",
          item: {
            type: "mcp_tool_call", server: "zulip", tool: "send_message",
            arguments: { type: "stream", to: "engineering", topic: "yulu", content: YULU_TEST_SHARE_CONTENT },
            result: {
              content: [{ type: "text", text: JSON.stringify({ result: "success", id: 12345 }) }],
            },
            status: "completed", error: null,
          },
        }),
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          status: "verified", connector: "zulip", destination,
          content: YULU_TEST_SHARE_CONTENT, id: 12345, url: "",
        }),
        stderr: "",
        rawStdout: JSON.stringify({
          type: "item.completed",
          item: {
            type: "mcp_tool_call", server: "zulip", tool: "get_message",
            arguments: { message_id: 12345 },
            result: { content: [{ type: "text", text: JSON.stringify({
              id: 12345, type: "stream", to: "engineering", topic: "yulu",
              content: YULU_TEST_SHARE_CONTENT,
            }) }] },
            status: "completed", error: null,
          },
        }),
      });
    const adapter = new AgentSharingConnectorAdapter({ scriptDir: "/app/scripts", configDir: "/config", run });

    const receipt = await adapter.testShare({
      connection: zulipConnection,
      connector: "zulip",
      destination,
      content: YULU_TEST_SHARE_CONTENT,
    });
    expect(receipt.receiptId).toBe("12345");
    await expect(adapter.verifyReceipt({
      connection: zulipConnection,
      connector: "zulip",
      destination,
      content: YULU_TEST_SHARE_CONTENT,
      receipt,
    })).resolves.toEqual(receipt);
  });

  it("requires exact structured destination, content, and receipt evidence on read-back", async () => {
    const receipt = {
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    };
    const output = JSON.stringify({
      status: "verified",
      connector: "notion",
      destination: receipt.destination,
      content: YULU_TEST_SHARE_CONTENT,
      id: receipt.receiptId,
      url: receipt.receiptUrl,
    });
    const attempt = (result: unknown) => ({
      code: 0,
      stdout: output,
      stderr: "",
      rawStdout: codexToolEvidence({
        name: "notion_fetch",
        arguments: { id: receipt.receiptId },
        result,
      }),
    });
    const run = vi.fn();
    const adapter = new AgentSharingConnectorAdapter({
      scriptDir: "/app/scripts",
      configDir: "/config",
      run,
    });
    const invalidResults = [
      { status: "failed", ...receipt, content: YULU_TEST_SHARE_CONTENT },
      { ...receipt, destination: "Product Notes Archive", content: YULU_TEST_SHARE_CONTENT },
      { ...receipt, content: `${YULU_TEST_SHARE_CONTENT}\nMeeting transcript: secret` },
    ];

    for (const result of invalidResults) {
      run.mockResolvedValueOnce(attempt(result));
      await expect(adapter.verifyReceipt({
        connection,
        connector: "notion",
        destination: receipt.destination,
        content: YULU_TEST_SHARE_CONTENT,
        receipt,
      })).rejects.toBeInstanceOf(SharingConnectorUnknownOutcomeError);
    }
  });

  it("rejects decoy Notion destinations and multi-page writes in connector evidence", async () => {
    const destination = JSON.stringify({ page_id: "parent-123" });
    const output = JSON.stringify({
      status: "sent",
      connector: "notion",
      destination,
      id: "page-123",
      url: "https://notion.so/page-123",
    });
    const attempts = [
      {
        parent: { page_id: "wrong-parent" },
        metadata: { destination },
        pages: [{ content: YULU_TEST_SHARE_CONTENT }],
      },
      {
        parent: { page_id: "parent-123" },
        pages: [
          { content: YULU_TEST_SHARE_CONTENT },
          { content: YULU_TEST_SHARE_CONTENT },
        ],
      },
    ];
    const run = vi.fn();
    const adapter = new AgentSharingConnectorAdapter({ scriptDir: "/app/scripts", configDir: "/config", run });

    for (const args of attempts) {
      run.mockResolvedValueOnce({
        code: 0,
        stdout: output,
        stderr: "",
        rawStdout: codexToolEvidence({
          name: "notion_create_pages",
          arguments: args,
          result: { id: "page-123", url: "https://notion.so/page-123" },
        }),
      });
      await expect(adapter.testShare({
        connection,
        connector: "notion",
        destination,
        content: YULU_TEST_SHARE_CONTENT,
      })).rejects.toBeInstanceOf(SharingConnectorUnknownOutcomeError);
    }

    const receipt = { destination, receiptId: "page-123", receiptUrl: "https://notion.so/page-123" };
    run.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify({
        status: "verified",
        connector: "notion",
        destination,
        content: YULU_TEST_SHARE_CONTENT,
        id: receipt.receiptId,
        url: receipt.receiptUrl,
      }),
      stderr: "",
      rawStdout: codexToolEvidence({
        name: "notion_fetch",
        arguments: { id: receipt.receiptId },
        result: {
          parent: { page_id: "wrong-parent" },
          metadata: { destination },
          content: YULU_TEST_SHARE_CONTENT,
          id: receipt.receiptId,
          url: receipt.receiptUrl,
        },
      }),
    });
    await expect(adapter.verifyReceipt({
      connection,
      connector: "notion",
      destination,
      content: YULU_TEST_SHARE_CONTENT,
      receipt,
    })).rejects.toBeInstanceOf(SharingConnectorUnknownOutcomeError);
  });
});
