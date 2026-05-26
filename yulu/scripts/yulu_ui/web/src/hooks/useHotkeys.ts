import { useEffect, useRef } from "react";

export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

/**
 * Bind global keydown shortcuts. Handler is skipped when focus is inside
 * an editable element (input, textarea, contenteditable) so typing in a
 * search box doesn't trigger nav keys.
 */
export function useHotkeys(map: HotkeyMap): void {
  // Stable ref so re-renders don't reattach listeners
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (isEditable(target)) return;
      const handler = mapRef.current[e.key];
      if (handler) handler(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function isEditable(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (typeof (el as { tagName?: unknown }).tagName !== "string") return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  // Fallback for environments (e.g. jsdom) where isContentEditable is not
  // computed from the attribute.
  if (typeof el.getAttribute === "function") {
    const ce = el.getAttribute("contenteditable");
    if (ce !== null && ce !== "false") return true;
  }
  return false;
}
