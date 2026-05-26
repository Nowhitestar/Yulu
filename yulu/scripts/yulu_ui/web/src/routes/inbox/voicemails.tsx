// web/src/routes/inbox/voicemails.tsx
import { NavLink, Outlet, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../../trpc.js";
import { useWsChannel } from "../../ws.js";
import { MasterDetail } from "../../components/MasterDetail.js";
import "./voicemails.css";

export const handle = { breadcrumb: "Inbox / Voicemails", filters: null };

interface Row {
  stem: string;
  firstWords: string | null;
  sizeBytes: number;
  mtimeMs: number;
  hasTranscript: boolean;
  hasSummary: boolean;
}

export function Voicemails() {
  const { data, isPending } = trpc.voicemails.list.useQuery({});
  const qc = useQueryClient();
  useWsChannel("sidebar-counts", () => {
    qc.invalidateQueries({ queryKey: [["voicemails", "list"]] });
  });
  const params = useParams();
  const activeStem = params.stem;

  const rows = (data as Row[] | undefined) ?? [];

  const list = rows.length === 0
    ? null  // empty state handled in the index route
    : rows.map((r) => (
        <NavLink
          key={r.stem}
          to={r.stem}
          data-testid="voicemail-row"
          className={({ isActive }) => "voicemail-row" + (isActive ? " active" : "")}
        >
          <div className="voicemail-row-title">{r.firstWords ?? r.stem}</div>
          <div className="voicemail-row-meta">
            <span>{formatSeconds(r.sizeBytes)}</span>
            <span>·</span>
            <span>{formatDate(r.mtimeMs)}</span>
            {r.hasSummary && <span className="voicemail-row-check">✓</span>}
          </div>
        </NavLink>
      ));

  return (
    <MasterDetail
      listPending={isPending}
      listSlot={<div className="voicemail-list">{list}</div>}
      detailSlot={<Outlet />}
    />
  );
  // activeStem is read for future filter UX (e.g. scroll into view); not yet needed here
  void activeStem;
}

function formatSeconds(bytes: number): string {
  // Rough: 16-bit 16kHz mono WAV ≈ 32_000 bytes/sec; close enough for the master-list preview
  const sec = Math.max(1, Math.round(bytes / 32_000));
  return `${sec}s`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}
