// web/src/routes/knowledge/glossary.tsx
import { useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { trpc } from "../../trpc.js";
import { useT } from "../../i18n/LanguageProvider.js";
import "./glossary.css";

export const handle = { breadcrumb: "breadcrumb.glossary", filters: null };

interface VocabRow {
  id: string;
  term: string;
  canonical: string;
}

interface TermGroup {
  term: string;
  ids: string[];
}

export function Glossary() {
  const { data, isPending } = trpc.glossary.list.useQuery();
  const qc = useQueryClient();
  const t = useT();
  const [term, setTerm] = useState("");
  const [deletingTerm, setDeletingTerm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const termGroups = useMemo<TermGroup[]>(() => {
    const groups = new Map<string, TermGroup>();
    for (const row of ((data as VocabRow[] | undefined) ?? [])) {
      const canonical = String(row.canonical || row.term).trim();
      if (!canonical) continue;
      const key = canonical.toLocaleLowerCase();
      const existing = groups.get(key);
      if (existing) existing.ids.push(String(row.id));
      else groups.set(key, { term: canonical, ids: [String(row.id)] });
    }
    return [...groups.values()].sort((a, b) =>
      a.term.localeCompare(b.term, undefined, { numeric: true, sensitivity: "base" })
    );
  }, [data]);

  const addMut = trpc.glossary.add.useMutation({
    onSuccess: () => qc.invalidateQueries({ queryKey: [["glossary", "list"]] }),
  });
  const deleteMut = trpc.glossary.deleteMany.useMutation();

  const addTerm = async (event: FormEvent) => {
    event.preventDefault();
    const next = term.trim();
    if (!next || addMut.isPending) return;
    if (termGroups.some((group) => group.term.localeCompare(next, undefined, { sensitivity: "base" }) === 0)) {
      setError(t("glossary.duplicate"));
      return;
    }
    setError(null);
    try {
      await addMut.mutateAsync({
        term: next,
        canonical: next,
        scope: "both",
        notes: undefined,
      });
      setTerm("");
    } catch {
      setError(t("glossary.addError"));
    }
  };

  const deleteTerm = async (group: TermGroup) => {
    if (deletingTerm) return;
    setDeletingTerm(group.term);
    setError(null);
    try {
      await deleteMut.mutateAsync({ ids: group.ids });
    } catch {
      setError(t("glossary.deleteError"));
    } finally {
      await qc.invalidateQueries({ queryKey: [["glossary", "list"]] });
      setDeletingTerm(null);
    }
  };

  return (
    <div className="glossary-page">
      <div className="glossary-content">
        <header className="glossary-intro">
          <div>
            <h1>{t("glossary.title")}</h1>
            <p>{t("glossary.description")}</p>
          </div>
          <span className="glossary-count">{t("glossary.count", { n: termGroups.length })}</span>
        </header>

        <form className="glossary-add" onSubmit={(event) => void addTerm(event)}>
          <Plus size={17} strokeWidth={1.9} aria-hidden="true" />
          <input
            autoComplete="off"
            value={term}
            onChange={(event) => {
              setTerm(event.target.value);
              if (error) setError(null);
            }}
            placeholder={t("glossary.input")}
            aria-label={t("glossary.input")}
          />
          <button type="submit" disabled={!term.trim() || addMut.isPending}>
            {t("glossary.add")}
          </button>
        </form>

        {error && <div className="glossary-error" role="alert">{error}</div>}

        <div className="glossary-terms" aria-live="polite" aria-busy={isPending}>
          {termGroups.map((group) => (
            <span
              key={group.term.toLocaleLowerCase()}
              className={`glossary-term${deletingTerm === group.term ? " deleting" : ""}`}
              data-testid={`glossary-term-${group.ids[0]}`}
            >
              <span>{group.term}</span>
              <button
                type="button"
                aria-label={t("glossary.delete", { term: group.term })}
                title={t("glossary.delete", { term: group.term })}
                disabled={deletingTerm !== null}
                onClick={() => void deleteTerm(group)}
              >
                <X size={13} strokeWidth={2.2} aria-hidden="true" />
              </button>
            </span>
          ))}
          {!isPending && termGroups.length === 0 && (
            <div className="glossary-empty">{t("glossary.empty")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
