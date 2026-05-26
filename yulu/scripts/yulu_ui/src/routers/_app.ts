import { router } from "../trpc.js";
import { voicemailsRouter } from "./voicemails.js";
import { meetingsRouter }   from "./meetings.js";
import { searchRouter }     from "./search.js";
import { configRouter }     from "./config.js";
import { promptsRouter }    from "./prompts.js";
import { glossaryRouter }   from "./glossary.js";
import { daemonsRouter }    from "./daemons.js";
import { logsRouter }       from "./logs.js";
import { recordingRouter }  from "./recording.js";
import { sidebarRouter }    from "./sidebar.js";
import { systemRouter }     from "./system.js";

export const appRouter = router({
  voicemails: voicemailsRouter,
  meetings:   meetingsRouter,
  search:     searchRouter,
  config:     configRouter,
  prompts:    promptsRouter,
  glossary:   glossaryRouter,
  daemons:    daemonsRouter,
  logs:       logsRouter,
  recording:  recordingRouter,
  sidebar:    sidebarRouter,
  system:     systemRouter,
});

export type AppRouter = typeof appRouter;
