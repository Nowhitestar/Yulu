import { initTRPC } from "@trpc/server";
import type { ConfigManager } from "./config.js";
import type { LaunchctlClient } from "./launchctl.js";
import type { PubSub, AppChannels } from "./pubsub.js";
import type { Database as DbType } from "better-sqlite3";
import type { paths as pathsType } from "./paths.js";

export interface AppContext {
  config: ConfigManager;
  launchctl: LaunchctlClient;
  pubsub: PubSub<AppChannels>;
  paths: typeof pathsType;
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

// Convenience for tests + unit calls
export function createCaller<R extends ReturnType<typeof router>>(r: R, ctx: AppContext) {
  return t.createCallerFactory(r)(ctx);
}
