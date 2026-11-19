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
import { doctorRouter }       from "./doctor.js";
import { schedulerRouter }    from "./scheduler.js";
import { agentTasksRouter } from "./agentTasks.js";
import { localCaptionRouter } from "./localCaption.js";
import { xaiAudioRouter } from "./xaiAudio.js";
import { providersRouter } from "./providers.js";
import { activationRouter } from "./activation.js";
import { agentConnectionsRouter } from "./agentConnections.js";
import { sharingRouter } from "./sharing.js";
import { onboardingRouter } from "./onboarding.js";
import { dictationTextRouter } from "./dictationText.js";
import { captionTranslationRouter } from "./captionTranslation.js";
import { permissionsRouter } from "./permissions.js";
import { mcpAgentsRouter } from "./mcpAgents.js";

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
  doctor:       doctorRouter,
  scheduler:    schedulerRouter,
  agentTasks: agentTasksRouter,
  localCaption: localCaptionRouter,
  xaiAudio: xaiAudioRouter,
  providers: providersRouter,
  activation: activationRouter,
  agentConnections: agentConnectionsRouter,
  sharing: sharingRouter,
  onboarding: onboardingRouter,
  dictationText: dictationTextRouter,
  captionTranslation: captionTranslationRouter,
  permissions: permissionsRouter,
  mcpAgents: mcpAgentsRouter,
});

export type AppRouter = typeof appRouter;
