import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider, Navigate, useParams, useSearchParams } from "react-router";
import { useState } from "react";
import { trpc, makeTrpcClient } from "./trpc.js";
import { ThemeConfigSync, ThemeProvider } from "./theme.js";
import { LanguageConfigSync, LanguageProvider } from "./i18n/LanguageProvider.js";
import { UndoToastProvider, useUndoToast } from "./components/UndoToast.js";
import { WsProvider } from "./ws.js";
import { RootLayout } from "./routes/root.js";
import { InboxLayout, handle as inboxLayoutHandle } from "./routes/inbox/_layout.js";
import { RecordingsList, handle as recordingsHandle } from "./routes/inbox/recordings.js";
import { RecordingReader, handle as recordingReaderHandle } from "./routes/inbox/recordings.$stem.js";
import { Prompts,    handle as promptsHandle    } from "./routes/knowledge/prompts.js";
import { PromptsIndex } from "./routes/knowledge/prompts.index.js";
import { PromptReaderRoute, handle as promptReaderHandle } from "./routes/knowledge/prompts.$id.js";
import { Glossary,   handle as glossaryHandle   } from "./routes/knowledge/glossary.js";
import { SettingsLayout, handle as settingsHandle } from "./routes/settings.js";
import { SettingsCategory } from "./routes/settings.$category.js";
import { categoryLabelKey } from "./components/settings/categories.js";
import { Health, handle as healthHandle } from "./routes/health.js";
import { AgentConsole, handle as agentConsoleHandle } from "./routes/agent-console.js";
import { VoiceInput, handle as voiceInputHandle } from "./routes/voice-input.js";

function RecordingRedirect() {
  const { stem } = useParams();
  const [sp] = useSearchParams();
  const qs = sp.toString();
  // Old voicemails were renamed voicemail_* → Memo_* by the unify migration, so
  // rewrite a legacy deep-link stem to its new name instead of 404ing the reader.
  const target = (stem ?? "").replace(/^voicemail_/, "Memo_");
  return <Navigate to={`/inbox/${target}${qs ? `?${qs}` : ""}`} replace />;
}

const router = createBrowserRouter([
  {
    path: "/",
    Component: RootLayout,
    children: [
      { index: true, element: <Navigate to="/agent-console" replace /> },
      { path: "agent-console", Component: AgentConsole, handle: agentConsoleHandle },
      { path: "voice-chat", Component: AgentConsole, handle: agentConsoleHandle },
      { path: "voice-input", Component: VoiceInput, handle: voiceInputHandle },
      {
        path: "inbox",
        Component: InboxLayout,
        handle: inboxLayoutHandle,
        children: [
          {
            Component: RecordingsList,
            handle: recordingsHandle,
            children: [
              { index: true, element: null },
              { path: ":stem", Component: RecordingReader, handle: recordingReaderHandle },
            ],
          },
        ],
      },
      { path: "inbox/voicemails",       element: <Navigate to="/inbox" replace /> },
      { path: "inbox/meetings",         element: <Navigate to="/inbox" replace /> },
      { path: "inbox/voicemails/:stem", element: <RecordingRedirect /> },
      { path: "inbox/meetings/:stem",   element: <RecordingRedirect /> },
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
      {
        path: "settings",
        Component: SettingsLayout,
        handle: settingsHandle,
        children: [
          { index: true, element: <Navigate to="/settings/general" replace /> },
          { path: "integrations", element: <Navigate to="/agent-console" replace /> },
          {
            path: ":category",
            Component: SettingsCategory,
            handle: { breadcrumb: (p: Record<string, string | undefined>) => categoryLabelKey(p.category ?? ""), filters: null },
          },
        ],
      },
      // Legacy deep-links: hotkey now lives under general, storage under audio.
      { path: "settings/hotkey",        element: <Navigate to="/settings/general" replace /> },
      { path: "settings/storage",       element: <Navigate to="/settings/audio"   replace /> },
      { path: "health",                 Component: Health,                handle: healthHandle },
      { path: "health/doctor",          element: <Navigate to="/health#doctor" replace /> },
      { path: "health/queue",           element: <Navigate to="/health#queue" replace /> },
      { path: "health/scheduler",       element: <Navigate to="/health#scheduler" replace /> },
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
    <trpc.Provider client={tc} queryClient={qc}>
      <QueryClientProvider client={qc}>
        <ThemeProvider>
          <ThemeConfigSync />
          <LanguageProvider>
            <UndoToastProvider>
              <LanguageConfigSyncWithToast />
              <WsProvider>
                <RouterProvider router={router} />
              </WsProvider>
            </UndoToastProvider>
          </LanguageProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

function LanguageConfigSyncWithToast() {
  const { showError } = useUndoToast();
  return <LanguageConfigSync onError={showError} />;
}
