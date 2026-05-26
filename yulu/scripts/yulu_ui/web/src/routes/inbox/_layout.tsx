// web/src/routes/inbox/_layout.tsx
import { Outlet, useLocation, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useHotkeys } from "../../hooks/useHotkeys.js";
import { trpc } from "../../trpc.js";

/**
 * Wraps all /inbox/* routes. Registers keyboard shortcuts (j/k) once.
 * Reads the React Query cache (or the live tRPC hook as a fallback) to
 * compute the next/prev stem in the active list and navigate there.
 */
export function InboxLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const qc = useQueryClient();

  // Determine which list to navigate based on current path
  const isVoicemails = location.pathname.startsWith("/inbox/voicemails");
  const isMeetings = location.pathname.startsWith("/inbox/meetings");

  // Live data via the tRPC hooks. React-query dedupes against the same key
  // used by the list-page components, so this is essentially free in prod
  // and gives the test (which mocks useQuery directly) a way to provide data.
  const vmList = trpc.voicemails.list.useQuery({}, { enabled: isVoicemails });
  const mtList = trpc.meetings.list.useQuery({}, { enabled: isMeetings });

  const moveSelection = useCallback((direction: 1 | -1) => {
    if (!isVoicemails && !isMeetings) return;
    const queryKey = isVoicemails ? ["voicemails", "list"] : ["meetings", "list"];
    const cached =
      (qc.getQueryData([queryKey, { input: {} }]) as Array<{ stem: string }> | undefined) ??
      (qc.getQueryData([queryKey]) as Array<{ stem: string }> | undefined);
    const live = (isVoicemails ? vmList.data : mtList.data) as Array<{ stem: string }> | undefined;
    const data = cached ?? live;
    if (!data || data.length === 0) return;
    const currentStem = params.stem;
    let idx = data.findIndex((r) => r.stem === currentStem);
    if (idx < 0) idx = 0;
    else idx = Math.max(0, Math.min(data.length - 1, idx + direction));
    const next = data[idx]?.stem;
    if (next) {
      const basePath = isVoicemails ? "/inbox/voicemails" : "/inbox/meetings";
      navigate(`${basePath}/${next}${location.search}`);
    }
  }, [isVoicemails, isMeetings, qc, params.stem, navigate, location.search, vmList.data, mtList.data]);

  useHotkeys({
    j: () => moveSelection(1),
    k: () => moveSelection(-1),
    // space / [ / ] / / handlers deferred
  });

  return <Outlet />;
}
