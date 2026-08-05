// web/src/i18n/LanguageProvider.tsx
//
// App-wide internationalization, mirroring ThemeProvider (web/src/theme.tsx):
// a React context that holds the active language, persists the choice to
// localStorage, and exposes `useLang()` / `useT()`. Default is Chinese ("zh").
//
// Translation strings live in ./messages.ts keyed by stable dotted keys. The
// `t(key, vars?)` returned by `useT()` resolves the active language's string,
// falls back to English, then to the key itself, and interpolates `{var}`
// placeholders from `vars`.
//
// A module-level `currentLang` mirror + standalone `translate()` are exported so
// non-React call sites (e.g. route-handle breadcrumbs declared at module scope)
// can resolve a key without a hook. React surfaces (TopBar) should prefer the
// hook so they re-render on a language switch.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { trpc } from "../trpc.js";
import { MESSAGES, type Lang } from "./messages.js";

export type { Lang } from "./messages.js";

export type TVars = Record<string, string | number>;
export type TFunc = (key: string, vars?: TVars) => string;

interface LanguageContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: TFunc;
}

const KEY = "yulu_ui.lang";
const DEFAULT_LANG: Lang = "zh";

function isLang(v: unknown): v is Lang {
  return v === "zh" || v === "en";
}

function readStored(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    return isLang(v) ? v : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
}

// Module-level mirror of the active language so the standalone `translate()`
// (used by non-React call sites) tracks the latest choice. Kept in sync by the
// provider's effect below.
let currentLang: Lang = readStored();

function interpolate(template: string, vars?: TVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/**
 * Resolve a dotted message key for an explicit language: active → English →
 * the key itself. Exported for non-React call sites; React code should use the
 * `t` from `useT()` so it re-renders on a language switch.
 */
export function translate(lang: Lang, key: string, vars?: TVars): string {
  const table = MESSAGES[lang];
  const raw = table[key] ?? MESSAGES.en[key] ?? key;
  return interpolate(raw, vars);
}

/** Active-language translate for non-React call sites (reads the module mirror). */
export function translateActive(key: string, vars?: TVars): string {
  return translate(currentLang, key, vars);
}

/** The current active language for non-React call sites. */
export function getActiveLang(): Lang {
  return currentLang;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => readStored());

  // Keep the module mirror + <html lang> in sync with the active language.
  useEffect(() => {
    currentLang = lang;
    document.documentElement.setAttribute("lang", lang === "zh" ? "zh-CN" : "en");
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    try { localStorage.setItem(KEY, l); } catch { /* ignore quota / disabled storage */ }
    currentLang = l;
    setLangState(l);
  }, []);

  const t = useCallback<TFunc>((key, vars) => translate(lang, key, vars), [lang]);

  const value = useMemo<LanguageContextValue>(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function LanguageConfigSync() {
  const { data: cfg } = trpc.config.get.useQuery();
  const updateMut = trpc.config.update.useMutation();
  const utils = trpc.useUtils();
  const { lang, setLang } = useLang();
  const hydrated = useRef(false);
  const lastConfig = useRef<Lang | null>(null);

  useEffect(() => {
    if (!cfg) return;
    const raw = (cfg as { ui?: { language?: unknown } }).ui?.language;
    const next = isLang(raw) ? raw : DEFAULT_LANG;
    if (next === lastConfig.current) return;
    lastConfig.current = next;
    hydrated.current = true;
    setLang(next);
  }, [cfg, setLang]);

  useEffect(() => {
    if (!hydrated.current || lang === lastConfig.current) return;
    lastConfig.current = lang;
    updateMut.mutate(
      { key: "ui.language", value: lang },
      { onSettled: () => void utils.config.get.invalidate() },
    );
  }, [lang, updateMut, utils]);

  return null;
}

export function useLang(): { lang: Lang; setLang: (l: Lang) => void } {
  const v = useContext(LanguageContext);
  if (!v) throw new Error("useLang must be used inside <LanguageProvider>");
  return { lang: v.lang, setLang: v.setLang };
}

/**
 * Returns the active-language `t(key, vars?)`. Re-renders the calling component
 * whenever the language switches. Outside a provider it falls back to the
 * default-language translate so isolated unit tests of a single component don't
 * need to wrap in <LanguageProvider> (they still get real strings).
 */
export function useT(): TFunc {
  const v = useContext(LanguageContext);
  if (v) return v.t;
  return (key, vars) => translate(DEFAULT_LANG, key, vars);
}
