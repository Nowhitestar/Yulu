import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider, Navigate } from "react-router";
import { useState } from "react";
import { trpc, makeTrpcClient } from "./trpc.js";
import { ThemeProvider } from "./theme.js";
import { WsProvider } from "./ws.js";
import { RootLayout } from "./routes/root.js";
import { InboxLayout } from "./routes/inbox/_layout.js";
import { Voicemails, handle as voicemailsHandle } from "./routes/inbox/voicemails.js";
import { VoicemailsIndex } from "./routes/inbox/voicemails.index.js";
import { VoicemailReader, handle as voicemailReaderHandle } from "./routes/inbox/voicemails.$stem.js";
import { Meetings,   handle as meetingsHandle   } from "./routes/inbox/meetings.js";
import { MeetingsIndex } from "./routes/inbox/meetings.index.js";
import { MeetingReader, handle as meetingReaderHandle } from "./routes/inbox/meetings.$stem.js";
import { Search,     handle as searchHandle     } from "./routes/inbox/search.js";
import { Prompts,    handle as promptsHandle    } from "./routes/knowledge/prompts.js";
import { Glossary,   handle as glossaryHandle   } from "./routes/knowledge/glossary.js";
import { SettingsAudio,         handle as audioHandle         } from "./routes/settings/audio.js";
import { SettingsTranscription, handle as transcriptionHandle } from "./routes/settings/transcription.js";
import { SettingsLlm,           handle as llmHandle           } from "./routes/settings/llm.js";
import { SettingsHotkey,        handle as hotkeyHandle        } from "./routes/settings/hotkey.js";
import { SettingsIntegrations,  handle as integrationsHandle  } from "./routes/settings/integrations.js";
import { SettingsStorage,       handle as storageHandle       } from "./routes/settings/storage.js";
import { HealthDaemons, handle as daemonsHandle } from "./routes/health/daemons.js";
import { HealthLogs,    handle as logsHandle    } from "./routes/health/logs.js";

const router = createBrowserRouter([
  {
    path: "/",
    Component: RootLayout,
    children: [
      { index: true, element: <Navigate to="/inbox/voicemails" replace /> },
      {
        path: "inbox",
        Component: InboxLayout,
        children: [
          {
            path: "voicemails",
            Component: Voicemails,
            handle: voicemailsHandle,
            children: [
              { index: true, Component: VoicemailsIndex },
              { path: ":stem", Component: VoicemailReader, handle: voicemailReaderHandle },
            ],
          },
          {
            path: "meetings",
            Component: Meetings,
            handle: meetingsHandle,
            children: [
              { index: true, Component: MeetingsIndex },
              { path: ":stem", Component: MeetingReader, handle: meetingReaderHandle },
            ],
          },
          { path: "search", Component: Search, handle: searchHandle },
        ],
      },
      { path: "knowledge/prompts",    Component: Prompts,              handle: promptsHandle },
      { path: "knowledge/glossary",   Component: Glossary,             handle: glossaryHandle },
      { path: "settings/audio",         Component: SettingsAudio,         handle: audioHandle },
      { path: "settings/transcription", Component: SettingsTranscription, handle: transcriptionHandle },
      { path: "settings/llm",           Component: SettingsLlm,           handle: llmHandle },
      { path: "settings/hotkey",        Component: SettingsHotkey,        handle: hotkeyHandle },
      { path: "settings/integrations",  Component: SettingsIntegrations,  handle: integrationsHandle },
      { path: "settings/storage",       Component: SettingsStorage,       handle: storageHandle },
      { path: "health/daemons",         Component: HealthDaemons,         handle: daemonsHandle },
      { path: "health/logs",            Component: HealthLogs,            handle: logsHandle },
    ],
  },
]);

export function App() {
  const [qc] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
  }));
  const [tc] = useState(() => makeTrpcClient());

  return (
    <ThemeProvider>
      <trpc.Provider client={tc} queryClient={qc}>
        <QueryClientProvider client={qc}>
          <WsProvider>
            <RouterProvider router={router} />
          </WsProvider>
        </QueryClientProvider>
      </trpc.Provider>
    </ThemeProvider>
  );
}
