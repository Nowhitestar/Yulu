import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider, Navigate, useParams, useSearchParams, type RouteObject } from "react-router";
import { useState } from "react";
import { trpc, makeTrpcClient } from "./trpc.js";
import { ThemeConfigSync, ThemeProvider } from "./theme.js";
import { LanguageConfigSync, LanguageProvider, useT } from "./i18n/LanguageProvider.js";
import { UndoToastProvider, useUndoToast } from "./components/UndoToast.js";
import { WsProvider } from "./ws.js";
import { RootLayout } from "./routes/root.js";
import { InboxIndex } from "./routes/inbox/recordings.js";
import { RecordingReader } from "./routes/inbox/recordings.$stem.js";
import { Prompts } from "./routes/knowledge/prompts.js";
import { PromptsIndex } from "./routes/knowledge/prompts.index.js";
import { PromptReaderRoute } from "./routes/knowledge/prompts.$id.js";
import { Glossary } from "./routes/knowledge/glossary.js";
import { SettingsLayout, SettingsIndex } from "./routes/settings.js";
import { SettingsCategory } from "./routes/settings.$category.js";
import { Health } from "./routes/health.js";
import { Activate } from "./routes/activate.js";
import { OnboardingHome } from "./routes/onboarding.js";
import { LegacyAgentConnectionsRedirect } from "./routes/agent-connections.js";
import { LivePanel } from "./routes/live.js";

function RecordingRedirect() {
  const { stem } = useParams();
  const [sp] = useSearchParams();
  const qs = sp.toString();
  // Old voicemails were renamed voicemail_* → Memo_* by the unify migration, so
  // rewrite a legacy deep-link stem to its new name instead of 404ing the reader.
  const target = (stem ?? "").replace(/^voicemail_/, "Memo_");
  return <Navigate to={`/inbox/${target}${qs ? `?${qs}` : ""}`} replace />;
}

/** Every place in the app, including the retired ones that still redirect. */
export const APP_ROUTES: RouteObject[] = [
  {
    path: "/",
    Component: RootLayout,
    children: [
      { index: true, element: <Navigate to="/inbox" replace /> },
      { path: "inbox", Component: InboxIndex },
      { path: "inbox/:stem", Component: RecordingReader },
      { path: "activate", Component: Activate },
      { path: "onboarding", Component: OnboardingHome },
      {
        path: "knowledge/prompts",
        Component: Prompts,
        children: [
          { index: true, Component: PromptsIndex },
          { path: ":id", Component: PromptReaderRoute },
        ],
      },
      { path: "knowledge/glossary", Component: Glossary },
      {
        path: "settings",
        Component: SettingsLayout,
        children: [
          { index: true, Component: SettingsIndex },
          { path: ":category", Component: SettingsCategory },
        ],
      },
      { path: "health", Component: Health },

      // Retired places keep working as links: the meeting assistant and its
      // voice window are gone, and voice input lives in Settings.
      { path: "agent-console", element: <Navigate to="/inbox" replace /> },
      { path: "voice-chat", element: <Navigate to="/inbox" replace /> },
      { path: "voice-input", element: <Navigate to="/settings/voice" replace /> },
      { path: "agent-connections", Component: LegacyAgentConnectionsRedirect },
      { path: "inbox/voicemails", element: <Navigate to="/inbox" replace /> },
      { path: "inbox/meetings", element: <Navigate to="/inbox" replace /> },
      { path: "inbox/voicemails/:stem", element: <RecordingRedirect /> },
      { path: "inbox/meetings/:stem", element: <RecordingRedirect /> },
      { path: "health/doctor", element: <Navigate to="/health#doctor" replace /> },
      { path: "health/queue", element: <Navigate to="/health#queue" replace /> },
      { path: "health/scheduler", element: <Navigate to="/health#scheduler" replace /> },
      { path: "health/daemons", element: <Navigate to="/health#daemons" replace /> },
      { path: "health/logs", element: <Navigate to="/health#logs" replace /> },
    ],
  },
  // The floating notes panel: a page of its own, outside the window's panes.
  { path: "/live", Component: LivePanel },
];

const router = createBrowserRouter(APP_ROUTES);

export function App() {
  const [qc] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
  }));
  const [tc] = useState(() => makeTrpcClient());

  return (
    <trpc.Provider client={tc} queryClient={qc}>
      <QueryClientProvider client={qc}>
        <ThemeProvider>
          <LanguageProvider>
            <UndoToastProvider>
              <ThemeConfigSyncWithToast />
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

function ThemeConfigSyncWithToast() {
  const { showError } = useUndoToast();
  const t = useT();
  return <ThemeConfigSync onError={(error) => showError(t("settings.save.failed", { error }))} />;
}
