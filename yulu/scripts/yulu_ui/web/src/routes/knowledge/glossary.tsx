// web/src/routes/knowledge/glossary.tsx
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../../trpc.js";
import { EditableTable, type ColumnDef } from "../../components/EditableTable.js";
import { useT } from "../../i18n/LanguageProvider.js";
import "./glossary.css";

export const handle = { breadcrumb: "breadcrumb.glossary", filters: null };

interface VocabRow {
  id: number;
  term: string;
  pinyin: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

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
  const t = useT();

  const COLUMNS: ColumnDef<VocabRow>[] = [
    { key: "term",       label: t("glossary.col.term"),       editable: true,  width: "200px" },
    { key: "pinyin",     label: t("glossary.col.pinyin"),     editable: true,  width: "140px" },
    { key: "notes",      label: t("glossary.col.notes"),      editable: true },
    { key: "updated_at", label: t("glossary.col.lastEdited"), editable: false, width: "150px", format: (v) => formatDate(String(v ?? "")) },
  ];

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
        <button type="button" className="glossary-add-btn" onClick={() => addMut.mutateAsync({ term: "" })}>{t("glossary.add")}</button>
      </div>
      <EditableTable
        columns={COLUMNS}
        rows={rows}
        onCellCommit={onCellCommit}
        selectable
        onBulkDelete={onBulkDelete}
        emptyLabel={t("glossary.empty")}
      />
    </div>
  );
}
