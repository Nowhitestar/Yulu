import { router } from "../trpc.js";
import { recordingsRouter } from "./recordings.js";
import { searchRouter }     from "./search.js";
import { configRouter }     from "./config.js";
import { capabilitiesRouter } from "./capabilities.js";
import { promptsRouter }    from "./prompts.js";
import { glossaryRouter }   from "./glossary.js";
import { daemonsRouter }    from "./daemons.js";
import { logsRouter }       from "./logs.js";
import { recordingRouter }  from "./recording.js";
import { systemRouter }     from "./system.js";
import { integrationsRouter } from "./integrations.js";
import { llmRouter }          from "./llm.js";
import { askRouter }          from "./ask.js";

export const appRouter = router({
  recordings:   recordingsRouter,
  search:       searchRouter,
  config:       configRouter,
  capabilities: capabilitiesRouter,
  prompts:      promptsRouter,
  glossary:     glossaryRouter,
  daemons:      daemonsRouter,
  logs:         logsRouter,
  recording:    recordingRouter,
  system:       systemRouter,
  integrations: integrationsRouter,
  llm:          llmRouter,
  ask:          askRouter,
});

export type AppRouter = typeof appRouter;
