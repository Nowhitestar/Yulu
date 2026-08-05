// web/src/components/UndoToast.tsx
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n/LanguageProvider.js";
import "./UndoToast.css";

const TOAST_MS = 6000;

export interface UndoRequest {
  /** Short label of what was changed, e.g. the field label. */
  label: string;
  /** Re-applies the previous value. Invoked when the user clicks 撤销. */
  onUndo: () => void;
}

interface UndoToastApi {
  /** Show the "已保存 · 撤销" toast for a few seconds. */
  showUndo: (req: UndoRequest) => void;
  /** Show a settings save/apply failure instead of silently dropping it. */
  showError: (message: string) => void;
}

// Default no-op so the hook is safe to call without a provider (e.g. in unit
// tests of a single section). SettingsLayout supplies the real implementation.
const UndoToastContext = createContext<UndoToastApi>({ showUndo: () => {}, showError: () => {} });

export function useUndoToast(): UndoToastApi {
  return useContext(UndoToastContext);
}

/**
 * Owns the transient "已保存 · 撤销" toast shown after a settings field commits.
 * A single toast slot: a newer save replaces the previous one. Auto-dismisses
 * after a few seconds. Undo invokes the request's `onUndo` (which re-commits the
 * previous value) and closes the toast. Mounted once in SettingsLayout so every
 * section's commit (routed through useConfigField) surfaces here uniformly.
 */
export function UndoToastProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [req, setReq] = useState<UndoRequest | null>(null);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  const showUndo = useCallback((next: UndoRequest) => {
    clear();
    setError("");
    setReq(next);
    timer.current = setTimeout(() => setReq(null), TOAST_MS);
  }, [clear]);

  const showError = useCallback((message: string) => {
    clear();
    setReq(null);
    setError(message);
    timer.current = setTimeout(() => setError(""), TOAST_MS);
  }, [clear]);

  useEffect(() => clear, [clear]);

  const onUndo = () => {
    clear();
    req?.onUndo();
    setReq(null);
  };

  return (
    <UndoToastContext.Provider value={{ showUndo, showError }}>
      {children}
      {req && (
        <div className="undo-toast" role="status" data-testid="undo-toast">
          <span className="undo-toast-msg">{t("undo.saved")}</span>
          <span className="undo-toast-sep">·</span>
          <button type="button" className="undo-toast-btn" onClick={onUndo}>{t("undo.action")}</button>
        </div>
      )}
      {error && (
        <div className="undo-toast undo-toast--error" role="alert" data-testid="settings-error-toast">
          <span>{error}</span>
        </div>
      )}
    </UndoToastContext.Provider>
  );
}
