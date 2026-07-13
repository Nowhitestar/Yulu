import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Clock3, ExternalLink, Send, Share2, XCircle } from "lucide-react";
import { useT } from "../i18n/LanguageProvider.js";
import "./SharePopover.css";

export interface ShareHistoryEntry {
  id: string;
  channel: string;
  label: string;
  destination: string;
  sentAt: string;
  status: "success" | "failed" | "unverified";
  message?: string;
}

export interface ShareTarget {
  channel: string;
  label: string;
  destination: string;
  enabled: boolean;
  disabledReason: string | null;
  lastShare: ShareHistoryEntry | null;
}

interface Props {
  targets: ShareTarget[];
  history?: ShareHistoryEntry[];
  pendingChannel?: string | null;
  onSend: (target: { channel: string; label: string; destination: string }) => void;
  disabled?: boolean;
  className?: string;
}

function formatShareTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function disabledReasonText(reason: string | null, t: (key: string) => string): string {
  if (reason === "Needs AI Summary") return t("share.disabled.summary");
  if (reason === "Destination missing") return t("share.disabled.destination");
  return reason ?? t("share.disabled");
}

function channelSlug(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").slice(0, 40);
}

export function SharePopover({ targets, history = [], pendingChannel, onSend, disabled, className }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties | null | undefined>(undefined);
  const [customChannel, setCustomChannel] = useState("");
  const [customDestination, setCustomDestination] = useState("");
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
      const width = Math.min(340, window.innerWidth - margin * 2);
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
    popoverRef.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")?.focus();
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

  const slug = channelSlug(customChannel);
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
        <div ref={popoverRef} className="share-popover" role="dialog" aria-label={t("share.title")} style={style === undefined ? { visibility: "hidden" } : style ?? undefined}>
          <div className="share-panel">
            <div className="share-panel-head">
              <div><div className="share-panel-title">{t("share.title")}<span className="share-format">Markdown</span></div><div className="share-panel-sub">{t("share.sub")}</div></div>
              <Share2 size={15} strokeWidth={1.8} />
            </div>
            <div className="share-targets">
              {targets.map((target) => {
                const pending = pendingChannel === target.channel;
                return (
                  <button key={target.channel} type="button" className="share-target" disabled={!target.enabled || Boolean(pendingChannel)} onClick={() => onSend(target)}>
                    <span className={`share-target-mark share-target-mark--${target.channel}`}><ExternalLink size={14} /></span>
                    <span className="share-target-main">
                      <span className="share-target-label">{target.label}</span>
                      <span className="share-target-destination">{target.destination || t("value.unset")}</span>
                      {target.lastShare && <span className={`share-target-last share-target-last--${target.lastShare.status}`}>{target.lastShare.status === "success" ? t("share.last.success") : target.lastShare.status === "unverified" ? t("share.last.unverified") : t("share.last.failed")} · {formatShareTime(target.lastShare.sentAt)}</span>}
                    </span>
                    <span className="share-target-state">{pending ? <><Clock3 size={13} />{t("share.pending")}</> : target.enabled ? <><Send size={13} />{t("share.send")}</> : disabledReasonText(target.disabledReason, t)}</span>
                  </button>
                );
              })}
            </div>
            <form className="share-custom" onSubmit={(event) => {
              event.preventDefault();
              if (!slug) return;
              onSend({ channel: slug, label: customChannel.trim(), destination: customDestination.trim() });
            }}>
              <div className="share-history-title">{t("share.custom.title")}</div>
              <div className="share-custom-fields">
                <input disabled={Boolean(pendingChannel)} value={customChannel} onChange={(event) => setCustomChannel(event.target.value)} placeholder={t("share.custom.channel")} aria-label={t("share.custom.channel")} />
                <input disabled={Boolean(pendingChannel)} value={customDestination} onChange={(event) => setCustomDestination(event.target.value)} placeholder={t("share.custom.destination")} aria-label={t("share.custom.destination")} />
                <button type="submit" disabled={!slug || Boolean(pendingChannel)}><Send size={13} />{t("share.send")}</button>
              </div>
            </form>
            <div className="share-history">
              <div className="share-history-title">{t("share.history")}</div>
              {history.length === 0 ? <div className="share-history-empty">{t("share.history.empty")}</div> : history.slice(0, 3).map((entry) => (
                <div key={entry.id} className="share-history-row">
                  {entry.status === "success" ? <CheckCircle2 size={13} /> : entry.status === "unverified" ? <AlertTriangle size={13} /> : <XCircle size={13} />}
                  <span>{entry.label}</span><span>{formatShareTime(entry.sentAt)}</span>{entry.message && <em>{entry.message}</em>}
                </div>
              ))}
            </div>
          </div>
        </div>, document.body,
      )}
    </div>
  );
}
