import "./FilterChips.css";

export interface ChipDef {
  id: string;
  label: string;
}

export interface FilterChipsProps {
  chips: ChipDef[];
  activeIds: string[];
  onChange: (newActiveIds: string[]) => void;
}

const ALL_ID = "all";

export function FilterChips({ chips, activeIds, onChange }: FilterChipsProps) {
  const allActive = activeIds.length === 0;

  function toggle(id: string) {
    if (id === ALL_ID) { onChange([]); return; }
    if (activeIds.includes(id)) onChange(activeIds.filter((x) => x !== id));
    else onChange([...activeIds, id]);
  }

  return (
    <div className="filterchips" role="group">
      {chips.map((c) => {
        const isActive = c.id === ALL_ID ? allActive : activeIds.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={isActive}
            className={"filterchip" + (isActive ? " active" : "")}
            onClick={() => toggle(c.id)}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}
