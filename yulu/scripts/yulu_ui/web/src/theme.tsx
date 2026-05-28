// web/src/theme.tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemeChoice = "auto" | "light" | "dark";
type Resolved = "light" | "dark";

interface ThemeContextValue {
  choice: ThemeChoice;
  resolved: Resolved;
  set: (c: ThemeChoice) => void;
}

const KEY = "yulu_theme";

function readStored(): ThemeChoice {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "auto";
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" &&
         window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(choice: ThemeChoice): Resolved {
  if (choice === "auto") return systemPrefersDark() ? "dark" : "light";
  return choice;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<ThemeChoice>(() => readStored());
  const [resolved, setResolved] = useState<Resolved>(() => resolve(readStored()));

  // Apply data-theme attribute whenever resolved changes
  useEffect(() => { document.documentElement.setAttribute("data-theme", resolved); }, [resolved]);

  // Track system changes when in auto mode
  useEffect(() => {
    if (choice !== "auto" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice]);

  const set = useCallback((c: ThemeChoice) => {
    if (c === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, c);
    setChoice(c);
    setResolved(resolve(c));
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({ choice, resolved, set }), [choice, resolved, set]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error("useTheme must be used inside <ThemeProvider>");
  return v;
}
