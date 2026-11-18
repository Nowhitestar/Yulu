// Appearance: one palette, three modes. "auto" follows the system.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { trpc } from "./trpc.js";

export type ThemeMode = "auto" | "light" | "dark";
export type ResolvedThemeMode = "light" | "dark";

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const MODE_KEY = "yulu_theme_mode";

export function normalizeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" ? value : "auto";
}

function readStoredMode(): ThemeMode {
  try { return normalizeMode(localStorage.getItem(MODE_KEY)); } catch { return "auto"; }
}

function persistLocal(mode: ThemeMode): void {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* private window: keep the in-memory choice */ }
}

function resolve(mode: ThemeMode): ResolvedThemeMode {
  if (mode !== "auto") return mode;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark" : "light";
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [resolved, setResolved] = useState<ResolvedThemeMode>(() => resolve(readStoredMode()));

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  useEffect(() => {
    if (mode !== "auto" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(resolve("auto"));
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    const normalized = normalizeMode(next);
    setModeState(normalized);
    setResolved(resolve(normalized));
    persistLocal(normalized);
  }, []);

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Keeps the appearance in config.json: applies the saved mode, persists explicit changes. */
export function ThemeConfigSync({ onError }: { onError?: (error: string) => void } = {}) {
  const { data: cfg } = trpc.config.get.useQuery();
  const updateMut = trpc.config.update.useMutation();
  const utils = trpc.useUtils();
  const { mode, setMode } = useTheme();
  const saved = useRef<ThemeMode | null>(null);
  const applying = useRef<ThemeMode | null>(null);

  useEffect(() => {
    if (!cfg) return;
    const next = normalizeMode((cfg as { ui?: { theme?: { mode?: unknown } } }).ui?.theme?.mode);
    if (next === saved.current) return;
    saved.current = next;
    applying.current = next;
    setMode(next);
  }, [cfg, setMode]);

  useEffect(() => {
    if (saved.current === null) return;
    if (applying.current !== null) {
      if (mode === applying.current) applying.current = null;
      return;
    }
    if (mode === saved.current) return;
    const previous = saved.current;
    saved.current = mode;
    updateMut.mutate(
      { key: "ui.theme.mode", value: mode },
      {
        onError: (error) => {
          if (saved.current === mode) {
            saved.current = previous;
            applying.current = previous;
            setMode(previous);
          }
          onError?.(error.message);
        },
        onSettled: () => void utils.config.get.invalidate(),
      },
    );
  }, [mode, updateMut, utils, onError, setMode]);

  return null;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}
