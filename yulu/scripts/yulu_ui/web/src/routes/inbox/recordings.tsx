import { useContext, useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { Navigate, NavLink, useLocation, useNavigate, useParams } from "react-router";
import { QueryClientContext } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { trpc } from "../../trpc.js";
import { useWsChannel } from "../../ws.js";
import { RecordingStatusBadge } from "../../components/RecordingStatusBadge.js";
import { EmptyState } from "../../components/EmptyState.js";
import { useConfirm } from "../../hooks/useConfirm.js";
import { useHotkeys } from "../../hooks/useHotkeys.js";
import { useLocale, useT, type TFunc } from "../../i18n/LanguageProvider.js";
import "./recordings.css";

interface Row {
  stem: string;
  title: string | null;
  recordedAt: string | null;
  durationSeconds: number | null;
  status: string;
  statusError?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** When it happened, as briefly as stays unambiguous: a time, a day, or a date. */
export function fmtWhen(iso: string | null, locale: string, t: TFunc, now = new Date()): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return "";
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).valueOf();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (days <= 0) return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (days === 1) return t("time.yesterday");
  if (days < 7) return date.toLocaleDateString(locale, { weekday: "short" });
  return date.toLocaleDateString(locale, date.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" });
}

/** How long it ran, rounded to what you would say out loud. */
export function fmtLength(seconds: number | null | undefined, t: TFunc): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return t("duration.seconds", { n: Math.max(1, Math.round(seconds)) });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("duration.minutes", { n: minutes });
  const rest = minutes % 60;
  return rest === 0
    ? t("duration.hours", { h: Math.floor(minutes / 60) })
    : t("duration.hoursMinutes", { h: Math.floor(minutes / 60), m: rest });
}

const BUSY_STATES = ["agent_queued", "awaiting_agent", "awaiting_policy", "transcribing", "summarizing", "sending_notion"];
const isDeleteBlocked = (row: Row) => BUSY_STATES.includes(row.status) ||
  row.status === "delivery_unverified" || row.status === "execution_unverified";

/** The left pane: every recording, newest first. j / k move through it. */
export function RecordingsList() {
  const { data, isPending } = trpc.recordings.list.useQuery({});
  const t = useT();
  const locale = useLocale();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const location = useLocation();
  // Read the client off context directly (non-throwing) so the list can render
  // in isolation under just <MemoryRouter> in unit tests.
  const qc = useContext(QueryClientContext);
  const [menu, setMenu] = useState<{ row: Row; x: number; y: number } | null>(null);

  const invalidate = () => {
    qc?.invalidateQueries({ queryKey: [["recordings", "list"]] });
    qc?.invalidateQueries({ queryKey: [["recordings", "get"]] });
  };
  const renameMut = trpc.recordings.rename.useMutation({ onSettled: invalidate });
  const deleteMut = trpc.recordings.delete.useMutation({ onSettled: invalidate });

  useWsChannel("recordings-changed", invalidate);
  // A durable task changing state updates a row's status without waiting on a
  // filesystem event.
  useWsChannel("jobs", invalidate);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const rows = (data as Row[] | undefined) ?? [];
  const current = location.pathname.startsWith("/inbox/") ? decodeURIComponent(location.pathname.slice("/inbox/".length)) : null;

  const move = (direction: 1 | -1) => {
    if (rows.length === 0) return;
    const index = rows.findIndex((row) => row.stem === current);
    const next = rows[index < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, index + direction))];
    if (next) navigate(`/inbox/${next.stem}${location.search}`);
  };
  useHotkeys({ j: () => move(1), k: () => move(-1) });

  const openMenu = (event: MouseEvent, row: Row) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ row, x: event.clientX, y: event.clientY });
  };

  const renameRow = (row: Row) => {
    setMenu(null);
    const next = window.prompt(t("reader.title.rename"), row.title ?? row.stem);
    if (next === null) return;
    const title = next.trim();
    if (!title || title === (row.title ?? "")) return;
    renameMut.mutate({ stem: row.stem, title });
  };

  const deleteRow = (row: Row) => {
    setMenu(null);
    if (!confirm(t("reader.delete.confirm", { label: row.title ?? row.stem }))) return;
    deleteMut.mutate({ stem: row.stem }, {
      onSuccess: () => {
        if (location.pathname === `/inbox/${row.stem}`) navigate("/inbox", { replace: true });
      },
    });
  };

  return (
    <>
      <div className="recordings-list" aria-busy={isPending}>
        {!isPending && rows.length === 0 && <p className="recordings-empty">{t("inbox.none")}</p>}
        {rows.map((row) => (
          <NavLink
            key={row.stem}
            to={`/inbox/${row.stem}`}
            data-testid="recording-row"
            className={({ isActive }) => "recording-row" + (isActive ? " active" : "")}
            onContextMenu={(event) => openMenu(event, row)}
          >
            <span className="recording-row-text">
              <span className="recording-row-title">{row.title ?? row.stem}</span>
              <span className="recording-row-meta">
                {[fmtWhen(row.recordedAt, locale, t), fmtLength(row.durationSeconds, t)].filter(Boolean).join(" · ")}
              </span>
            </span>
            <RecordingStatusBadge state={row.status} error={row.statusError} compact />
          </NavLink>
        ))}
      </div>
      {menu && (
        <div className="recording-context-menu menu" role="menu"
          style={{ left: Math.min(menu.x, Math.max(8, window.innerWidth - 220)), top: Math.min(menu.y, Math.max(8, window.innerHeight - 120)) }}>
          <button type="button" className="menu-item" role="menuitem" onClick={() => renameRow(menu.row)}>
            <Pencil size={14} strokeWidth={1.75} />
            <span>{t("reader.context.rename")}</span>
          </button>
          <button type="button" role="menuitem" className="menu-item danger" disabled={isDeleteBlocked(menu.row)} onClick={() => deleteRow(menu.row)}>
            <Trash2 size={14} strokeWidth={1.75} />
            <span>{t("reader.context.delete")}</span>
          </button>
        </div>
      )}
    </>
  );
}

/**
 * /inbox with nothing chosen. A wide window opens the newest recording, the
 * way Notes and Mail do; a narrow one shows only the list.
 */
export function InboxIndex() {
  const { data, isPending } = trpc.recordings.list.useQuery({});
  const t = useT();
  const [wide, setWide] = useState(() => window.matchMedia?.("(min-width: 760px)").matches ?? true);
  useEffect(() => {
    const query = window.matchMedia?.("(min-width: 760px)");
    if (!query) return;
    const change = () => setWide(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const { stem } = useParams();
  const rows = (data as Row[] | undefined) ?? [];
  if (isPending || stem) return null;
  if (rows.length === 0) return <EmptyState label={t("inbox.empty")} />;
  return wide ? <Navigate to={`/inbox/${rows[0]!.stem}`} replace /> : null;
}
