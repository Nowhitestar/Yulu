// web/src/routes/knowledge/prompts.tsx
import { useState, useMemo } from "react";
import { NavLink, Outlet, Link } from "react-router";
import { FileText } from "lucide-react";
import { trpc } from "../../trpc.js";
import { MasterDetail } from "../../components/MasterDetail.js";
import { FilterChips, type ChipDef } from "../../components/FilterChips.js";
import { CategoryChip } from "../../components/CategoryChip.js";
import { EmptyState } from "../../components/EmptyState.js";
import type { Category } from "../../components/PromptReader.js";
import "./prompts.css";

export const handle = { breadcrumb: "Prompts", filters: null };

interface Row {
  id: string;
  slug: string;
  name: string;
  category: Category;
  is_auto_run: number;
  sort_order: number;
}

const FILTER_CHIPS: ChipDef[] = [
  { id: "all",       label: "All" },
  { id: "summary",   label: "Summary" },
  { id: "cleanup",   label: "Cleanup" },
  { id: "voicemail", label: "Voicemail" },
];

export function Prompts() {
  const { data, isPending } = trpc.prompts.list.useQuery({});

  const [activeFilters, setActiveFilters] = useState<string[]>([]);
  const rows = useMemo(() => {
    const all = (data as Row[] | undefined) ?? [];
    if (activeFilters.length === 0) return all;
    return all.filter((p) => activeFilters.includes(p.category));
  }, [data, activeFilters]);

  const list = rows.length === 0 && !isPending ? (
    <EmptyState icon={<FileText size={32} strokeWidth={1.5} />} label="No prompts yet. Click + New prompt to add one." />
  ) : (
    rows.map((p) => (
      <NavLink
        key={p.id}
        to={p.id}
        data-testid="prompt-row"
        className={({ isActive }) => "prompt-row" + (isActive ? " active" : "")}
      >
        <span className="prompt-row-title">{p.name}</span>
        <span className="prompt-row-meta">
          <CategoryChip category={p.category} />
          {p.is_auto_run === 1 && <span className="prompt-row-star" aria-label="Autorun">★</span>}
        </span>
      </NavLink>
    ))
  );

  return (
    <MasterDetail
      storageKey="yulu_ui.knowledge.prompts.width"
      listPending={isPending}
      listSlot={
        <>
          <div className="prompt-filterbar">
            <FilterChips chips={FILTER_CHIPS} activeIds={activeFilters} onChange={setActiveFilters} />
            <Link to="new" className="prompt-new-btn">+ New prompt</Link>
          </div>
          <div className="prompt-list">{list}</div>
        </>
      }
      detailSlot={<Outlet />}
    />
  );
}
