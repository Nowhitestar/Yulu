import { z } from "zod";
import { router, publicProcedure, uiMutationProcedure } from "../trpc.js";
import {
  agentSessionMessageInputSchema,
  archiveAgentSession,
  appendAgentSessionMessage,
  createAgentSession,
  createAgentSessionAttemptFromUnknown,
  deleteAgentSession,
  getAgentSession,
  listAgentSessions,
  pinAgentSession,
  renameAgentSession,
  summarizeAgentSession,
} from "../agentSessionStore.js";
import {
  CLAUDE_CODE_CONVERSATION_DISCLOSURE_VERSION,
  CODEX_CONVERSATION_DISCLOSURE_VERSION,
  HERMES_CONVERSATION_DISCLOSURE_VERSION,
  OPENCLAW_CONVERSATION_DISCLOSURE_VERSION,
  XAI_CONVERSATION_DISCLOSURE_VERSION,
  hasCurrentAgentConversationDisclosure,
  hasCurrentXaiConversationDisclosure,
} from "../conversationDataDisclosure.js";

export class ConversationConnectionRequiredError extends Error {
  override name = "ConversationConnectionRequiredError";
}

function conversationConnectionRequired(message: string): never {
  throw new ConversationConnectionRequiredError(message);
}

async function requireConversationReadiness<T>(check: () => Promise<T>): Promise<T> {
  try {
    return await check();
  } catch (error) {
    throw new ConversationConnectionRequiredError(
      error instanceof Error ? error.message : "The selected Conversation connection is not ready",
      { cause: error },
    );
  }
}

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

  create: uiMutationProcedure
    .input(z.object({
      agent: z.string().min(1).optional(),
      title: z.string().max(48).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const config = ctx.config.read();
      const selection = config.intelligence.conversation;
      if ("disabled" in selection && selection.disabled) {
        conversationConnectionRequired(
          "Conversation selection was cleared after its Agent connection was deleted; select and test a new connection",
        );
      }
      if (selection.provider === "xai") {
        if (!hasCurrentXaiConversationDisclosure(ctx.host)) {
          conversationConnectionRequired("Accept the current xAI conversation data path disclosure in Agent Connection Center");
        }
        if (!ctx.agentConnections) {
          conversationConnectionRequired("Test this exact xAI Conversation model before starting a new conversation");
        }
        const credentialSource = await requireConversationReadiness(() =>
          ctx.agentConnections!.assertXaiConversationReady({ model: selection.model }));
        return createAgentSession(ctx.paths.configDir, {
          provider: "xai",
          connectionId: "direct-xai",
          model: selection.model,
          credentialSource,
          disclosureVersion: XAI_CONVERSATION_DISCLOSURE_VERSION,
          title: input.title,
          purpose: "ask",
        });
      }
      if (selection.provider === "agent" && "connectionId" in selection && selection.connectionId) {
        const connection = ctx.host.listAgentConnectionRecords().find((record) =>
          record.id === selection.connectionId &&
          record.kind === "supported-agent" &&
          (record.adapter === "codex" || record.adapter === "claude-code" ||
            record.adapter === "hermes" || record.adapter === "openclaw")
        );
        if (!connection) {
          conversationConnectionRequired(
            `Pinned Agent connection ${selection.connectionId} is unavailable in Agent Connection Center`,
          );
        }
        const runtimeLabel = connection.adapter === "claude-code"
          ? "Claude Code"
          : connection.adapter === "hermes"
            ? "Hermes"
            : connection.adapter === "openclaw"
              ? "OpenClaw"
              : "Codex";
        const disclosureVersion = connection.adapter === "claude-code"
          ? CLAUDE_CODE_CONVERSATION_DISCLOSURE_VERSION
          : connection.adapter === "hermes"
            ? HERMES_CONVERSATION_DISCLOSURE_VERSION
            : connection.adapter === "openclaw"
              ? OPENCLAW_CONVERSATION_DISCLOSURE_VERSION
              : CODEX_CONVERSATION_DISCLOSURE_VERSION;
        if (!hasCurrentAgentConversationDisclosure(
          ctx.host,
          connection.id,
          disclosureVersion,
        )) {
          conversationConnectionRequired(
            `Accept the current ${runtimeLabel} Conversation data path disclosure in Agent Connection Center`,
          );
        }
        if (!ctx.agentConnections) {
          conversationConnectionRequired(
            `Test this exact ${runtimeLabel} Conversation model before starting a new conversation`,
          );
        }
        if (connection.adapter === "claude-code") {
          await requireConversationReadiness(() => ctx.agentConnections!.assertClaudeConversationReady({
              connectionId: connection.id,
              model: selection.model,
            }));
        } else if (connection.adapter === "hermes" || connection.adapter === "openclaw") {
          const runtimeProvider = await requireConversationReadiness(() =>
            ctx.agentConnections!.assertConversationOnlyReady({
              connectionId: connection.id,
              model: selection.model,
            }));
          if (!runtimeProvider) {
            conversationConnectionRequired(
              `Test this exact ${runtimeLabel} Conversation provider and model before starting a new conversation`,
            );
          }
          return createAgentSession(ctx.paths.configDir, {
            provider: connection.adapter,
            connectionId: connection.id,
            model: selection.model,
            runtimeProvider,
            disclosureVersion,
            credentialSource: "runtime-oauth",
            title: input.title,
            purpose: "ask",
            runtimeLabel,
          });
        } else {
          await requireConversationReadiness(() => ctx.agentConnections!.assertCodexConversationReady({
              connectionId: connection.id,
              model: selection.model,
            }));
        }
        return createAgentSession(ctx.paths.configDir, {
          provider: connection.adapter,
          connectionId: connection.id,
          model: selection.model,
          credentialSource: "runtime-oauth",
          disclosureVersion,
          title: input.title,
          purpose: "ask",
          runtimeLabel: runtimeLabel,
        });
      }
      conversationConnectionRequired(
        "Select, disclose, and test an explicit Conversation connection in /settings/llm?capability=conversation",
      );
    }),

  append: uiMutationProcedure
    .input(z.object({
      sessionId: z.string().min(1),
      message: agentSessionMessageInputSchema,
    }))
    .mutation(({ ctx, input }) => {
      return appendAgentSessionMessage(ctx.paths.configDir, input.sessionId, input.message);
    }),

  createAttemptFromUnknown: uiMutationProcedure
    .input(z.object({ id: z.string().min(1).max(200) }).strict())
    .mutation(({ ctx, input }) => {
      return createAgentSessionAttemptFromUnknown(ctx.paths.configDir, input.id);
    }),

  rename: uiMutationProcedure
    .input(z.object({
      id: z.string().min(1),
      title: z.string().trim().min(1).max(48),
    }))
    .mutation(({ ctx, input }) => {
      return renameAgentSession(ctx.paths.configDir, input.id, input.title);
    }),

  delete: uiMutationProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      return deleteAgentSession(ctx.paths.configDir, input.id);
    }),

  pin: uiMutationProcedure
    .input(z.object({ id: z.string().min(1), pinned: z.boolean() }))
    .mutation(({ ctx, input }) => {
      return pinAgentSession(ctx.paths.configDir, input.id, input.pinned);
    }),

  archive: uiMutationProcedure
    .input(z.object({ id: z.string().min(1), archived: z.boolean() }))
    .mutation(({ ctx, input }) => {
      return archiveAgentSession(ctx.paths.configDir, input.id, input.archived);
    }),
});
