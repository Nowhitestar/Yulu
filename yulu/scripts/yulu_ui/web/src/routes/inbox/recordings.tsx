import { useContext, useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { QueryClientContext } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { trpc } from "../../trpc.js";
import { useWsChannel } from "../../ws.js";
import { MasterDetail } from "../../components/MasterDetail.js";
import { RecordingStatusBadge } from "../../components/RecordingStatusBadge.js";
import { EmptyState } from "../../components/EmptyState.js";
import { useConfirm } from "../../hooks/useConfirm.js";
import { useLang, useT } from "../../i18n/LanguageProvider.js";
import "./recordings.css";


interface Row {
  stem: string;
  title: string | null;
  tags: string[];
  recordedAt: string | null;
  durationSeconds: number | null;
  mtimeMs: number;
  hasTranscript: boolean;
  hasSummary: boolean;
  firstWords: string | null;
  status: string;
  statusError?: string;
}

function fmtTs(iso: string | null, locale: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return "";
  return d.toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function RecordingsList() {
  const { data, isPending } = trpc.recordings.list.useQuery({});
  const t = useT();
  const { lang } = useLang();
  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const confirm = useConfirm();
  const navigate = useNavigate();
  const location = useLocation();
  // Read the client off context directly (non-throwing) so the component can
  // render in isolation under just <MemoryRouter> in unit tests.
  const qc = useContext(QueryClientContext);
  const [menu, setMenu] = useState<{ row: Row; x: number; y: number } | null>(null);

  const invalidate = () => {
    qc?.invalidateQueries({ queryKey: [["recordings", "list"]] });
    qc?.invalidateQueries({ queryKey: [["recordings", "get"]] });
  };
  const renameMut = trpc.recordings.rename.useMutation({ onSettled: invalidate });
  const deleteMut = trpc.recordings.delete.useMutation({ onSettled: invalidate });

  useWsChannel("recordings-changed", () => {
    invalidate();
  });
  // Refresh the list when a durable Agent task changes state so a row's
  // status badge updates promptly (e.g. flips to Failed) without waiting on a
  // filesystem event.
  useWsChannel("jobs", () => {
    invalidate();
  });

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
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

  const openMenu = (event: MouseEvent, row: Row) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ row, x: event.clientX, y: event.clientY });
  };

  const closeMenu = () => setMenu(null);
  const isBusy = (row: Row) => [
    "agent_queued",
    "awaiting_agent",
    "awaiting_policy",
    "transcribing",
    "summarizing",
    "sending_notion",
  ].includes(row.status);
  const isDeleteBlocked = (row: Row) => isBusy(row) ||
    row.status === "delivery_unverified" || row.status === "execution_unverified";

  const renameRow = (row: Row) => {
    closeMenu();
    const next = window.prompt(t("reader.title.rename"), row.title ?? row.stem);
    if (next === null) return;
    const title = next.trim();
    if (!title || title === (row.title ?? "")) return;
    renameMut.mutate({ stem: row.stem, title });
  };

  const deleteRow = (row: Row) => {
    closeMenu();
    const label = row.title ?? row.stem;
    if (!confirm(t("reader.delete.confirm", { label }))) return;
    deleteMut.mutate({ stem: row.stem }, {
      onSuccess: () => {
        if (location.pathname === `/inbox/${row.stem}`) navigate("/inbox", { replace: true });
      },
    });
  };

  const menuStyle = menu
    ? {
      left: Math.min(menu.x, Math.max(8, window.innerWidth - 220)),
      top: Math.min(menu.y, Math.max(8, window.innerHeight - 180)),
    }
    : undefined;

  const listSlot = (
    <>
      <div className="recordings-list">
        {rows.length === 0 && <EmptyState label={t("inbox.empty")} />}
        {rows.map((r) => (
          <NavLink
            key={r.stem}
            to={`/inbox/${r.stem}`}
            data-testid="recording-row"
            className={({ isActive }) => "recording-row" + (isActive ? " active" : "")}
            onContextMenu={(event) => openMenu(event, r)}
          >
            <span className="recording-row-title">{r.title ?? r.stem}</span>
            <span className="recording-row-meta">
              <span>{fmtTs(r.recordedAt, locale)}</span>
              <span>{fmtDuration(r.durationSeconds)}</span>
              {(r.tags ?? []).map((tag) => <span key={tag} className="recording-row-tag">{tag}</span>)}
              <RecordingStatusBadge state={r.status} error={r.statusError} compact />
            </span>
          </NavLink>
        ))}
      </div>
      {menu && (
        <div className="recording-context-menu menu" role="menu" style={menuStyle}>
          <button type="button" className="menu-item" role="menuitem" onClick={() => renameRow(menu.row)}>
            <Pencil size={14} strokeWidth={1.75} />
            <span>{t("reader.context.rename")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item danger"
            disabled={isDeleteBlocked(menu.row)}
            onClick={() => deleteRow(menu.row)}
          >
            <Trash2 size={14} strokeWidth={1.75} />
            <span>{t("reader.context.delete")}</span>
          </button>
        </div>
      )}
    </>
  );

  return (
    <MasterDetail
      className="masterdetail--mobile-detail-focus masterdetail--inbox"
      storageKey="yulu_ui.inbox.recordings.width"
      listPending={isPending}
      listSlot={listSlot}
      detailSlot={<Outlet />}
      emptyLabel={rows.length > 0 ? t("inbox.select") : undefined}
    />
  );
}
