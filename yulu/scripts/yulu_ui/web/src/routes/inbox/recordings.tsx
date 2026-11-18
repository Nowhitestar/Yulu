import { useContext, useEffect, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { QueryClientContext } from "@tanstack/react-query";
import { Clock, FileText, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
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
  durationSeconds: number | null;
  mtimeMs: number;
  hasTranscript: boolean;
  hasSummary: boolean;
  firstWords: string | null;
  status: string;
  statusError?: string;
  depth?: number;
  indentLevel?: number;
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

function fmtDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function rowDepth(row: Row): number {
  const raw = row.indentLevel ?? row.depth ?? 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(4, Math.trunc(n)));
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
      <div className="recordings-list-head">
        <h2>{t("breadcrumb.inbox")}</h2>
        <button type="button" aria-label={t("common.more")}>•••</button>
      </div>
      <div className="recordings-list">
        {rows.map((r) => {
          const depth = rowDepth(r);
          const tags = r.tags ?? [];
          return (
          <div
            key={r.stem}
            className="recording-row-wrap"
            data-depth={depth}
            style={{ "--recording-indent": `${depth * 14}px` } as CSSProperties}
            onContextMenu={(event) => openMenu(event, r)}
          >
            <NavLink
              to={`/inbox/${r.stem}`}
              data-testid="recording-row"
              className={({ isActive }) => "recording-row" + (isActive ? " active" : "")}
            >
              <div className="recording-row-top">
                <span className="recording-row-title">{r.title ?? r.stem}</span>
              </div>
              <div className="recording-row-time">
                <span className="recording-row-time-part">
                  <Clock size={12} strokeWidth={1.9} />
                  {fmtDuration(r.durationSeconds)}
                </span>
                <span aria-hidden="true">•</span>
                <span>{fmtTs(r.recordedAt)}</span>
              </div>
              <div className="recording-row-footer">
                <div className="recording-row-tags">
                  {tags.length > 0 ? (
                    tags.map((tag) => (
                      <span key={tag} className="recording-row-tag">{tag}</span>
                    ))
                  ) : (
                    <span className="recording-row-add-tag" role="img" aria-label={t("tag.addAria")} title={t("tag.add")}>
                      <Plus size={12} strokeWidth={2.1} />
                    </span>
                  )}
                </div>
                <div className="recording-row-icons" aria-label="Recording outputs">
                  {r.hasTranscript && <FileText className="recording-row-output" size={13} strokeWidth={1.9} aria-label="Transcript ready" />}
                  {r.hasSummary && <Sparkles className="recording-row-output" size={13} strokeWidth={1.9} aria-label="Summary ready" />}
                  <RecordingStatusBadge state={r.status} error={r.statusError} compact />
                </div>
              </div>
            </NavLink>
          </div>
          );
        })}
      </div>
      {menu && (
        <div className="recording-context-menu" role="menu" style={menuStyle}>
          <button type="button" role="menuitem" onClick={() => renameRow(menu.row)}>
            <Pencil size={13} strokeWidth={1.8} />
            <span>{t("reader.context.rename")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              navigate(`/inbox/${menu.row.stem}`);
            }}
          >
            <FileText size={13} strokeWidth={1.8} />
            <span>{t("reader.action.openAtomic")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={isDeleteBlocked(menu.row)}
            onClick={() => deleteRow(menu.row)}
          >
            <Trash2 size={13} strokeWidth={1.8} />
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
    />
  );
}
