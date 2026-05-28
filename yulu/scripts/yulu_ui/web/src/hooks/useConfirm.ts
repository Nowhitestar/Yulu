import { useCallback } from "react";

export function useConfirm(): (message: string) => boolean {
  return useCallback((message: string) => window.confirm(message), []);
}
