import { useContext } from "react";
import { NavLink, Outlet } from "react-router";
import { QueryClientContext } from "@tanstack/react-query";
import { trpc } from "../../trpc.js";
import { useWsChannel } from "../../ws.js";
import { MasterDetail } from "../../components/MasterDetail.js";
import { RecordingStatusBadge } from "../../components/RecordingStatusBadge.js";
import "./recordings.css";

export const handle = { breadcrumb: "Recordings", filters: null };

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
  // Read the client off context directly (non-throwing) so the component can
  // render in isolation under just <MemoryRouter> in unit tests.
  const qc = useContext(QueryClientContext);

  useWsChannel("recordings-changed", () => {
    qc?.invalidateQueries({ queryKey: [["recordings", "list"]] });
  });
  // Refresh the list when a transcribe/summarize job changes state so a row's
  // status badge updates promptly (e.g. flips to Failed) without waiting on a
  // filesystem event.
  useWsChannel("jobs", () => {
    qc?.invalidateQueries({ queryKey: [["recordings", "list"]] });
  });

  const rows = (data as Row[] | undefined) ?? [];

  const listSlot = (
    <>
      <div className="recordings-list">
        {rows.map((r) => (
          <NavLink
            key={r.stem}
            to={`/inbox/${r.stem}`}
            data-testid="recording-row"
            className={({ isActive }) => "recording-row" + (isActive ? " active" : "")}
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
    </>
  );

  return (
    <MasterDetail
      storageKey="yulu_ui.inbox.recordings.width"
      listPending={isPending}
      listSlot={listSlot}
      detailSlot={<Outlet />}
    />
  );
}
