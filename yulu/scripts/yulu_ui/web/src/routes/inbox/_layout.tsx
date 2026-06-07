// web/src/routes/inbox/_layout.tsx
import { Outlet, useLocation, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useHotkeys } from "../../hooks/useHotkeys.js";
import { trpc } from "../../trpc.js";

export const handle = { breadcrumb: "breadcrumb.inbox", filters: null };

/**
 * Wraps all /inbox/* routes. Registers keyboard shortcuts (j/k) once.
 * Reads the React Query cache (or the live tRPC hook as a fallback) to
 * compute the next/prev stem in the unified recordings list and navigate
 * to /inbox/:stem.
 */
export function InboxLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const qc = useQueryClient();

  // Live data via the tRPC hook. React-query dedupes against the same key
  // used by RecordingsList, so this is essentially free in prod and gives
  // the test (which mocks useQuery directly) a way to provide data.
  const recList = trpc.recordings.list.useQuery({});

  const moveSelection = useCallback((direction: 1 | -1) => {
    const cached =
      (qc.getQueryData([["recordings", "list"], { input: {} }]) as Array<{ stem: string }> | undefined) ??
      (qc.getQueryData([["recordings", "list"]]) as Array<{ stem: string }> | undefined);
    const live = recList.data as Array<{ stem: string }> | undefined;
    const data = cached ?? live;
    if (!data || data.length === 0) return;
    const currentStem = params.stem;
    let idx = data.findIndex((r) => r.stem === currentStem);
    if (idx < 0) idx = 0;
    else idx = Math.max(0, Math.min(data.length - 1, idx + direction));
    const next = data[idx]?.stem;
    if (next) {
      navigate(`/inbox/${next}${location.search}`);
    }
  }, [qc, params.stem, navigate, location.search, recList.data]);

  useHotkeys({
    j: () => moveSelection(1),
    k: () => moveSelection(-1),
    // space / [ / ] / / handlers deferred
  });

  return <Outlet />;
}
