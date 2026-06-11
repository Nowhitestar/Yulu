import { useContext, useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { QueryClientContext } from "@tanstack/react-query";
import { Pencil, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { trpc } from "../../trpc.js";
import { useWsChannel } from "../../ws.js";
import { MasterDetail } from "../../components/MasterDetail.js";
import { RecordingStatusBadge } from "../../components/RecordingStatusBadge.js";
import { useConfirm } from "../../hooks/useConfirm.js";
import { useT } from "../../i18n/LanguageProvider.js";
import "./recordings.css";

export const handle = { breadcrumb: "breadcrumb.recordings", filters: null };

interface Row {
  stem: string;
  title: string | null;
  tags: string[];
  recordedAt: string | null;
  mtimeMs: number;
  hasTranscript: boolean;
  hasSummary: boolean;
  hasRealtime: boolean;
  firstWords: string | null;
  status: string;
  statusError?: string;
}

function fmtTs(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

export function RecordingsList() {
  const { data, isPending } = trpc.recordings.list.useQuery({});
  const t = useT();
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
  const transcribeMut = trpc.recordings.transcribe.useMutation({ onSettled: invalidate });
  const summarizeMut = trpc.recordings.summarize.useMutation({ onSettled: invalidate });

  useWsChannel("recordings-changed", () => {
    invalidate();
  });
  // Refresh the list when a transcribe/summarize job changes state so a row's
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
  const isBusy = (row: Row) => row.status === "transcribing" || row.status === "summarizing";

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
        {rows.map((r) => (
          <NavLink
            key={r.stem}
            to={`/inbox/${r.stem}`}
            data-testid="recording-row"
            className={({ isActive }) => "recording-row" + (isActive ? " active" : "")}
            onContextMenu={(event) => openMenu(event, r)}
          >
            <div className="recording-row-top">
              <span className="recording-row-title">{r.title ?? r.stem}</span>
            </div>
            {r.firstWords && <div className="recording-row-words">{r.firstWords}</div>}
            <div className="recording-row-meta">
              <span>{fmtTs(r.recordedAt)}</span>
              <RecordingStatusBadge state={r.status} error={r.statusError} />
            </div>
          </NavLink>
        ))}
      </div>
      {menu && (
        <div className="recording-context-menu" role="menu" style={menuStyle}>
          <button type="button" role="menuitem" onClick={() => renameRow(menu.row)}>
            <Pencil size={13} strokeWidth={1.8} />
            <span>{t("reader.context.rename")}</span>
          </button>
          {menu.row.hasTranscript && (
            <button
              type="button"
              role="menuitem"
              disabled={isBusy(menu.row)}
              onClick={() => { closeMenu(); transcribeMut.mutate({ stem: menu.row.stem }); }}
            >
              <RefreshCw size={13} strokeWidth={1.8} />
              <span>{t("reader.context.retranscribe")}</span>
            </button>
          )}
          {menu.row.hasSummary && (
            <button
              type="button"
              role="menuitem"
              disabled={isBusy(menu.row)}
              onClick={() => { closeMenu(); summarizeMut.mutate({ stem: menu.row.stem }); }}
            >
              <Sparkles size={13} strokeWidth={1.8} />
              <span>{t("reader.context.regenerate")}</span>
            </button>
          )}
          <button type="button" role="menuitem" className="danger" onClick={() => deleteRow(menu.row)}>
            <Trash2 size={13} strokeWidth={1.8} />
            <span>{t("reader.context.delete")}</span>
          </button>
        </div>
      )}
    </>
  );

  return (
    <MasterDetail
      className="masterdetail--mobile-detail-focus"
      storageKey="yulu_ui.inbox.recordings.width"
      listPending={isPending}
      listSlot={listSlot}
      detailSlot={<Outlet />}
    />
  );
}
