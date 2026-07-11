import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Clock3, ExternalLink, Send, Share2, XCircle } from "lucide-react";
import { useT } from "../i18n/LanguageProvider.js";
import "./SharePopover.css";

export type SummaryChannel = "notion" | "zulip";

export interface ShareHistoryEntry {
  id: string;
  channel: SummaryChannel;
  label: string;
  destination: string;
  sentAt: string;
  status: "success" | "failed";
  message?: string;
}

export interface ShareTarget {
  channel: SummaryChannel;
  label: string;
  destination: string;
  enabled: boolean;
  disabledReason: string | null;
  lastShare: ShareHistoryEntry | null;
}

interface SharePanelProps {
  targets: ShareTarget[];
  history?: ShareHistoryEntry[];
  pendingChannel?: SummaryChannel | null;
  onSend: (channel: SummaryChannel) => void;
}

interface SharePopoverProps extends SharePanelProps {
  label?: string;
  className?: string;
  align?: "left" | "right";
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}

function formatShareTime(value: string | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

function disabledReasonText(reason: string | null, t: (key: string) => string): string {
  if (reason === "Needs AI Summary") return t("share.disabled.summary");
  if (reason === "Destination missing") return t("share.disabled.destination");
  return reason ?? t("share.disabled");
}

export function SharePanel({ targets, history = [], pendingChannel, onSend }: SharePanelProps) {
  const t = useT();
  const recent = history.slice(0, 3);
  return (
    <div className="share-panel">
      <div className="share-panel-head">
        <div>
          <div className="share-panel-title">
            <span>{t("share.title")}</span>
            <span className="share-format">Markdown</span>
          </div>
          <div className="share-panel-sub">{t("share.sub")}</div>
        </div>
        <Share2 size={15} strokeWidth={1.8} />
      </div>

      <div className="share-targets">
        {targets.length === 0 ? (
          <div className="share-target-empty">{t("share.targets.empty")}</div>
        ) : targets.map((target) => {
          const pending = pendingChannel === target.channel;
          return (
            <button
              key={target.channel}
              type="button"
              className="share-target"
              disabled={!target.enabled || pending}
              onClick={() => onSend(target.channel)}
            >
              <span className={`share-target-mark share-target-mark--${target.channel}`}>
                <ExternalLink size={14} strokeWidth={1.85} />
              </span>
              <span className="share-target-main">
                <span className="share-target-label">{target.label}</span>
                <span className="share-target-destination">{target.destination || t("value.unset")}</span>
                {target.lastShare && (
                  <span className={`share-target-last share-target-last--${target.lastShare.status}`}>
                    {target.lastShare.status === "success" ? t("share.last.success") : t("share.last.failed")}
                    {" · "}
                    {formatShareTime(target.lastShare.sentAt)}
                  </span>
                )}
              </span>
              <span className="share-target-state">
                {pending ? (
                  <>
                    <Clock3 size={13} strokeWidth={1.8} />
                    {t("share.pending")}
                  </>
                ) : target.enabled ? (
                  <>
                    <Send size={13} strokeWidth={1.8} />
                    {t("share.send")}
                  </>
                ) : (
                  disabledReasonText(target.disabledReason, t)
                )}
              </span>
            </button>
          );
        })}
      </div>

      <div className="share-history">
        <div className="share-history-title">{t("share.history")}</div>
        {recent.length === 0 ? (
          <div className="share-history-empty">{t("share.history.empty")}</div>
        ) : (
          recent.map((entry) => (
            <div key={entry.id} className="share-history-row">
              {entry.status === "success"
                ? <CheckCircle2 size={13} strokeWidth={1.8} />
                : <XCircle size={13} strokeWidth={1.8} />}
              <span>{entry.label}</span>
              <span>{formatShareTime(entry.sentAt)}</span>
              {entry.message && <em>{entry.message}</em>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function SharePopover({
  targets,
  history,
  pendingChannel,
  onSend,
  label,
  className,
  align = "right",
  disabled,
  open: controlledOpen,
  onOpenChange,
  children,
}: SharePopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const t = useT();

  const updateOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  useLayoutEffect(() => {
    if (!open) {
      setPopoverStyle(undefined);
      return;
    }

    const updatePosition = () => {
      if (window.innerWidth <= 760) {
        setPopoverStyle(null);
        return;
      }
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 14;
      const width = Math.min(320, window.innerWidth - margin * 2);
      const desiredLeft = align === "right" ? rect.right - width : rect.left;
      const left = Math.min(Math.max(margin, desiredLeft), window.innerWidth - width - margin);
      const top = Math.min(rect.bottom + 8, window.innerHeight - margin);
      setPopoverStyle({ top, left, width });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [align, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      if (target && popoverRef.current?.contains(target)) return;
      updateOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") updateOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [controlledOpen, onOpenChange, open]);

  return (
    <div className={`share-popover-root share-popover-root--${align}`} ref={rootRef}>
      <button
        type="button"
        className={className ?? "share-trigger"}
        disabled={disabled}
        aria-expanded={open}
        aria-label={label ?? t("share.title")}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          updateOpen(!open);
        }}
      >
        {children ?? (
          <>
            <Share2 size={14} strokeWidth={1.8} />
            <span>{label ?? t("share.button")}</span>
          </>
        )}
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          className="share-popover"
          role="dialog"
          aria-label={t("share.title")}
          style={popoverStyle === undefined ? { visibility: "hidden" } : popoverStyle ?? undefined}
        >
          <SharePanel targets={targets} history={history} pendingChannel={pendingChannel} onSend={onSend} />
        </div>,
        document.body,
      )}
    </div>
  );
}
