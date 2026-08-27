import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import {
  agentSessionMessageInputSchema,
  archiveAgentSession,
  appendAgentSessionMessage,
  createAgentSession,
  deleteAgentSession,
  getAgentSession,
  listAgentSessions,
  pinAgentSession,
  renameAgentSession,
  summarizeAgentSession,
} from "../agentSessionStore.js";
import { resolveAgentRuntime } from "../agentRuntime.js";
import { hasCurrentXaiConversationDisclosure } from "../conversationDataDisclosure.js";
import {
  CLAUDE_CODE_CONVERSATION_DISCLOSURE_VERSION,
  CLIPROXYAPI_CONVERSATION_DISCLOSURE_VERSION,
  CODEX_CONVERSATION_DISCLOSURE_VERSION,
  hasCurrentAgentConversationDisclosure,
} from "../conversationDataDisclosure.js";

export const agentSessionsRouter = router({
  list: publicProcedure
    .input(z.object({ agent: z.string().optional() }).optional())
    .query(({ ctx, input }) => {
      return {
        sessions: listAgentSessions(ctx.paths.configDir, { agent: input?.agent, purpose: "ask" })
          .map((session) => summarizeAgentSession(session)),
      };
    }),

  get: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ ctx, input }) => {
      return getAgentSession(ctx.paths.configDir, input.id);
    }),

  create: publicProcedure
    .input(z.object({
      agent: z.string().min(1).optional(),
      title: z.string().max(48).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const config = ctx.config.read();
      const selection = config.intelligence.conversation;
      if (selection.provider === "xai") {
        if (!hasCurrentXaiConversationDisclosure(ctx.host)) {
          throw new Error("Accept the current xAI conversation data path disclosure in Agent Connection Center");
        }
        const connection = await ctx.xaiCredentials?.status();
        if (!connection?.connected || !connection.source) {
          throw new Error("Connect xAI before starting an xAI conversation");
        }
        return createAgentSession(ctx.paths.configDir, {
          provider: "xai",
          model: selection.model,
          credentialSource: connection.source,
          title: input.title,
          purpose: "ask",
        });
      }
      if (selection.provider === "agent" && "connectionId" in selection && selection.connectionId) {
        const connection = ctx.host.listAgentConnectionRecords().find((record) =>
          record.id === selection.connectionId &&
          ((record.kind === "supported-agent" &&
            (record.adapter === "codex" || record.adapter === "claude-code")) ||
            (record.kind === "gateway" && record.adapter === "cliproxyapi"))
        );
        if (!connection) {
          throw new Error(`Pinned Agent connection ${selection.connectionId} is unavailable in Agent Connection Center`);
        }
        const runtimeLabel = connection.adapter === "claude-code"
          ? "Claude Code"
          : connection.adapter === "cliproxyapi" ? "CLIProxyAPI" : "Codex";
        const disclosureVersion = connection.adapter === "claude-code"
          ? CLAUDE_CODE_CONVERSATION_DISCLOSURE_VERSION
          : connection.adapter === "cliproxyapi"
            ? CLIPROXYAPI_CONVERSATION_DISCLOSURE_VERSION
            : CODEX_CONVERSATION_DISCLOSURE_VERSION;
        const gatewayDisclosureIdentity = connection.settings.conversationDisclosureIdentity;
        const gatewayDisclosureMatches = connection.adapter !== "cliproxyapi" || (
          gatewayDisclosureIdentity !== null &&
          typeof gatewayDisclosureIdentity === "object" &&
          !Array.isArray(gatewayDisclosureIdentity) &&
          (gatewayDisclosureIdentity as Record<string, unknown>).endpoint === connection.settings.endpoint &&
          (gatewayDisclosureIdentity as Record<string, unknown>).credentialIdentity ===
            connection.settings.credentialIdentity
        );
        if (!hasCurrentAgentConversationDisclosure(
          ctx.host,
          connection.id,
          disclosureVersion,
        ) || !gatewayDisclosureMatches) {
          throw new Error(`Accept the current ${runtimeLabel} Conversation data path disclosure in Agent Connection Center`);
        }
        if (!ctx.agentConnections) {
          throw new Error(`Test this exact ${runtimeLabel} Conversation model before starting a new conversation`);
        }
        if (connection.adapter === "cliproxyapi") {
          await ctx.agentConnections.assertGatewayConversationReady({
            connectionId: connection.id,
            model: selection.model,
          });
        } else if (connection.adapter === "claude-code") {
          await ctx.agentConnections.assertClaudeConversationReady({
            connectionId: connection.id,
            model: selection.model,
          });
        } else {
          await ctx.agentConnections.assertCodexConversationReady({
            connectionId: connection.id,
            model: selection.model,
          });
        }
        return createAgentSession(ctx.paths.configDir, {
          provider: connection.adapter,
          connectionId: connection.id,
          model: selection.model,
          credentialSource: connection.adapter === "cliproxyapi" ? "api-key" : "runtime-oauth",
          ...(connection.adapter === "cliproxyapi"
            ? {
                endpointIdentity: String(connection.settings.endpoint ?? ""),
                disclosureVersion,
                credentialIdentity: String(connection.settings.credentialIdentity ?? ""),
              }
            : {}),
          title: input.title,
          purpose: "ask",
          runtimeLabel: runtimeLabel,
        });
      }
      const runtime = resolveAgentRuntime(config, {
        scriptDir: ctx.paths.scriptDir,
        moviesDir: ctx.paths.moviesDir,
      });
      return createAgentSession(ctx.paths.configDir, {
        provider: runtime.provider,
        model: "runtime-managed",
        title: input.title,
        purpose: "ask",
        runtimeLabel: runtime.label,
      });
    }),

  append: publicProcedure
    .input(z.object({
      sessionId: z.string().min(1),
      message: agentSessionMessageInputSchema,
    }))
    .mutation(({ ctx, input }) => {
      return appendAgentSessionMessage(ctx.paths.configDir, input.sessionId, input.message);
    }),

  rename: publicProcedure
    .input(z.object({
      id: z.string().min(1),
      title: z.string().trim().min(1).max(48),
    }))
    .mutation(({ ctx, input }) => {
      return renameAgentSession(ctx.paths.configDir, input.id, input.title);
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      return deleteAgentSession(ctx.paths.configDir, input.id);
    }),

  pin: publicProcedure
    .input(z.object({ id: z.string().min(1), pinned: z.boolean() }))
    .mutation(({ ctx, input }) => {
      return pinAgentSession(ctx.paths.configDir, input.id, input.pinned);
    }),

  archive: publicProcedure
    .input(z.object({ id: z.string().min(1), archived: z.boolean() }))
    .mutation(({ ctx, input }) => {
      return archiveAgentSession(ctx.paths.configDir, input.id, input.archived);
    }),
});
