// web/src/theme.tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { trpc } from "./trpc.js";

export type ThemeMode = "auto" | "light" | "dark";
export type ThemeChoice = ThemeMode;
export type ResolvedThemeMode = "light" | "dark";
export type ThemeFamily = "default" | "ayu" | "paper" | "custom";
export type ThemePresetId = ThemeFamily;

export interface ThemeFamilyOption {
  id: ThemeFamily;
  labelKey: string;
}

export type CustomThemeColorKey =
  | "wallpaper"
  | "surface"
  | "surfaceStrong"
  | "edge"
  | "text"
  | "muted"
  | "accent"
  | "blue"
  | "green"
  | "red"
  | "purple";

export type CustomThemeTokens = Record<CustomThemeColorKey, string>;

export interface CustomTheme {
  version: 1;
  light: CustomThemeTokens;
  dark: CustomThemeTokens;
}

export interface ThemeConfig {
  family: ThemeFamily;
  mode: ThemeMode;
  custom: CustomTheme;
}

interface ThemeContextValue {
  choice: ThemeMode;
  mode: ThemeMode;
  resolved: ResolvedThemeMode;
  family: ThemeFamily;
  preset: ThemeFamily;
  customTheme: CustomTheme;
  set: (mode: ThemeMode) => void;
  setMode: (mode: ThemeMode) => void;
  setFamily: (family: ThemeFamily) => void;
  setPreset: (family: ThemeFamily) => void;
  setCustomTheme: (theme: CustomTheme) => void;
  resetCustomTheme: () => void;
  applyConfig: (config: ThemeConfig) => void;
}

const MODE_KEY = "yulu_theme_mode";
const FAMILY_KEY = "yulu_theme_family";
const CUSTOM_KEY = "yulu_custom_theme_v2";
const LEGACY_MODE_KEY = "yulu_theme";
const LEGACY_PRESET_KEY = "yulu_theme_preset";
const LEGACY_CUSTOM_KEY = "yulu_custom_theme";

export const THEME_FAMILIES: ThemeFamilyOption[] = [
  { id: "default", labelKey: "theme.family.default" },
  { id: "ayu", labelKey: "theme.family.ayu" },
  { id: "paper", labelKey: "theme.family.paper" },
  { id: "custom", labelKey: "theme.family.custom" },
];

// Backward-compatible export for existing tests/components.
export const THEME_PRESETS = THEME_FAMILIES;

export const CUSTOM_THEME_FIELDS: { key: CustomThemeColorKey; labelKey: string }[] = [
  { key: "wallpaper", labelKey: "theme.custom.wallpaper" },
  { key: "surface", labelKey: "theme.custom.surface" },
  { key: "surfaceStrong", labelKey: "theme.custom.surfaceStrong" },
  { key: "edge", labelKey: "theme.custom.edge" },
  { key: "text", labelKey: "theme.custom.text" },
  { key: "muted", labelKey: "theme.custom.muted" },
  { key: "accent", labelKey: "theme.custom.accent" },
  { key: "blue", labelKey: "theme.custom.blue" },
  { key: "green", labelKey: "theme.custom.green" },
  { key: "red", labelKey: "theme.custom.red" },
  { key: "purple", labelKey: "theme.custom.purple" },
];

const DEFAULT_LIGHT_TOKENS: CustomThemeTokens = {
  wallpaper: "#edf4ff",
  surface: "#ffffff",
  surfaceStrong: "#f5f8ff",
  edge: "#9aa9bc",
  text: "#172033",
  muted: "#687488",
  accent: "#1473e6",
  blue: "#1473e6",
  green: "#248a3d",
  red: "#d70015",
  purple: "#8e5cf7",
};

const DEFAULT_DARK_TOKENS: CustomThemeTokens = {
  wallpaper: "#101722",
  surface: "#1c2534",
  surfaceStrong: "#2a364b",
  edge: "#5c6678",
  text: "#f4f7fb",
  muted: "#a7b1c2",
  accent: "#69a7ff",
  blue: "#69a7ff",
  green: "#6bd17a",
  red: "#ff6961",
  purple: "#b794ff",
};

export const DEFAULT_CUSTOM_THEME: CustomTheme = {
  version: 1,
  light: DEFAULT_LIGHT_TOKENS,
  dark: DEFAULT_DARK_TOKENS,
};

const CUSTOM_CSS_VARS = [
  "--wp-1",
  "--wp-2",
  "--wp-3",
  "--glass",
  "--glass-2",
  "--glass-3",
  "--edge",
  "--edge-top",
  "--fg",
  "--fg-2",
  "--fg-3",
  "--accent",
  "--accent-soft",
  "--accent-on",
  "--blue",
  "--green",
  "--red",
  "--purple",
  "--shadow",
  "--row-hover",
  "--field-bg",
  "--surface-solid",
];

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function normalizeTokens(value: unknown, fallback: CustomThemeTokens): CustomThemeTokens {
  const out = { ...fallback };
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const raw = value as Record<string, unknown>;
  for (const field of CUSTOM_THEME_FIELDS) {
    const next = raw[field.key];
    if (isHexColor(next)) out[field.key] = next;
  }
  return out;
}

export function normalizeCustomTheme(value: unknown): CustomTheme {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_CUSTOM_THEME;
  const raw = value as Record<string, unknown>;
  if (raw.colors && typeof raw.colors === "object") {
    const legacyMode = raw.mode === "dark" ? "dark" : "light";
    return {
      version: 1,
      light: legacyMode === "light" ? normalizeTokens(raw.colors, DEFAULT_LIGHT_TOKENS) : DEFAULT_LIGHT_TOKENS,
      dark: legacyMode === "dark" ? normalizeTokens(raw.colors, DEFAULT_DARK_TOKENS) : DEFAULT_DARK_TOKENS,
    };
  }
  return {
    version: 1,
    light: normalizeTokens(raw.light, DEFAULT_LIGHT_TOKENS),
    dark: normalizeTokens(raw.dark, DEFAULT_DARK_TOKENS),
  };
}

function normalizeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" ? value : "auto";
}

function normalizeFamily(value: unknown): ThemeFamily {
  return value === "ayu" || value === "paper" || value === "custom" ? value : "default";
}

function familyFromLegacyPreset(value: unknown): { family: ThemeFamily; mode: ThemeMode } | null {
  if (value === "ayu-light") return { family: "ayu", mode: "light" };
  if (value === "ayu-dark") return { family: "ayu", mode: "dark" };
  if (value === "paper-light") return { family: "paper", mode: "light" };
  if (value === "paper-dark") return { family: "paper", mode: "dark" };
  if (value === "custom") return { family: "custom", mode: "auto" };
  return null;
}

export function normalizeThemeConfig(value: unknown): ThemeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { family: "default", mode: "auto", custom: DEFAULT_CUSTOM_THEME };
  }
  const raw = value as Record<string, unknown>;
  const legacy = familyFromLegacyPreset(raw.preset);
  return {
    family: legacy?.family ?? normalizeFamily(raw.family),
    mode: legacy?.mode ?? normalizeMode(raw.mode),
    custom: normalizeCustomTheme(raw.custom),
  };
}

function readStoredMode(): ThemeMode {
  if (!isBrowser()) return "auto";
  return normalizeMode(localStorage.getItem(MODE_KEY) ?? localStorage.getItem(LEGACY_MODE_KEY));
}

function readStoredFamily(): ThemeFamily {
  if (!isBrowser()) return "default";
  const direct = localStorage.getItem(FAMILY_KEY);
  if (direct) return normalizeFamily(direct);
  return familyFromLegacyPreset(localStorage.getItem(LEGACY_PRESET_KEY))?.family ?? "default";
}

function readStoredCustomTheme(): CustomTheme {
  if (!isBrowser()) return DEFAULT_CUSTOM_THEME;
  const raw = localStorage.getItem(CUSTOM_KEY) ?? localStorage.getItem(LEGACY_CUSTOM_KEY);
  if (!raw) return DEFAULT_CUSTOM_THEME;
  try {
    return normalizeCustomTheme(JSON.parse(raw));
  } catch {
    return DEFAULT_CUSTOM_THEME;
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" &&
         window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(mode: ThemeMode): ResolvedThemeMode {
  if (mode === "auto") return systemPrefersDark() ? "dark" : "light";
  return mode;
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = isHexColor(hex) ? hex : "#000000";
  const r = parseInt(normalized.slice(1, 3), 16);
  const g = parseInt(normalized.slice(3, 5), 16);
  const b = parseInt(normalized.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function customThemeVars(theme: CustomTheme, resolved: ResolvedThemeMode): Record<string, string> {
  const c = theme[resolved];
  const isDark = resolved === "dark";
  return {
    "--wp-1": c.wallpaper,
    "--wp-2": c.surface,
    "--wp-3": c.surfaceStrong,
    "--glass": hexToRgba(c.surface, isDark ? 0.46 : 0.58),
    "--glass-2": hexToRgba(c.surface, isDark ? 0.62 : 0.74),
    "--glass-3": hexToRgba(c.surface, isDark ? 0.78 : 0.9),
    "--edge": hexToRgba(c.edge, isDark ? 0.34 : 0.28),
    "--edge-top": hexToRgba("#ffffff", isDark ? 0.1 : 0.78),
    "--fg": c.text,
    "--fg-2": c.muted,
    "--fg-3": hexToRgba(c.muted, 0.62),
    "--accent": c.accent,
    "--accent-soft": hexToRgba(c.accent, isDark ? 0.2 : 0.14),
    "--accent-on": isDark ? "#ffffff" : c.accent,
    "--blue": c.blue,
    "--green": c.green,
    "--red": c.red,
    "--purple": c.purple,
    "--shadow": isDark
      ? "0 18px 46px rgba(0, 0, 0, 0.42), 0 2px 8px rgba(0, 0, 0, 0.24)"
      : "0 20px 50px rgba(40, 70, 120, 0.13), 0 2px 10px rgba(40, 70, 120, 0.08)",
    "--row-hover": hexToRgba(c.text, isDark ? 0.08 : 0.045),
    "--field-bg": hexToRgba(c.surfaceStrong, isDark ? 0.72 : 0.9),
    "--surface-solid": c.surface,
  };
}

function applyCustomVars(theme: CustomTheme | null, resolved: ResolvedThemeMode) {
  const root = document.documentElement;
  for (const name of CUSTOM_CSS_VARS) root.style.removeProperty(name);
  if (!theme) return;
  const vars = customThemeVars(theme, resolved);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
}

function persistLocal(config: ThemeConfig): void {
  if (!isBrowser()) return;
  localStorage.setItem(MODE_KEY, config.mode);
  localStorage.setItem(FAMILY_KEY, config.family);
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(config.custom));
  localStorage.setItem(LEGACY_MODE_KEY, config.mode);
}

function serializeThemeConfig(config: ThemeConfig): string {
  return JSON.stringify({
    family: config.family,
    mode: config.mode,
    custom: config.custom,
  });
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode());
  const [family, setFamilyState] = useState<ThemeFamily>(() => readStoredFamily());
  const [customTheme, setCustomThemeState] = useState<CustomTheme>(() => readStoredCustomTheme());
  const [resolved, setResolved] = useState<ResolvedThemeMode>(() => resolve(readStoredMode()));

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.setAttribute("data-theme-family", family);
    document.documentElement.setAttribute("data-theme-preset", family === "default" ? "default" : `${family}-${resolved}`);
    document.documentElement.style.colorScheme = resolved;
    applyCustomVars(family === "custom" ? customTheme : null, resolved);
  }, [customTheme, family, resolved]);

  useEffect(() => {
    if (mode !== "auto" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(resolve(mode));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  const applyConfig = useCallback((config: ThemeConfig) => {
    setModeState(config.mode);
    setFamilyState(config.family);
    setCustomThemeState(config.custom);
    setResolved(resolve(config.mode));
    persistLocal(config);
  }, []);

  const setMode = useCallback((nextMode: ThemeMode) => {
    const next = normalizeMode(nextMode);
    setModeState(next);
    setResolved(resolve(next));
    persistLocal({ family, mode: next, custom: customTheme });
  }, [customTheme, family]);

  const setFamily = useCallback((nextFamily: ThemeFamily) => {
    const next = normalizeFamily(nextFamily);
    setFamilyState(next);
    persistLocal({ family: next, mode, custom: customTheme });
  }, [customTheme, mode]);

  const setCustomTheme = useCallback((theme: CustomTheme) => {
    const normalized = normalizeCustomTheme(theme);
    setCustomThemeState(normalized);
    persistLocal({ family, mode, custom: normalized });
  }, [family, mode]);

  const resetCustomTheme = useCallback(() => {
    setCustomThemeState(DEFAULT_CUSTOM_THEME);
    persistLocal({ family, mode, custom: DEFAULT_CUSTOM_THEME });
  }, [family, mode]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      choice: mode,
      mode,
      resolved,
      family,
      preset: family,
      customTheme,
      set: setMode,
      setMode,
      setFamily,
      setPreset: setFamily,
      setCustomTheme,
      resetCustomTheme,
      applyConfig,
    }),
    [applyConfig, customTheme, family, mode, resetCustomTheme, resolved, setCustomTheme, setFamily, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function ThemeConfigSync() {
  const { data: cfg } = trpc.config.get.useQuery();
  const updateMut = trpc.config.update.useMutation();
  const utils = trpc.useUtils();
  const theme = useTheme();
  const hydrated = useRef(false);
  const lastConfig = useRef("");

  useEffect(() => {
    if (!cfg) return;
    const raw = (cfg as { ui?: { theme?: unknown } }).ui?.theme;
    const next = normalizeThemeConfig(raw);
    const serialized = serializeThemeConfig(next);
    if (serialized === lastConfig.current) return;
    lastConfig.current = serialized;
    hydrated.current = true;
    theme.applyConfig(next);
  }, [cfg]);

  useEffect(() => {
    if (!hydrated.current) return;
    const next: ThemeConfig = {
      family: theme.family,
      mode: theme.mode,
      custom: theme.customTheme,
    };
    const serialized = serializeThemeConfig(next);
    if (serialized === lastConfig.current) return;
    lastConfig.current = serialized;
    updateMut.mutate(
      { key: "ui.theme", value: next },
      { onSettled: () => void utils.config.get.invalidate() },
    );
  }, [theme.family, theme.mode, theme.customTheme, updateMut, utils]);

  return null;
}

export function useTheme(): ThemeContextValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error("useTheme must be used inside <ThemeProvider>");
  return v;
}
