import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider, Navigate } from "react-router";
import { useState } from "react";
import { trpc, makeTrpcClient } from "./trpc.js";
import { ThemeProvider } from "./theme.js";
import { WsProvider } from "./ws.js";
import { RootLayout } from "./routes/root.js";
import { InboxLayout, handle as inboxLayoutHandle } from "./routes/inbox/_layout.js";
import { Voicemails, handle as voicemailsHandle } from "./routes/inbox/voicemails.js";
import { VoicemailsIndex } from "./routes/inbox/voicemails.index.js";
import { VoicemailReader, handle as voicemailReaderHandle } from "./routes/inbox/voicemails.$stem.js";
import { Meetings,   handle as meetingsHandle   } from "./routes/inbox/meetings.js";
import { MeetingsIndex } from "./routes/inbox/meetings.index.js";
import { MeetingReader, handle as meetingReaderHandle } from "./routes/inbox/meetings.$stem.js";
import { Prompts,    handle as promptsHandle    } from "./routes/knowledge/prompts.js";
import { PromptsIndex } from "./routes/knowledge/prompts.index.js";
import { PromptReaderRoute, handle as promptReaderHandle } from "./routes/knowledge/prompts.$id.js";
import { Glossary,   handle as glossaryHandle   } from "./routes/knowledge/glossary.js";
import { Settings as SettingsPageRoute, handle as settingsHandle } from "./routes/settings.js";
import { Health, handle as healthHandle } from "./routes/health.js";

const router = createBrowserRouter([
  {
    path: "/",
    Component: RootLayout,
    children: [
      { index: true, element: <Navigate to="/inbox/voicemails" replace /> },
      {
        path: "inbox",
        Component: InboxLayout,
        handle: inboxLayoutHandle,
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
        ],
      },
      {
        path: "knowledge/prompts",
        Component: Prompts,
        handle: promptsHandle,
        children: [
          { index: true, Component: PromptsIndex },
          { path: ":id", Component: PromptReaderRoute, handle: promptReaderHandle },
        ],
      },
      { path: "knowledge/glossary",   Component: Glossary,             handle: glossaryHandle },
      { path: "settings",               Component: SettingsPageRoute,     handle: settingsHandle },
      { path: "settings/audio",         element: <Navigate to="/settings#audio"         replace /> },
      { path: "settings/transcription", element: <Navigate to="/settings#transcription" replace /> },
      { path: "settings/llm",           element: <Navigate to="/settings#llm"           replace /> },
      { path: "settings/hotkey",        element: <Navigate to="/settings#hotkey"        replace /> },
      { path: "settings/integrations",  element: <Navigate to="/settings#integrations"  replace /> },
      { path: "settings/storage",       element: <Navigate to="/settings#storage"       replace /> },
      { path: "health",                 Component: Health,                handle: healthHandle },
      { path: "health/daemons",         element: <Navigate to="/health#daemons" replace /> },
      { path: "health/logs",            element: <Navigate to="/health#logs"    replace /> },
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
