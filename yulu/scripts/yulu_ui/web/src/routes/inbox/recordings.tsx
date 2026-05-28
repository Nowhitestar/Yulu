import { useContext, useMemo, useState } from "react";
import { NavLink, Outlet } from "react-router";
import { QueryClientContext } from "@tanstack/react-query";
import { trpc } from "../../trpc.js";
import { useWsChannel } from "../../ws.js";
import { MasterDetail } from "../../components/MasterDetail.js";
import { FilterChips, type ChipDef } from "../../components/FilterChips.js";
import "./recordings.css";

export const handle = { breadcrumb: "Recordings", filters: null };

const FILTER_CHIPS: ChipDef[] = [
  { id: "all", label: "All" },
  { id: "voicemail", label: "Voicemail" },
  { id: "meeting", label: "Meeting" },
];

interface Row {
  stem: string;
  type: "voicemail" | "meeting";
  title: string | null;
  recordedAt: string | null;
  mtimeMs: number;
  hasTranscript: boolean;
  hasSummary: boolean;
  hasRealtime: boolean;
  firstWords: string | null;
  status: string;
  statusError?: string;
}

function deriveType(activeIds: string[]): "voicemail" | "meeting" | undefined {
  if (activeIds.length === 1) {
    if (activeIds[0] === "voicemail") return "voicemail";
    if (activeIds[0] === "meeting") return "meeting";
  }
  return undefined; // [] or both → all
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
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const type = deriveType(activeIds);
  const queryArg = useMemo(() => (type ? { type } : {}), [type]);
  const { data, isPending } = trpc.recordings.list.useQuery(queryArg);
  // Read the client off context directly (non-throwing) so the component can
  // render in isolation under just <MemoryRouter> in unit tests.
  const qc = useContext(QueryClientContext);

  useWsChannel("recordings-changed", () => {
    qc?.invalidateQueries({ queryKey: [["recordings", "list"]] });
  });

  const rows = (data as Row[] | undefined) ?? [];

  const listSlot = (
    <>
      <div className="recordings-filterbar">
        <FilterChips chips={FILTER_CHIPS} activeIds={activeIds} onChange={setActiveIds} />
      </div>
      <div className="recordings-list">
        {rows.map((r) => (
          <NavLink
            key={r.stem}
            to={`/inbox/${r.stem}`}
            data-testid="recording-row"
            className={({ isActive }) => "recording-row" + (isActive ? " active" : "")}
          >
            <div className="recording-row-top">
              <span className={`recording-badge ${r.type === "voicemail" ? "v" : "m"}`}>
                {r.type === "voicemail" ? "Voicemail" : "Meeting"}
              </span>
              <span className="recording-row-title">{r.title ?? r.stem}</span>
            </div>
            {r.firstWords && <div className="recording-row-words">{r.firstWords}</div>}
            <div className="recording-row-meta">
              <span>{fmtTs(r.recordedAt)}</span>
              {r.status !== "idle" && <span className="recording-row-status">{r.status}…</span>}
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
