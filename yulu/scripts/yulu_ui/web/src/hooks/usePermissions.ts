import { useEffect } from "react";
import { trpc } from "../trpc.js";

export function usePermissions() {
  const query = trpc.permissions.status.useQuery(undefined, {
    retry: false,
    refetchInterval: 5_000,
    refetchOnWindowFocus: "always",
  });
  const { refetch } = query;
  useEffect(() => {
    const refresh = () => { void refetch(); };
    // Native WebViews can regain focus without a document visibility change.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refetch]);
  return { ...query, data: query.isError ? undefined : query.data };
}
