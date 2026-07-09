// web/src/routes/knowledge/glossary.tsx
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { trpc } from "../../trpc.js";
import { EditableTable, type ColumnDef } from "../../components/EditableTable.js";
import { useT } from "../../i18n/LanguageProvider.js";
import "./glossary.css";

export const handle = { breadcrumb: "breadcrumb.glossary", filters: null };

interface VocabRow {
  id: string;
  term: string;
  canonical: string;
  scope: string;
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

function formatScope(scope: unknown, t: (key: string) => string): string {
  if (scope === "prompt") return t("glossary.scope.prompt");
  if (scope === "replace") return t("glossary.scope.replace");
  return t("glossary.scope.both");
}

export function Glossary() {
  const { data } = trpc.glossary.list.useQuery();
  const qc = useQueryClient();
  const t = useT();
  const [draftOpen, setDraftOpen] = useState(false);
  const [draft, setDraft] = useState({ term: "", canonical: "", scope: "both", notes: "" });
  const [query, setQuery] = useState("");

  const COLUMNS: ColumnDef<VocabRow>[] = [
    { key: "term",       label: t("glossary.col.term"),       editable: true,  width: "200px" },
    { key: "canonical",  label: t("glossary.col.canonical"),  editable: true,  width: "200px" },
    { key: "scope",      label: t("glossary.col.scope"),      editable: false, width: "120px", format: (v) => formatScope(v, t) },
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

  const rows = useMemo(() => {
    const rawRows = (data as VocabRow[] | undefined) ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return rawRows;
    return rawRows.filter((row) =>
      [row.term, row.canonical, row.scope, row.notes].some((value) => String(value ?? "").toLowerCase().includes(q))
    );
  }, [data, query]);

  const saveDraft = async () => {
    const term = draft.term.trim();
    if (!term) return;
    await addMut.mutateAsync({
      term,
      canonical: draft.canonical.trim() || term,
      scope: draft.scope as "prompt" | "replace" | "both",
      notes: draft.notes.trim() || undefined,
    });
    setDraft({ term: "", canonical: "", scope: "both", notes: "" });
    setDraftOpen(false);
  };

  const onCellCommit = (id: number | string, key: string, value: string) => {
    updateMut.mutateAsync({ id: String(id), [key]: value } as { id: string; [k: string]: unknown });
  };

  const onBulkDelete = async (ids: Array<number | string>) => {
    for (const id of ids) {
      await deleteMut.mutateAsync({ id: String(id) });
    }
    qc.invalidateQueries({ queryKey: [["glossary", "list"]] });
  };

  return (
    <div className="glossary-page">
      <div className="glossary-header">
        <input
          className="glossary-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("glossary.search")}
        />
        <button type="button" className="glossary-add-btn" onClick={() => setDraftOpen(true)}>{t("glossary.add")}</button>
      </div>
      {draftOpen && (
        <div className="glossary-draft-row">
          <input
            autoFocus
            value={draft.term}
            onChange={(event) => setDraft((prev) => ({ ...prev, term: event.target.value }))}
            placeholder={t("glossary.col.term")}
          />
          <input
            value={draft.canonical}
            onChange={(event) => setDraft((prev) => ({ ...prev, canonical: event.target.value }))}
            placeholder={t("glossary.col.canonical")}
          />
          <select
            value={draft.scope}
            onChange={(event) => setDraft((prev) => ({ ...prev, scope: event.target.value }))}
            aria-label={t("glossary.col.scope")}
          >
            <option value="both">{t("glossary.scope.both")}</option>
            <option value="prompt">{t("glossary.scope.prompt")}</option>
            <option value="replace">{t("glossary.scope.replace")}</option>
          </select>
          <input
            value={draft.notes}
            onChange={(event) => setDraft((prev) => ({ ...prev, notes: event.target.value }))}
            placeholder={t("glossary.col.notes")}
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveDraft();
              if (event.key === "Escape") setDraftOpen(false);
            }}
          />
          <button type="button" className="glossary-save-btn" disabled={!draft.term.trim()} onClick={() => void saveDraft()}>{t("glossary.save")}</button>
          <button type="button" className="glossary-cancel-btn" onClick={() => setDraftOpen(false)}>{t("glossary.cancel")}</button>
        </div>
      )}
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
