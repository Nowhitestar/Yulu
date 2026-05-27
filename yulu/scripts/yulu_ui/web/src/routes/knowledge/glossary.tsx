// web/src/routes/knowledge/glossary.tsx
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../../trpc.js";
import { useWsChannel } from "../../ws.js";
import { EditableTable, type ColumnDef } from "../../components/EditableTable.js";
import "./glossary.css";

export const handle = { breadcrumb: "Knowledge / Glossary", filters: null };

interface VocabRow {
  id: number;
  term: string;
  pinyin: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS: ColumnDef<VocabRow>[] = [
  { key: "term",       label: "Term",        editable: true,  width: "200px" },
  { key: "pinyin",     label: "Pinyin",      editable: true,  width: "140px" },
  { key: "notes",      label: "Notes",       editable: true },
  { key: "updated_at", label: "Last edited", editable: false, width: "150px", format: (v) => formatDate(String(v ?? "")) },
];

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`;
}

export function Glossary() {
  const { data } = trpc.glossary.list.useQuery();
  const qc = useQueryClient();
  useWsChannel("sidebar-counts", () => {
    qc.invalidateQueries({ queryKey: [["glossary", "list"]] });
  });

  const addMut = trpc.glossary.add.useMutation({
    onSuccess: () => qc.invalidateQueries({ queryKey: [["glossary", "list"]] }),
  });
  const updateMut = trpc.glossary.update.useMutation({
    onSuccess: () => qc.invalidateQueries({ queryKey: [["glossary", "list"]] }),
  });
  const deleteMut = trpc.glossary.delete.useMutation();

  const rows = (data as VocabRow[] | undefined) ?? [];

  const onCellCommit = (id: number | string, key: string, value: string) => {
    updateMut.mutateAsync({ id: Number(id), [key]: value } as { id: number; [k: string]: unknown });
  };

  const onBulkDelete = async (ids: Array<number | string>) => {
    for (const id of ids) {
      await deleteMut.mutateAsync({ id: Number(id) });
    }
    qc.invalidateQueries({ queryKey: [["glossary", "list"]] });
  };

  return (
    <div className="glossary-page">
      <div className="glossary-header">
        <button type="button" className="glossary-add-btn" onClick={() => addMut.mutateAsync({ term: "" })}>+ Add term</button>
      </div>
      <EditableTable
        columns={COLUMNS}
        rows={rows}
        onCellCommit={onCellCommit}
        selectable
        onBulkDelete={onBulkDelete}
        emptyLabel="No terms yet. Click + Add term to create one."
      />
    </div>
  );
}
