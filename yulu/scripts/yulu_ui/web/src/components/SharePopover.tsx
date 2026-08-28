import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, ExternalLink, Send, Share2 } from "lucide-react";
import { useT } from "../i18n/LanguageProvider.js";
import "./SharePopover.css";

export interface RecordingShareView {
  status: "ready" | "unavailable" | "unknown";
  detail: string;
  remediation: string;
  duplicateWarningRequired: boolean;
  latestAction: {
    id: string;
    status: "pending" | "verified" | "failed" | "unknown" | "abandoned";
    receiptId: string;
    receiptUrl: string;
    detail: string;
  } | null;
  snapshot: {
    hash: string;
    recordingStem: string;
    summary: string;
    summarySha256: string;
    connection: { id: string; adapter: string; label: string; updatedAt: string };
    connector: "notion" | "zulip";
    destination: string;
  } | null;
}

interface Props {
  view: RecordingShareView | null;
  pending?: boolean;
  onConfirm: (input: { snapshotHash: string; duplicateConfirmed: boolean }) => void;
  onAbandonUnknown?: (actionId: string) => void;
  disabled?: boolean;
  className?: string;
}

export function SharePopover({ view, pending, onConfirm, onAbandonUnknown, disabled, className }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties | null | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (!open) { setStyle(undefined); return; }
    const update = () => {
      if (window.innerWidth <= 760) { setStyle(null); return; }
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 14;
      const width = Math.min(420, window.innerWidth - margin * 2);
      const left = Math.min(Math.max(margin, rect.right - width), window.innerWidth - width - margin);
      const height = Math.min(popoverRef.current?.getBoundingClientRect().height ?? 0, window.innerHeight - margin * 2);
      const below = rect.bottom + 8;
      const top = below + height <= window.innerHeight - margin
        ? below
        : Math.max(margin, rect.top - height - 8);
      setStyle({ top, left, width });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : triggerRef.current;
    popoverRef.current?.querySelector<HTMLElement>("button:not(:disabled), a[href]")?.focus();
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && !rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [open]);

  const confirmShare = () => {
    if (!view?.snapshot || view.status !== "ready") return;
    onConfirm({ snapshotHash: view.snapshot.hash, duplicateConfirmed: view.duplicateWarningRequired });
    setOpen(false);
  };

  return (
    <div className="share-popover-root" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={className ?? "share-trigger"}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t("share.title")}
        onClick={() => setOpen((value) => !value)}
      >
        <Share2 size={14} strokeWidth={1.8} />
        <span>{t("share.button")}</span>
      </button>
      {open && createPortal(
        <div ref={popoverRef} className="share-popover" role="dialog" aria-label={t("share.confirm.title")} style={style === undefined ? { visibility: "hidden" } : style ?? undefined}>
          <div className="share-panel">
            <div className="share-panel-head">
              <div>
                <div className="share-panel-title">{t("share.confirm.title")}<span className="share-format">Markdown</span></div>
                <div className="share-panel-sub">{t("share.confirm.sub")}</div>
              </div>
              <Share2 size={15} strokeWidth={1.8} />
            </div>
            {view?.snapshot ? (
              <div className="share-snapshot">
                <div className="share-snapshot-row">
                  <span>{t("share.confirm.connection")}</span>
                  <strong>{view.snapshot.connection.label}</strong>
                  <small>{view.snapshot.connection.adapter}</small>
                </div>
                <div className="share-snapshot-row">
                  <span>{t("share.confirm.destination")}</span>
                  <strong>{view.snapshot.connector}</strong>
                  <small>{view.snapshot.destination}</small>
                </div>
                <div className="share-summary-label">{t("share.confirm.summary")}</div>
                <pre className="share-summary-snapshot">{view.snapshot.summary}</pre>
              </div>
            ) : null}
            {view?.duplicateWarningRequired && view.status === "ready" && (
              <div className="share-warning" role="alert"><AlertTriangle size={15} /><span>{t("share.confirm.duplicate")}</span></div>
            )}
            {view?.status === "unknown" && (
              <div className="share-warning" role="alert"><AlertTriangle size={15} /><span>{view.remediation}</span></div>
            )}
            {view?.status === "unavailable" && (
              <div className="share-unavailable">
                <span>{view.detail}</span>
                <a href="/settings/sharing"><ExternalLink size={13} />{t("share.confirm.configure")}</a>
              </div>
            )}
            {view?.latestAction?.status === "verified" && (
              <div className="share-outcome"><CheckCircle2 size={14} />{t("share.confirm.verified")}</div>
            )}
            <div className="share-confirm-actions">
              <button type="button" className="secondary" onClick={() => setOpen(false)}>{t("share.confirm.cancel")}</button>
              {view?.status === "unknown" && view.latestAction && onAbandonUnknown ? (
                <button type="button" className="danger" disabled={pending} onClick={() => {
                  onAbandonUnknown(view.latestAction!.id);
                  setOpen(false);
                }}>{t("share.confirm.abandon")}</button>
              ) : null}
              <button type="button" className="primary" disabled={pending || view?.status !== "ready"} onClick={confirmShare}>
                <Send size={13} />
                {pending ? t("share.pending") : view?.duplicateWarningRequired ? t("share.confirm.sendAgain") : t("share.confirm.send")}
              </button>
            </div>
          </div>
        </div>, document.body,
      )}
    </div>
  );
}
