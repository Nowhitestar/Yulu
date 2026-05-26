import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router";
import { useState } from "react";
import { trpc, makeTrpcClient } from "./trpc.js";
import { ThemeProvider } from "./theme.js";
import { WsProvider } from "./ws.js";
import { RootLayout } from "./routes/root.js";

const router = createBrowserRouter([
  {
    path: "/",
    Component: RootLayout,
    children: [
      // Child routes filled in by Task B.11.
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
