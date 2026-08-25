import { initTRPC } from "@trpc/server";
import type { ConfigManager } from "./config.js";
import type { LaunchctlClient } from "./launchctl.js";
import type { PubSub, AppChannels } from "./pubsub.js";
import type { Database as DbType } from "better-sqlite3";
import type { paths as pathsType } from "./paths.js";
import type { HostStore } from "./hostStore.js";
import type { ArtifactStore } from "./artifactStore.js";
import type { RecordingPipeline } from "./recordingPipeline.js";
import type { LocalCaptionManager } from "./localCaptionManager.js";
import type { AudioTranscriptionService } from "./audioTranscription.js";
import type { XaiCredentialManager } from "./xaiCredentials.js";
import type { XaiTextClient } from "./xaiText.js";
import type { XaiProviderReadiness } from "./routers/providers.js";
import type { SearchResponse } from "./routers/search.js";
import type { SupportedAgentSummaryAdapter } from "./summaryProviderReadiness.js";

export interface AppContext {
  config: ConfigManager;
  launchctl: LaunchctlClient;
  pubsub: PubSub<AppChannels>;
  paths: typeof pathsType;
  host: HostStore;
  artifacts: ArtifactStore;
  recordingPipeline: RecordingPipeline;
  localCaption?: LocalCaptionManager;
  audioTranscription?: AudioTranscriptionService;
  xaiCredentials?: XaiCredentialManager;
  xaiText?: XaiTextClient;
  xaiReadiness?: XaiProviderReadiness;
  supportedAgentSummaryAdapter?: SupportedAgentSummaryAdapter;
  localSearch?: (
    input: { query: string; since?: string; kinds?: ("meeting_summary" | "meeting_transcript")[]; limit?: number },
    scriptDir: string,
  ) => Promise<SearchResponse>;
  db: {
    prompts: DbType;
    vocab: DbType;
    search: DbType;
  };
}

const t = initTRPC.context<AppContext>().create();
export const router = t.router;
export const publicProcedure = t.procedure;
export const mergeRouters = t.mergeRouters;
export const createCallerFactory = t.createCallerFactory;

// Convenience for tests. Returns `any` so tests can call any procedure
// without dragging tRPC's deep generic types through every test file —
// tests assert specific shapes on the returned values themselves.
export function createCaller(r: unknown, ctx: AppContext): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (t.createCallerFactory as unknown as (r: unknown) => (ctx: AppContext) => unknown)(r)(ctx) as any;
}
