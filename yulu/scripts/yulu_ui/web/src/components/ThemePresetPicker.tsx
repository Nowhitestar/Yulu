// web/src/components/ThemePresetPicker.tsx
import { useState, type CSSProperties } from "react";
import {
  CUSTOM_THEME_FIELDS,
  DEFAULT_CUSTOM_THEME,
  THEME_FAMILIES,
  normalizeCustomTheme,
  useTheme,
  type CustomThemeColorKey,
  type ResolvedThemeMode,
  type ThemeFamily,
} from "../theme.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./ThemePresetPicker.css";

const FAMILY_SWATCHES: Record<ThemeFamily, string[]> = {
  default: ["#edf4ff", "#ffffff", "#1473e6"],
  ayu: ["#fcfcfc", "#10141c", "#ffaa33"],
  paper: ["#eeeeee", "#1c1c1c", "#0087af"],
  custom: ["#f5f8ff", "#1c2534", "#8e5cf7"],
};

function swatchStyle(colors: string[]): CSSProperties {
  return {
    background: `linear-gradient(135deg, ${colors[0]} 0 34%, ${colors[1]} 34% 68%, ${colors[2]} 68% 100%)`,
  };
}

function previewStyle(colors: string[]): CSSProperties {
  return {
    background: `linear-gradient(135deg, ${colors[0]}, ${colors[1]})`,
    color: colors[1],
  };
}

export function ThemePresetPicker() {
  const { family, setFamily, mode, setMode, resolved, customTheme, setCustomTheme, resetCustomTheme } = useTheme();
  const [editMode, setEditMode] = useState<ResolvedThemeMode>(resolved);
  const t = useT();

  const setCustomColor = (key: CustomThemeColorKey, value: string) => {
    setCustomTheme({
      ...customTheme,
      [editMode]: {
        ...customTheme[editMode],
        [key]: value,
      },
    });
  };

  const exportJson = async () => {
    const body = JSON.stringify(customTheme, null, 2);
    try {
      await navigator.clipboard?.writeText(body);
      window.alert(t("theme.custom.exported"));
    } catch {
      window.prompt(t("theme.custom.exportPrompt"), body);
    }
  };

  const importJson = () => {
    const raw = window.prompt(t("theme.custom.importPrompt"));
    if (!raw) return;
    try {
      setCustomTheme(normalizeCustomTheme(JSON.parse(raw)));
    } catch {
      window.alert(t("theme.custom.importFailed"));
    }
  };

  return (
    <div className="theme-preset-stack">
      <div className="theme-panel-heading">
        <div>
          <div className="theme-panel-title">{t("theme.family.heading")}</div>
          <div className="theme-panel-sub">{t("theme.family.sub")}</div>
        </div>
        <div className="theme-mode-toggle" role="group" aria-label={t("theme.mode.aria")}>
          {(["auto", "light", "dark"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              className={mode === value ? "active" : ""}
              onClick={() => setMode(value)}
            >
              {t(`theme.${value}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="theme-family-picker" role="group" aria-label={t("theme.family.aria")}>
        {THEME_FAMILIES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            aria-pressed={family === theme.id}
            className={family === theme.id ? "active" : ""}
            onClick={() => setFamily(theme.id)}
          >
            <span className="theme-preset-swatch" style={swatchStyle(FAMILY_SWATCHES[theme.id])} />
            <span>{t(theme.labelKey)}</span>
          </button>
        ))}
      </div>

      <div className="theme-preview-window" aria-label={t("theme.preview.aria")}>
        <div className="theme-preview-chrome">
          <span />
          <span />
          <span />
        </div>
        <div className="theme-preview-body" style={family === "custom" ? previewStyle([customTheme[resolved].surface, customTheme[resolved].text]) : undefined}>
          <div className="theme-preview-sidebar" />
          <div className="theme-preview-main">
            <div className="theme-preview-line strong" />
            <div className="theme-preview-line" />
            <div className="theme-preview-card" />
          </div>
        </div>
      </div>

      {family === "custom" && (
        <div className="theme-custom-panel" aria-label={t("theme.custom.aria")}>
          <div className="theme-custom-head">
            <div className="theme-custom-mode" role="group" aria-label={t("theme.custom.mode.aria")}>
              {(["light", "dark"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={editMode === value}
                  className={editMode === value ? "active" : ""}
                  onClick={() => setEditMode(value)}
                >
                  {t(`theme.${value}`)}
                </button>
              ))}
            </div>
            <div className="theme-custom-actions">
              <button type="button" onClick={importJson}>{t("theme.custom.import")}</button>
              <button type="button" onClick={exportJson}>{t("theme.custom.export")}</button>
              <button type="button" onClick={() => setCustomTheme(DEFAULT_CUSTOM_THEME)}>{t("theme.custom.defaults")}</button>
              <button type="button" onClick={resetCustomTheme}>{t("theme.custom.reset")}</button>
            </div>
          </div>

          <div className="theme-custom-grid">
            {CUSTOM_THEME_FIELDS.map((field) => (
              <label key={field.key} className="theme-custom-field">
                <span>{t(field.labelKey)}</span>
                <input
                  type="color"
                  value={customTheme[editMode][field.key]}
                  onChange={(event) => setCustomColor(field.key, event.target.value)}
                />
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
