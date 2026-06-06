// web/src/components/DangerConfirm.tsx
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

/**
 * The async danger-confirm gate (P3-3). A field flagged `danger` in the registry
 * routes its commit through `confirm(label)` before persisting; only an explicit
 * "Apply" lets the edit through. Mirrors the existing `.cloud-warn` alertdialog
 * UX (honest, opt-in, never a hard block) but is generic over any field type,
 * since it sits in the shared commit path (useConfigField) rather than inside one
 * input component.
 */
interface DangerConfirmApi {
  /** Resolves true if the user confirms the risky change, false if they cancel. */
  confirm: (label: string) => Promise<boolean>;
}

// Default is PERMISSIVE: a section rendered without the provider (e.g. a focused
// unit test) must not silently swallow legitimate edits — it resolves true so the
// commit proceeds. The real gate is supplied by DangerConfirmProvider.
const DangerConfirmContext = createContext<DangerConfirmApi>({
  confirm: async () => true,
});

export function useDangerConfirm(): DangerConfirmApi {
  return useContext(DangerConfirmContext);
}

interface PendingConfirm {
  label: string;
  resolve: (ok: boolean) => void;
}

/**
 * Owns the single danger-confirm dialog. `confirm(label)` returns a Promise that
 * resolves when the user picks Apply (true) or Cancel (false). One request at a
 * time: a second confirm while one is pending auto-cancels the first (resolves it
 * false) so a stale resolver can never leak. Mounted in SettingsLayout so every
 * danger-flagged commit (routed through useConfigField) surfaces here uniformly.
 */
export function DangerConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Hold the live resolver in a ref so settle() always closes over the latest
  // one (setState is async; a captured `pending` could be stale).
  const pendingRef = useRef<PendingConfirm | null>(null);

  const settle = useCallback((ok: boolean) => {
    const cur = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    cur?.resolve(ok);
  }, []);

  const confirm = useCallback((label: string): Promise<boolean> => {
    // If a confirm is already open, cancel it (resolve false) before opening the
    // next — never drop a resolver on the floor.
    pendingRef.current?.resolve(false);
    return new Promise<boolean>((resolve) => {
      const req: PendingConfirm = { label, resolve };
      pendingRef.current = req;
      setPending(req);
    });
  }, []);

  return (
    <DangerConfirmContext.Provider value={{ confirm }}>
      {children}
      {pending && (
        <div className="danger-confirm-backdrop" onClick={() => settle(false)}>
          <div
            className="danger-confirm"
            role="alertdialog"
            aria-label="Confirm a risky change"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="danger-confirm-title">Apply this change?</div>
            <div className="danger-confirm-body">
              Changing <span className="danger-confirm-field">{pending.label}</span> affects
              recording or transcription. Apply it?
            </div>
            <div className="danger-confirm-actions">
              <button type="button" className="path-btn" onClick={() => settle(false)}>Cancel</button>
              <button type="button" className="path-btn danger-confirm-accept" onClick={() => settle(true)}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </DangerConfirmContext.Provider>
  );
}
