# Yulu UI · Phase E — Knowledge Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase B placeholders for `/knowledge/prompts` and `/knowledge/glossary` with two fully interactive pages. Users can browse/edit/create/delete prompts in master-detail; browse/edit/add/bulk-delete glossary terms in a table. Both auto-refresh via WS.

**Architecture:** Zero backend changes (Phase A's `prompts.*` and `glossary.*` already complete). React-only delivery. Prompts page reuses the Phase C `<MasterDetail>` with a new `<PromptReader>` form (explicit Save/Delete + dirty tracking). Glossary page introduces a new shared `<EditableTable>` component (column-config-driven, click-to-edit cells, checkbox bulk select).

**Tech Stack:** React 18 · React Router 7 nested routes (`:id` + `new`) · @tanstack/react-query 5 + @trpc/react-query 11 · vanilla CSS · vitest + jsdom + @testing-library/react

**Spec reference:** [`docs/superpowers/specs/2026-05-27-yulu-ui-E-knowledge-pages-design.md`](../specs/2026-05-27-yulu-ui-E-knowledge-pages-design.md) (all sections)

**Out of scope (deferred to F–G + future):** Prompt reordering; Glossary CSV import/export; per-prompt usage stats; drag-to-reorder; Playwright E2E (Phase F); backend changes.

**Path conventions:** All paths relative to repo root. Work is in `yulu/scripts/yulu_ui/web/`. Commands run from `yulu/scripts/yulu_ui/` unless noted.

---

## File Structure

```
yulu/scripts/yulu_ui/web/
├── src/
│   ├── hooks/
│   │   └── useConfirm.ts                       NEW (E.1)
│   ├── components/
│   │   ├── CategoryChip.{tsx,css}              NEW (E.2)
│   │   ├── EditableTable.{tsx,css}             NEW (E.3, E.4 bulk)
│   │   └── PromptReader.{tsx,css}              NEW (E.5)
│   └── routes/knowledge/
│       ├── prompts.tsx                          MOD — list + filters + create button (E.6)
│       ├── prompts.$id.tsx                      NEW — reader (handles :id and "new") (E.7)
│       ├── prompts.index.tsx                    NEW — "select a prompt" empty (E.6)
│       └── glossary.tsx                         MOD — full table page (E.8)
└── tests/web/
    ├── useConfirm.test.ts                       NEW (E.1)
    ├── CategoryChip.test.tsx                    NEW (E.2)
    ├── EditableTable.test.tsx                   NEW (E.3, extended E.4)
    ├── PromptReader.test.tsx                    NEW (E.5)
    ├── knowledge.prompts.test.tsx               NEW (E.6, E.7)
    └── knowledge.glossary.test.tsx              NEW (E.8)
```

`App.tsx` modified once in E.6 to wire the prompts nested children.

---

## Task E.1 — `useConfirm` helper

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/hooks/useConfirm.ts`
- Create: `yulu/scripts/yulu_ui/tests/web/useConfirm.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/web/useConfirm.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useConfirm } from "../../web/src/hooks/useConfirm.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("useConfirm", () => {
  it("returns true when window.confirm returns true", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { result } = renderHook(() => useConfirm());
    expect(result.current("really?")).toBe(true);
    expect(window.confirm).toHaveBeenCalledWith("really?");
  });

  it("returns false when window.confirm returns false", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { result } = renderHook(() => useConfirm());
    expect(result.current("really?")).toBe(false);
  });

  it("returns a stable reference across renders", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { result, rerender } = renderHook(() => useConfirm());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
cd yulu/scripts/yulu_ui
npm test -- tests/web/useConfirm.test.ts
```

- [ ] **Step 3: Implement**

```ts
// web/src/hooks/useConfirm.ts
import { useCallback } from "react";

export function useConfirm(): (message: string) => boolean {
  return useCallback((message: string) => window.confirm(message), []);
}
```

- [ ] **Step 4: Re-run + full suite + typecheck**

```bash
npm test -- tests/web/useConfirm.test.ts
npm test
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/hooks/useConfirm.ts \
        yulu/scripts/yulu_ui/tests/web/useConfirm.test.ts
git commit -m "feat(yulu_ui/web): useConfirm hook (window.confirm wrapper)"
```

---

## Task E.2 — `<CategoryChip>` component

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/CategoryChip.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/CategoryChip.css`
- Create: `yulu/scripts/yulu_ui/tests/web/CategoryChip.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/CategoryChip.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CategoryChip } from "../../web/src/components/CategoryChip.js";

describe("CategoryChip", () => {
  it.each([
    ["summary", "summary"],
    ["cleanup", "cleanup"],
    ["voicemail", "voicemail"],
  ] as const)("renders label '%s'", (category, expectedText) => {
    render(<CategoryChip category={category} />);
    expect(screen.getByText(expectedText)).toBeInTheDocument();
  });

  it("applies category-specific data-category attribute", () => {
    const { container } = render(<CategoryChip category="summary" />);
    expect(container.querySelector(".category-chip")).toHaveAttribute("data-category", "summary");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/CategoryChip.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// web/src/components/CategoryChip.tsx
import "./CategoryChip.css";

export type Category = "summary" | "cleanup" | "voicemail";

export interface CategoryChipProps { category: Category; }

export function CategoryChip({ category }: CategoryChipProps) {
  return <span className="category-chip" data-category={category}>{category}</span>;
}
```

```css
/* web/src/components/CategoryChip.css */
.category-chip {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 500;
  text-transform: lowercase;
  letter-spacing: 0.02em;
}
.category-chip[data-category="summary"]   { background: rgba(92, 207, 230, 0.18); color: var(--blue); }
.category-chip[data-category="cleanup"]   { background: rgba(186, 230, 126, 0.18); color: var(--green); }
.category-chip[data-category="voicemail"] { background: rgba(223, 191, 255, 0.20); color: var(--purple); }
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/CategoryChip.tsx \
        yulu/scripts/yulu_ui/web/src/components/CategoryChip.css \
        yulu/scripts/yulu_ui/tests/web/CategoryChip.test.tsx
git commit -m "feat(yulu_ui/web): CategoryChip (summary/cleanup/voicemail)"
```

---

## Task E.3 — `<EditableTable>` base (no bulk select yet)

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/EditableTable.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/EditableTable.css`
- Create: `yulu/scripts/yulu_ui/tests/web/EditableTable.test.tsx`

Bulk select / delete come in E.4.

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/EditableTable.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditableTable, type ColumnDef } from "../../web/src/components/EditableTable.js";

interface Row { id: number; term: string; pinyin: string; notes: string }
const COLUMNS: ColumnDef<Row>[] = [
  { key: "term",   label: "Term",   editable: true,  width: "200px" },
  { key: "pinyin", label: "Pinyin", editable: true,  width: "120px" },
  { key: "notes",  label: "Notes",  editable: true },
];

const ROWS: Row[] = [
  { id: 1, term: "AgentKey", pinyin: "",     notes: "product" },
  { id: 2, term: "OpenClaw", pinyin: "",     notes: "" },
];

describe("EditableTable", () => {
  it("renders column headers", () => {
    render(<EditableTable columns={COLUMNS} rows={ROWS} onCellCommit={() => {}} />);
    expect(screen.getByText("Term")).toBeInTheDocument();
    expect(screen.getByText("Pinyin")).toBeInTheDocument();
    expect(screen.getByText("Notes")).toBeInTheDocument();
  });

  it("renders one row per item with values", () => {
    render(<EditableTable columns={COLUMNS} rows={ROWS} onCellCommit={() => {}} />);
    expect(screen.getByText("AgentKey")).toBeInTheDocument();
    expect(screen.getByText("OpenClaw")).toBeInTheDocument();
    expect(screen.getByText("product")).toBeInTheDocument();
  });

  it("click cell → input appears + commit on Enter", async () => {
    const onCellCommit = vi.fn();
    render(<EditableTable columns={COLUMNS} rows={ROWS} onCellCommit={onCellCommit} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("AgentKey"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "AgentKeyV2{Enter}");
    expect(onCellCommit).toHaveBeenCalledWith(1, "term", "AgentKeyV2");
  });

  it("Escape cancels edit (no commit)", async () => {
    const onCellCommit = vi.fn();
    render(<EditableTable columns={COLUMNS} rows={ROWS} onCellCommit={onCellCommit} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("AgentKey"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "X{Escape}");
    expect(onCellCommit).not.toHaveBeenCalled();
  });

  it("blur commits", async () => {
    const onCellCommit = vi.fn();
    render(<EditableTable columns={COLUMNS} rows={ROWS} onCellCommit={onCellCommit} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("AgentKey"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "AgentKeyV3");
    await user.tab();
    expect(onCellCommit).toHaveBeenCalledWith(1, "term", "AgentKeyV3");
  });

  it("non-editable column renders as plain text (click does not edit)", async () => {
    const COLUMNS_RO: ColumnDef<Row>[] = [{ key: "term", label: "Term", editable: false }];
    const onCellCommit = vi.fn();
    render(<EditableTable columns={COLUMNS_RO} rows={ROWS} onCellCommit={onCellCommit} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("AgentKey"));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onCellCommit).not.toHaveBeenCalled();
  });

  it("renders emptyLabel when rows is empty", () => {
    render(<EditableTable columns={COLUMNS} rows={[]} onCellCommit={() => {}} emptyLabel="No terms" />);
    expect(screen.getByText("No terms")).toBeInTheDocument();
  });

  it("format function transforms display value", () => {
    interface R { id: number; ts: string }
    const cols: ColumnDef<R>[] = [{ key: "ts", label: "When", format: (v) => `formatted:${v}` }];
    render(<EditableTable columns={cols} rows={[{ id: 1, ts: "2026-01-01" }]} onCellCommit={() => {}} />);
    expect(screen.getByText("formatted:2026-01-01")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/EditableTable.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// web/src/components/EditableTable.tsx
import { useEffect, useRef, useState } from "react";
import "./EditableTable.css";

export interface ColumnDef<Row> {
  key: keyof Row & string;
  label: string;
  editable?: boolean;
  width?: string;
  format?: (v: Row[keyof Row]) => React.ReactNode;
}

export interface EditableTableProps<Row extends { id: string | number }> {
  columns: ColumnDef<Row>[];
  rows: Row[];
  onCellCommit: (rowId: Row["id"], key: string, value: string) => void;
  emptyLabel?: string;
}

export function EditableTable<Row extends { id: string | number }>(props: EditableTableProps<Row>) {
  const { columns, rows, onCellCommit, emptyLabel } = props;

  return (
    <div className="etable">
      <div className="etable-row etable-header">
        {columns.map((c) => (
          <div key={c.key} className="etable-cell" style={{ width: c.width }}>{c.label}</div>
        ))}
      </div>
      {rows.length === 0 && emptyLabel && (
        <div className="etable-empty">{emptyLabel}</div>
      )}
      {rows.map((row) => (
        <div key={String(row.id)} className="etable-row">
          {columns.map((c) => (
            <Cell
              key={c.key}
              column={c}
              rowId={row.id}
              value={row[c.key]}
              onCommit={onCellCommit}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

interface CellProps<Row extends { id: string | number }> {
  column: ColumnDef<Row>;
  rowId: Row["id"];
  value: Row[keyof Row];
  onCommit: (rowId: Row["id"], key: string, value: string) => void;
}

function Cell<Row extends { id: string | number }>({ column, rowId, value, onCommit }: CellProps<Row>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value ?? ""));
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  useEffect(() => { setDraft(String(value ?? "")); }, [value]);

  const display = column.format ? column.format(value) : String(value ?? "");

  if (!column.editable) {
    return <div className="etable-cell" style={{ width: column.width }}>{display}</div>;
  }

  if (!editing) {
    return (
      <div
        className="etable-cell etable-cell-editable"
        style={{ width: column.width }}
        onClick={() => setEditing(true)}
        data-testid={`cell-${rowId}-${column.key}`}
      >
        {display || <span className="etable-cell-placeholder">—</span>}
      </div>
    );
  }
  const commit = () => {
    setEditing(false);
    if (draft !== String(value ?? "")) onCommit(rowId, column.key, draft);
  };
  return (
    <div className="etable-cell" style={{ width: column.width }}>
      <input
        ref={ref}
        className="etable-input"
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") { setDraft(String(value ?? "")); setEditing(false); }
        }}
      />
    </div>
  );
}
```

```css
/* web/src/components/EditableTable.css */
.etable {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.etable-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--edge);
  font-size: 13px;
}
.etable-row:last-child { border-bottom: none; }
.etable-header {
  background: var(--row-hover);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-3);
  position: sticky;
  top: 0;
  z-index: 1;
}
.etable-cell {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.etable-cell-editable {
  cursor: text;
  padding: 2px 4px;
  border-radius: 4px;
}
.etable-cell-editable:hover { background: var(--row-hover); }
.etable-cell-placeholder { color: var(--fg-3); }
.etable-input {
  width: 100%;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--glass-2);
  color: var(--fg);
  font-size: 13px;
  border: none;
  outline: 2px solid var(--accent-soft);
}
.etable-empty {
  padding: 40px 10px;
  text-align: center;
  color: var(--fg-3);
  font-size: 12px;
}
```

- [ ] **Step 4: Re-run + full suite + typecheck**

```bash
npm test -- tests/web/EditableTable.test.tsx
npm test
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/EditableTable.tsx \
        yulu/scripts/yulu_ui/web/src/components/EditableTable.css \
        yulu/scripts/yulu_ui/tests/web/EditableTable.test.tsx
git commit -m "feat(yulu_ui/web): EditableTable base (click-to-edit cells)"
```

---

## Task E.4 — `<EditableTable>` bulk select + delete

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/components/EditableTable.tsx` (add `selectable`/`onBulkDelete` props)
- Modify: `yulu/scripts/yulu_ui/web/src/components/EditableTable.css` (append checkbox + bottom bar styles)
- Modify: `yulu/scripts/yulu_ui/tests/web/EditableTable.test.tsx` (append 3 new tests)

- [ ] **Step 1: Append failing tests**

```tsx
// tests/web/EditableTable.test.tsx — append at end of describe block:

it("selectable: renders checkbox column when selectable=true", () => {
  render(<EditableTable columns={COLUMNS} rows={ROWS} onCellCommit={() => {}} selectable />);
  expect(screen.getAllByRole("checkbox").length).toBe(ROWS.length + 1); // +1 = header "select all"
});

it("selectable: selecting a row shows the bulk action bar", async () => {
  render(<EditableTable columns={COLUMNS} rows={ROWS} onCellCommit={() => {}} selectable onBulkDelete={() => {}} />);
  const user = userEvent.setup();
  const checkboxes = screen.getAllByRole("checkbox");
  await user.click(checkboxes[1]!);   // first row (after header)
  expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^delete$/i })).toBeInTheDocument();
});

it("selectable: header checkbox toggles all rows", async () => {
  render(<EditableTable columns={COLUMNS} rows={ROWS} onCellCommit={() => {}} selectable onBulkDelete={() => {}} />);
  const user = userEvent.setup();
  const [headerCb] = screen.getAllByRole("checkbox");
  await user.click(headerCb!);
  expect(screen.getByText(/2 selected/i)).toBeInTheDocument();
  await user.click(headerCb!);
  expect(screen.queryByText(/selected/i)).toBeNull();
});

it("selectable: clicking Delete fires onBulkDelete with selected ids (after confirm=true)", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const onBulkDelete = vi.fn();
  render(<EditableTable columns={COLUMNS} rows={ROWS} onCellCommit={() => {}} selectable onBulkDelete={onBulkDelete} />);
  const user = userEvent.setup();
  const checkboxes = screen.getAllByRole("checkbox");
  await user.click(checkboxes[1]!);   // row id=1
  await user.click(checkboxes[2]!);   // row id=2
  await user.click(screen.getByRole("button", { name: /^delete$/i }));
  expect(onBulkDelete).toHaveBeenCalledWith([1, 2]);
});

it("selectable: confirm=false aborts bulk delete", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(false);
  const onBulkDelete = vi.fn();
  render(<EditableTable columns={COLUMNS} rows={ROWS} onCellCommit={() => {}} selectable onBulkDelete={onBulkDelete} />);
  const user = userEvent.setup();
  const [, firstRow] = screen.getAllByRole("checkbox");
  await user.click(firstRow!);
  await user.click(screen.getByRole("button", { name: /^delete$/i }));
  expect(onBulkDelete).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/EditableTable.test.tsx
```

- [ ] **Step 3: Extend implementation**

Replace `web/src/components/EditableTable.tsx` with the extended version (full file shown, integrate the additions on top of E.3's code):

```tsx
// web/src/components/EditableTable.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import "./EditableTable.css";

export interface ColumnDef<Row> {
  key: keyof Row & string;
  label: string;
  editable?: boolean;
  width?: string;
  format?: (v: Row[keyof Row]) => React.ReactNode;
}

export interface EditableTableProps<Row extends { id: string | number }> {
  columns: ColumnDef<Row>[];
  rows: Row[];
  onCellCommit: (rowId: Row["id"], key: string, value: string) => void;
  selectable?: boolean;
  onBulkDelete?: (rowIds: Row["id"][]) => void;
  emptyLabel?: string;
}

export function EditableTable<Row extends { id: string | number }>(props: EditableTableProps<Row>) {
  const { columns, rows, onCellCommit, selectable = false, onBulkDelete, emptyLabel } = props;
  const [selected, setSelected] = useState<Set<Row["id"]>>(new Set());

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const selectedCount = selected.size;

  const toggleRow = (id: Row["id"]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  };

  const orderedIds = useMemo(() => rows.filter((r) => selected.has(r.id)).map((r) => r.id), [rows, selected]);

  const runBulkDelete = () => {
    if (!onBulkDelete || selectedCount === 0) return;
    const ok = window.confirm(`Delete ${selectedCount} ${selectedCount === 1 ? "item" : "items"}?`);
    if (!ok) return;
    onBulkDelete(orderedIds);
    setSelected(new Set());
  };

  return (
    <div className="etable">
      <div className="etable-row etable-header">
        {selectable && (
          <div className="etable-cell etable-cell-check">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
          </div>
        )}
        {columns.map((c) => (
          <div key={c.key} className="etable-cell" style={{ width: c.width }}>{c.label}</div>
        ))}
      </div>
      {rows.length === 0 && emptyLabel && (
        <div className="etable-empty">{emptyLabel}</div>
      )}
      {rows.map((row) => (
        <div key={String(row.id)} className="etable-row">
          {selectable && (
            <div className="etable-cell etable-cell-check">
              <input
                type="checkbox"
                checked={selected.has(row.id)}
                onChange={() => toggleRow(row.id)}
                aria-label={`Select row ${row.id}`}
              />
            </div>
          )}
          {columns.map((c) => (
            <Cell
              key={c.key}
              column={c}
              rowId={row.id}
              value={row[c.key]}
              onCommit={onCellCommit}
            />
          ))}
        </div>
      ))}
      {selectable && selectedCount > 0 && (
        <div className="etable-bulkbar" role="status">
          <span>{selectedCount} selected</span>
          {onBulkDelete && (
            <button type="button" className="etable-bulk-delete" onClick={runBulkDelete}>Delete</button>
          )}
          <button type="button" className="etable-bulk-clear" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}
    </div>
  );
}

interface CellProps<Row extends { id: string | number }> {
  column: ColumnDef<Row>;
  rowId: Row["id"];
  value: Row[keyof Row];
  onCommit: (rowId: Row["id"], key: string, value: string) => void;
}

function Cell<Row extends { id: string | number }>({ column, rowId, value, onCommit }: CellProps<Row>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value ?? ""));
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  useEffect(() => { setDraft(String(value ?? "")); }, [value]);

  const display = column.format ? column.format(value) : String(value ?? "");

  if (!column.editable) {
    return <div className="etable-cell" style={{ width: column.width }}>{display}</div>;
  }
  if (!editing) {
    return (
      <div
        className="etable-cell etable-cell-editable"
        style={{ width: column.width }}
        onClick={() => setEditing(true)}
        data-testid={`cell-${rowId}-${column.key}`}
      >
        {display || <span className="etable-cell-placeholder">—</span>}
      </div>
    );
  }
  const commit = () => {
    setEditing(false);
    if (draft !== String(value ?? "")) onCommit(rowId, column.key, draft);
  };
  return (
    <div className="etable-cell" style={{ width: column.width }}>
      <input
        ref={ref}
        className="etable-input"
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") { setDraft(String(value ?? "")); setEditing(false); }
        }}
      />
    </div>
  );
}
```

Append to `web/src/components/EditableTable.css`:

```css
.etable-cell-check {
  flex: 0 0 28px;
  width: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.etable-bulkbar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: var(--accent-soft);
  border-top: 1px solid var(--edge);
  font-size: 12px;
  color: var(--fg);
}
.etable-bulkbar > span:first-child { flex: 1; }
.etable-bulk-delete {
  padding: 4px 12px;
  border-radius: var(--radius-inner);
  background: var(--red);
  color: var(--wp-1);
  font-size: 11px;
}
.etable-bulk-delete:hover { opacity: 0.9; }
.etable-bulk-clear {
  padding: 4px 12px;
  border-radius: var(--radius-inner);
  background: var(--row-hover);
  color: var(--fg-2);
  font-size: 11px;
}
.etable-bulk-clear:hover { color: var(--fg); }
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/EditableTable.tsx \
        yulu/scripts/yulu_ui/web/src/components/EditableTable.css \
        yulu/scripts/yulu_ui/tests/web/EditableTable.test.tsx
git commit -m "feat(yulu_ui/web): EditableTable bulk select + delete with confirm"
```

---

## Task E.5 — `<PromptReader>` component

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/PromptReader.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/PromptReader.css`
- Create: `yulu/scripts/yulu_ui/tests/web/PromptReader.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/PromptReader.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromptReader, type PromptData } from "../../web/src/components/PromptReader.js";

const EXISTING: PromptData = {
  id: "id-1",
  slug: "default",
  name: "Default Summary",
  category: "summary",
  content: "Summarize this meeting.",
  is_auto_run: 1,
  source: "seed",
  sort_order: 0,
  note: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(window, "confirm").mockReturnValue(true); });

describe("PromptReader — existing prompt", () => {
  it("renders all fields with current values", () => {
    render(<PromptReader prompt={EXISTING} onSave={vi.fn()} onDelete={vi.fn()} />);
    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe("Default Summary");
    expect((screen.getByLabelText(/^slug$/i) as HTMLInputElement).value).toBe("default");
    expect((screen.getByLabelText(/^category$/i) as HTMLSelectElement).value).toBe("summary");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    expect((screen.getByLabelText(/^content$/i) as HTMLTextAreaElement).value).toBe("Summarize this meeting.");
  });

  it("Save button is disabled when not dirty", () => {
    render(<PromptReader prompt={EXISTING} onSave={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
  });

  it("editing a field enables Save and fires onSave with the diff", async () => {
    const onSave = vi.fn();
    render(<PromptReader prompt={EXISTING} onSave={onSave} onDelete={vi.fn()} />);
    const user = userEvent.setup();
    const name = screen.getByLabelText(/^name$/i);
    await user.clear(name);
    await user.type(name, "New Name");
    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);
    expect(onSave).toHaveBeenCalledWith({ name: "New Name" });
  });

  it("Delete button fires onDelete after confirm=true", async () => {
    const onDelete = vi.fn();
    render(<PromptReader prompt={EXISTING} onSave={vi.fn()} onDelete={onDelete} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(onDelete).toHaveBeenCalled();
  });

  it("Delete does not fire when confirm=false", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const onDelete = vi.fn();
    render(<PromptReader prompt={EXISTING} onSave={vi.fn()} onDelete={onDelete} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe("PromptReader — create mode", () => {
  it("renders empty fields, Delete hidden, Save disabled until valid", async () => {
    const onSave = vi.fn();
    render(<PromptReader prompt={null} onSave={onSave} onDelete={vi.fn()} />);
    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("button", { name: /^delete$/i })).toBeNull();
    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    expect(saveBtn).toBeDisabled();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^name$/i), "X");
    await user.type(screen.getByLabelText(/^slug$/i), "x");
    await user.type(screen.getByLabelText(/^content$/i), "content");
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);
    expect(onSave).toHaveBeenCalledWith({ name: "X", slug: "x", category: "summary", content: "content", isAutoRun: false });
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/PromptReader.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// web/src/components/PromptReader.tsx
import { useEffect, useState } from "react";
import { useConfirm } from "../hooks/useConfirm.js";
import "./PromptReader.css";

export type Category = "summary" | "cleanup" | "voicemail";

export interface PromptData {
  id: string;
  slug: string;
  name: string;
  category: Category;
  content: string;
  is_auto_run: number;       // SQLite stores 0/1
  source: string;
  sort_order: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpdateInput {
  name?: string;
  slug?: string;
  category?: Category;
  content?: string;
  isAutoRun?: boolean;
}

export interface CreateInput {
  name: string;
  slug: string;
  category: Category;
  content: string;
  isAutoRun: boolean;
}

export interface PromptReaderProps {
  prompt: PromptData | null;          // null = create mode
  onSave: (input: UpdateInput | CreateInput) => void;
  onDelete: () => void;
}

const CATEGORIES: Category[] = ["summary", "cleanup", "voicemail"];

export function PromptReader({ prompt, onSave, onDelete }: PromptReaderProps) {
  const isCreate = prompt === null;
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [category, setCategory] = useState<Category>("summary");
  const [content, setContent] = useState("");
  const [isAutoRun, setIsAutoRun] = useState(false);

  useEffect(() => {
    if (prompt) {
      setName(prompt.name);
      setSlug(prompt.slug);
      setCategory(prompt.category);
      setContent(prompt.content);
      setIsAutoRun(prompt.is_auto_run === 1);
    } else {
      setName(""); setSlug(""); setCategory("summary"); setContent(""); setIsAutoRun(false);
    }
  }, [prompt]);

  const confirm = useConfirm();

  let canSave = false;
  let pendingDiff: UpdateInput | CreateInput | null = null;

  if (isCreate) {
    canSave = !!name.trim() && !!slug.trim() && !!content.trim();
    pendingDiff = { name, slug, category, content, isAutoRun };
  } else {
    const diff: UpdateInput = {};
    if (name !== prompt!.name) diff.name = name;
    if (slug !== prompt!.slug) diff.slug = slug;
    if (category !== prompt!.category) diff.category = category;
    if (content !== prompt!.content) diff.content = content;
    if (isAutoRun !== (prompt!.is_auto_run === 1)) diff.isAutoRun = isAutoRun;
    canSave = Object.keys(diff).length > 0;
    pendingDiff = diff;
  }

  const onSaveClick = () => { if (pendingDiff) onSave(pendingDiff); };
  const onDeleteClick = () => {
    if (confirm(`Delete prompt "${prompt?.name ?? ""}"?`)) onDelete();
  };

  return (
    <div className="preader">
      <div className="preader-field">
        <label className="preader-label" htmlFor="prompt-name">Name</label>
        <input id="prompt-name" className="preader-input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="preader-field">
        <label className="preader-label" htmlFor="prompt-slug">Slug</label>
        <input id="prompt-slug" className="preader-input" value={slug} onChange={(e) => setSlug(e.target.value)} />
      </div>
      <div className="preader-field">
        <label className="preader-label" htmlFor="prompt-category">Category</label>
        <select id="prompt-category" className="preader-input" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="preader-field">
        <label className="preader-label">Autorun</label>
        <button type="button" role="switch" aria-checked={isAutoRun} className={"preader-toggle" + (isAutoRun ? " on" : "")} onClick={() => setIsAutoRun(!isAutoRun)}>
          <span className="preader-toggle-knob" />
        </button>
      </div>
      <div className="preader-field preader-field-content">
        <label className="preader-label" htmlFor="prompt-content">Content</label>
        <textarea
          id="prompt-content"
          className="preader-textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={Math.max(15, content.split("\n").length + 2)}
        />
      </div>
      <div className="preader-actions">
        <button type="button" className="preader-btn primary" disabled={!canSave} onClick={onSaveClick}>Save</button>
        {!isCreate && (
          <button type="button" className="preader-btn danger" onClick={onDeleteClick}>Delete</button>
        )}
      </div>
    </div>
  );
}
```

```css
/* web/src/components/PromptReader.css */
.preader {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 18px;
}
.preader-field {
  display: grid;
  grid-template-columns: 100px 1fr;
  align-items: center;
  gap: 10px;
}
.preader-field-content { align-items: flex-start; }
.preader-label {
  font-size: 11px;
  color: var(--fg-3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.preader-input {
  padding: 6px 10px;
  border-radius: var(--radius-inner);
  background: var(--glass-2);
  color: var(--fg);
  font-size: 13px;
  border: none;
  outline: 2px solid transparent;
}
.preader-input:focus { outline-color: var(--accent-soft); }
.preader-textarea {
  padding: 8px 12px;
  border-radius: var(--radius-inner);
  background: var(--glass-2);
  color: var(--fg);
  font-family: "SF Mono", ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.5;
  border: none;
  outline: 2px solid transparent;
  resize: vertical;
}
.preader-textarea:focus { outline-color: var(--accent-soft); }
.preader-toggle {
  width: 32px;
  height: 18px;
  border-radius: 9px;
  background: var(--row-hover);
  position: relative;
  transition: background 120ms;
}
.preader-toggle.on { background: var(--accent); }
.preader-toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: white;
  transition: transform 120ms;
}
.preader-toggle.on .preader-toggle-knob { transform: translateX(14px); }
.preader-actions {
  display: flex;
  gap: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--edge);
}
.preader-btn {
  padding: 5px 14px;
  border-radius: var(--radius-inner);
  font-size: 12px;
}
.preader-btn.primary {
  background: var(--accent);
  color: var(--wp-1);
}
.preader-btn.primary:hover { opacity: 0.9; }
.preader-btn.primary:disabled { opacity: 0.4; cursor: not-allowed; }
.preader-btn.danger {
  background: var(--row-hover);
  color: var(--red);
}
.preader-btn.danger:hover { background: var(--red); color: var(--wp-1); }
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/PromptReader.tsx \
        yulu/scripts/yulu_ui/web/src/components/PromptReader.css \
        yulu/scripts/yulu_ui/tests/web/PromptReader.test.tsx
git commit -m "feat(yulu_ui/web): PromptReader (form with dirty tracking + Save/Delete)"
```

---

## Task E.6 — Prompts list + nested route shell + index empty

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/knowledge/prompts.tsx` (REPLACE placeholder)
- Create: `yulu/scripts/yulu_ui/web/src/routes/knowledge/prompts.css`
- Create: `yulu/scripts/yulu_ui/web/src/routes/knowledge/prompts.index.tsx`
- Modify: `yulu/scripts/yulu_ui/web/src/App.tsx`
- Create: `yulu/scripts/yulu_ui/tests/web/knowledge.prompts.test.tsx`

Reader route file is added in E.7. This task wires the list + index + create button.

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/knowledge.prompts.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Prompts } from "../../web/src/routes/knowledge/prompts.js";
import { PromptsIndex } from "../../web/src/routes/knowledge/prompts.index.js";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    prompts: {
      list: { useQuery: () => ({
        data: [
          { id: "id-1", slug: "default",  name: "Default Summary", category: "summary",   content: "x", is_auto_run: 1, source: "seed",   sort_order: 0, note: null, created_at: "", updated_at: "" },
          { id: "id-2", slug: "cleanup",  name: "Cleanup",          category: "cleanup",   content: "y", is_auto_run: 0, source: "seed",   sort_order: 1, note: null, created_at: "", updated_at: "" },
          { id: "id-3", slug: "vm",       name: "Voicemail Summary", category: "voicemail", content: "z", is_auto_run: 0, source: "manual", sort_order: 2, note: null, created_at: "", updated_at: "" },
        ],
        isPending: false,
      }) },
    },
  },
}));
vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: () => {},
  nextBackoff: (n: number) => n,
}));

function mount(initialPath = "/knowledge/prompts") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{
    path: "/knowledge/prompts",
    Component: Prompts,
    children: [{ index: true, Component: PromptsIndex }],
  }], { initialEntries: [initialPath] });
  return render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
}

describe("Prompts page", () => {
  it("renders 3 prompt rows with names + category chips + autorun star", () => {
    mount();
    expect(screen.getByText("Default Summary")).toBeInTheDocument();
    expect(screen.getByText("Cleanup")).toBeInTheDocument();
    expect(screen.getByText("Voicemail Summary")).toBeInTheDocument();
    expect(screen.getAllByText(/^summary$|^cleanup$|^voicemail$/i).length).toBeGreaterThanOrEqual(3);
    // Autorun star on first row only
    const rows = screen.getAllByTestId("prompt-row");
    expect(rows[0]).toHaveTextContent("★");
    expect(rows[1]).not.toHaveTextContent("★");
  });

  it("renders 4 filter chips (All/Summary/Cleanup/Voicemail) + New prompt button", () => {
    mount();
    expect(screen.getByRole("button", { name: /^all$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^summary$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^cleanup$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^voicemail$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /\+ new prompt/i })).toBeInTheDocument();
  });

  it("clicking Summary filter shows only summary prompts", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^summary$/i }));
    expect(screen.getByText("Default Summary")).toBeInTheDocument();
    expect(screen.queryByText("Cleanup")).toBeNull();
    expect(screen.queryByText("Voicemail Summary")).toBeNull();
  });

  it("index outlet renders empty state when no :id selected", () => {
    mount();
    expect(screen.getByText(/select a prompt/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/knowledge.prompts.test.tsx
```

- [ ] **Step 3: Implement Prompts list page**

Replace `web/src/routes/knowledge/prompts.tsx`:

```tsx
// web/src/routes/knowledge/prompts.tsx
import { useState, useMemo } from "react";
import { NavLink, Outlet, Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../../trpc.js";
import { useWsChannel } from "../../ws.js";
import { MasterDetail } from "../../components/MasterDetail.js";
import { FilterChips, type ChipDef } from "../../components/FilterChips.js";
import { CategoryChip } from "../../components/CategoryChip.js";
import { EmptyState } from "../../components/EmptyState.js";
import type { Category } from "../../components/PromptReader.js";
import "./prompts.css";

export const handle = { breadcrumb: "Knowledge / Prompts", filters: null };

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
  const qc = useQueryClient();
  useWsChannel("sidebar-counts", () => {
    qc.invalidateQueries({ queryKey: [["prompts", "list"]] });
  });

  const [activeFilters, setActiveFilters] = useState<string[]>([]);
  const rows = useMemo(() => {
    const all = (data as Row[] | undefined) ?? [];
    if (activeFilters.length === 0) return all;
    return all.filter((p) => activeFilters.includes(p.category));
  }, [data, activeFilters]);

  const list = rows.length === 0 && !isPending ? (
    <EmptyState icon="📝" label="No prompts yet. Click + New prompt to add one." />
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
```

Create `web/src/routes/knowledge/prompts.css`:

```css
.prompt-filterbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 4px 10px;
  border-bottom: 1px solid var(--edge);
  margin-bottom: 6px;
  gap: 8px;
}
.prompt-new-btn {
  padding: 4px 10px;
  border-radius: var(--radius-inner);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-weight: 500;
  text-decoration: none;
}
.prompt-new-btn:hover { background: var(--glass-3); }
.prompt-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.prompt-row {
  display: flex;
  flex-direction: column;
  padding: 8px 10px;
  border-radius: var(--radius-inner);
  color: var(--fg);
  cursor: pointer;
  transition: background 100ms;
  text-decoration: none;
}
.prompt-row:hover { background: var(--row-hover); }
.prompt-row.active {
  background: var(--accent-soft);
}
.prompt-row.active .prompt-row-title { color: var(--accent); }
.prompt-row-title {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prompt-row-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.prompt-row-star {
  color: var(--accent);
  font-size: 11px;
}
```

Create `web/src/routes/knowledge/prompts.index.tsx`:

```tsx
// web/src/routes/knowledge/prompts.index.tsx
import { EmptyState } from "../../components/EmptyState.js";

export function PromptsIndex() {
  return <EmptyState icon="📝" label="Select a prompt to edit." />;
}
```

- [ ] **Step 4: Wire into `App.tsx`**

In `web/src/App.tsx`, find the existing knowledge/prompts entry:

```ts
{ path: "knowledge/prompts", Component: Prompts, handle: promptsHandle },
```

Replace with:

```ts
{
  path: "knowledge/prompts",
  Component: Prompts,
  handle: promptsHandle,
  children: [
    { index: true, Component: PromptsIndex },
    // { path: ":id", Component: PromptReaderRoute, ... }  // wired in E.7
  ],
},
```

Add import near top:

```ts
import { PromptsIndex } from "./routes/knowledge/prompts.index.js";
```

- [ ] **Step 5: Re-run + full suite + typecheck**

```bash
npm test -- tests/web/knowledge.prompts.test.tsx
npm test
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/knowledge/prompts.tsx \
        yulu/scripts/yulu_ui/web/src/routes/knowledge/prompts.css \
        yulu/scripts/yulu_ui/web/src/routes/knowledge/prompts.index.tsx \
        yulu/scripts/yulu_ui/web/src/App.tsx \
        yulu/scripts/yulu_ui/tests/web/knowledge.prompts.test.tsx
git commit -m "feat(yulu_ui/web): Prompts list with filters + new prompt button + index empty"
```

---

## Task E.7 — Prompts `:id` reader route (handles both edit and create)

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/routes/knowledge/prompts.$id.tsx`
- Modify: `yulu/scripts/yulu_ui/web/src/App.tsx` (uncomment `:id` child + import)
- Modify: `yulu/scripts/yulu_ui/tests/web/knowledge.prompts.test.tsx` (APPEND 2 reader tests)

- [ ] **Step 1: Append failing tests**

```tsx
// tests/web/knowledge.prompts.test.tsx — append

import { PromptReaderRoute } from "../../web/src/routes/knowledge/prompts.$id.js";

describe("Prompts reader route", () => {
  const updateMutate = vi.fn(async () => ({}));
  const createMutate = vi.fn(async () => ({ id: "id-NEW" }));
  const deleteMutate = vi.fn(async () => ({}));

  beforeEach(() => { updateMutate.mockClear(); createMutate.mockClear(); deleteMutate.mockClear(); });

  function setupMocks(getReturn: unknown = { id: "id-1", slug: "default", name: "Default Summary", category: "summary", content: "Body", is_auto_run: 1, source: "seed", sort_order: 0, note: null, created_at: "", updated_at: "" }) {
    vi.doMock("../../web/src/trpc.js", () => ({
      trpc: {
        prompts: {
          get: { useQuery: () => ({ data: getReturn, isPending: false }) },
          update: { useMutation: () => ({ mutateAsync: updateMutate }) },
          create: { useMutation: () => ({ mutateAsync: createMutate }) },
          delete: { useMutation: () => ({ mutateAsync: deleteMutate }) },
        },
      },
    }));
  }

  it("edit mode: editing name then Save fires prompts.update with diff", async () => {
    setupMocks();
    const { PromptReaderRoute: Fresh } = await import("../../web/src/routes/knowledge/prompts.$id.js");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([
      { path: "/knowledge/prompts/:id", Component: Fresh },
    ], { initialEntries: ["/knowledge/prompts/id-1"] });
    render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
    const user = userEvent.setup();
    const name = screen.getByLabelText(/^name$/i);
    await user.clear(name);
    await user.type(name, "Renamed");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await vi.waitFor(() => expect(updateMutate).toHaveBeenCalledWith({ id: "id-1", name: "Renamed" }));
  });

  it("create mode (id=new): Save fires prompts.create + navigates to /knowledge/prompts/:newId", async () => {
    vi.doMock("../../web/src/trpc.js", () => ({
      trpc: {
        prompts: {
          get: { useQuery: () => ({ data: undefined, isPending: false }) },
          update: { useMutation: () => ({ mutateAsync: updateMutate }) },
          create: { useMutation: () => ({ mutateAsync: createMutate }) },
          delete: { useMutation: () => ({ mutateAsync: deleteMutate }) },
        },
      },
    }));
    const { PromptReaderRoute: Fresh } = await import("../../web/src/routes/knowledge/prompts.$id.js");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([
      { path: "/knowledge/prompts/:id", Component: Fresh },
      { path: "/knowledge/prompts/id-NEW", element: <div data-testid="navigated-to-new" /> },
    ], { initialEntries: ["/knowledge/prompts/new"] });
    render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^name$/i), "X");
    await user.type(screen.getByLabelText(/^slug$/i), "x-slug");
    await user.type(screen.getByLabelText(/^content$/i), "body");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await vi.waitFor(() => expect(createMutate).toHaveBeenCalled());
    await vi.waitFor(() => expect(screen.getByTestId("navigated-to-new")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/knowledge.prompts.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// web/src/routes/knowledge/prompts.$id.tsx
import { useParams, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../../trpc.js";
import { PromptReader, type PromptData, type CreateInput, type UpdateInput } from "../../components/PromptReader.js";
import { EmptyState } from "../../components/EmptyState.js";

export const handle = { breadcrumb: "Knowledge / Prompts", filters: null };

export function PromptReaderRoute() {
  const { id = "" } = useParams();
  const isCreate = id === "new";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isPending } = trpc.prompts.get.useQuery({ id }, { enabled: !isCreate });

  const updateMut = trpc.prompts.update.useMutation();
  const createMut = trpc.prompts.create.useMutation();
  const deleteMut = trpc.prompts.delete.useMutation();

  if (!isCreate && isPending) return <EmptyState label="Loading…" />;
  if (!isCreate && !data) return <EmptyState label={`Prompt "${id}" not found.`} />;

  const prompt = (isCreate ? null : (data as PromptData));

  const onSave = async (input: UpdateInput | CreateInput) => {
    if (isCreate) {
      const created = await createMut.mutateAsync(input as CreateInput);
      await qc.invalidateQueries({ queryKey: [["prompts", "list"]] });
      navigate(`/knowledge/prompts/${created.id}`);
    } else {
      await updateMut.mutateAsync({ id, ...(input as UpdateInput) });
      await qc.invalidateQueries({ queryKey: [["prompts", "list"]] });
      await qc.invalidateQueries({ queryKey: [["prompts", "get", { id }]] });
    }
  };

  const onDelete = async () => {
    await deleteMut.mutateAsync({ id });
    await qc.invalidateQueries({ queryKey: [["prompts", "list"]] });
    navigate("/knowledge/prompts");
  };

  return <PromptReader prompt={prompt} onSave={onSave} onDelete={onDelete} />;
}
```

- [ ] **Step 4: Wire `:id` into `App.tsx`**

Add to the prompts route children:

```ts
import { PromptReaderRoute, handle as promptReaderHandle } from "./routes/knowledge/prompts.$id.js";
// ...
children: [
  { index: true, Component: PromptsIndex },
  { path: ":id", Component: PromptReaderRoute, handle: promptReaderHandle },
],
```

- [ ] **Step 5: Re-run + full suite + typecheck**

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/knowledge/prompts.\$id.tsx \
        yulu/scripts/yulu_ui/web/src/App.tsx \
        yulu/scripts/yulu_ui/tests/web/knowledge.prompts.test.tsx
git commit -m "feat(yulu_ui/web): Prompts :id reader route (edit + create mode + delete)"
```

---

## Task E.8 — Glossary table page

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/knowledge/glossary.tsx` (REPLACE placeholder)
- Create: `yulu/scripts/yulu_ui/web/src/routes/knowledge/glossary.css`
- Create: `yulu/scripts/yulu_ui/tests/web/knowledge.glossary.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/knowledge.glossary.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Glossary } from "../../web/src/routes/knowledge/glossary.js";

const ROWS = [
  { id: 1, term: "AgentKey", pinyin: "",      notes: "product",  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T03:04:05Z" },
  { id: 2, term: "OpenClaw", pinyin: "",      notes: "",         created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-03T00:00:00Z" },
  { id: 3, term: "Yulu",     pinyin: "yu lu", notes: "the app",  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-04T00:00:00Z" },
];

const updateMutate = vi.fn(async () => ({ updated: 1 }));
const addMutate    = vi.fn(async () => ({ ok: true }));
const deleteMutate = vi.fn(async () => ({ deleted: 1 }));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    glossary: {
      list:   { useQuery: () => ({ data: ROWS, isPending: false }) },
      add:    { useMutation: () => ({ mutateAsync: addMutate }) },
      update: { useMutation: () => ({ mutateAsync: updateMutate }) },
      delete: { useMutation: () => ({ mutateAsync: deleteMutate }) },
    },
  },
}));
vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: () => {},
  nextBackoff: (n: number) => n,
}));

beforeEach(() => {
  updateMutate.mockClear(); addMutate.mockClear(); deleteMutate.mockClear();
  vi.restoreAllMocks();
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/knowledge/glossary", Component: Glossary }], { initialEntries: ["/knowledge/glossary"] });
  return render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
}

describe("Glossary page", () => {
  it("renders 3 rows + 4 column headers (Term/Pinyin/Notes/Last edited)", () => {
    mount();
    expect(screen.getByText("Term")).toBeInTheDocument();
    expect(screen.getByText("Pinyin")).toBeInTheDocument();
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.getByText("Last edited")).toBeInTheDocument();
    expect(screen.getByText("AgentKey")).toBeInTheDocument();
    expect(screen.getByText("OpenClaw")).toBeInTheDocument();
    expect(screen.getByText("Yulu")).toBeInTheDocument();
  });

  it("click cell + edit + Enter fires glossary.update", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByText("AgentKey"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "AgentKey2{Enter}");
    await vi.waitFor(() => expect(updateMutate).toHaveBeenCalledWith({ id: 1, term: "AgentKey2" }));
  });

  it("+ Add term fires glossary.add with empty term", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /\+ add term/i }));
    await vi.waitFor(() => expect(addMutate).toHaveBeenCalledWith({ term: "" }));
  });

  it("bulk delete: select 2 rows + Delete + confirm → loops glossary.delete", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mount();
    const user = userEvent.setup();
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]!);
    await user.click(checkboxes[2]!);
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await vi.waitFor(() => expect(deleteMutate).toHaveBeenCalledTimes(2));
    expect(deleteMutate).toHaveBeenNthCalledWith(1, { id: 1 });
    expect(deleteMutate).toHaveBeenNthCalledWith(2, { id: 2 });
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/knowledge.glossary.test.tsx
```

- [ ] **Step 3: Implement**

Replace `web/src/routes/knowledge/glossary.tsx`:

```tsx
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
```

Create `web/src/routes/knowledge/glossary.css`:

```css
.glossary-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.glossary-header {
  display: flex;
  padding: 10px 16px;
  border-bottom: 1px solid var(--edge);
}
.glossary-add-btn {
  padding: 4px 12px;
  border-radius: var(--radius-inner);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-weight: 500;
}
.glossary-add-btn:hover { background: var(--glass-3); }
```

- [ ] **Step 4: Re-run + full suite + typecheck**

```bash
npm test -- tests/web/knowledge.glossary.test.tsx
npm test
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/knowledge/glossary.tsx \
        yulu/scripts/yulu_ui/web/src/routes/knowledge/glossary.css \
        yulu/scripts/yulu_ui/tests/web/knowledge.glossary.test.tsx
git commit -m "feat(yulu_ui/web): Glossary page (EditableTable + add + bulk delete)"
```

---

## Task E.9 — Real-machine smoke + push

**Files:** none — verification + push.

- [ ] **Step 1: Clean rebuild + prod smoke**

```bash
cd yulu/scripts/yulu_ui
rm -rf dist
npm install
npm run build
YULU_UI_PORT=17820 node dist/server.js > /tmp/yulu_e9_prod.log 2>&1 &
PROD_PID=$!
sleep 1
for p in /healthz /trpc/prompts.list /trpc/glossary.list /knowledge/prompts /knowledge/prompts/new /knowledge/glossary; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:17820$p")
  echo "$p → $CODE"
done
kill $PROD_PID 2>/dev/null; wait 2>/dev/null
```

Expected: all 200.

- [ ] **Step 2: Dev mode + browser visual** via `npm run dev` + the gstack `/browse` skill. Verify:

1. `/knowledge/prompts` renders list + filter chips + "+ New prompt" button
2. Click a prompt row → reader form shows fields + autorun toggle + content textarea + Save disabled + Delete present
3. Edit a field → Save enables → click Save → query invalidates + row updates
4. Click "+ New prompt" → `/knowledge/prompts/new` → empty form, no Delete, Save disabled until valid
5. `/knowledge/glossary` renders table with rows + 4 columns + "+ Add term" button
6. Click a cell → text input → Enter commits → table re-renders with new value
7. Check a row → bottom bar shows "1 selected" + Delete + Clear; check another → "2 selected"; Delete → confirm dialog → both rows disappear

- [ ] **Step 3: Push**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git log --oneline | head -15
git push
```

- [ ] **Step 4: Update PR #24 description** to include Phase E summary.

---

## Self-review (before declaring Phase E done)

- [ ] Spec §3 architecture (master-detail + table) → E.6, E.7, E.8
- [ ] Spec §5 components → E.1, E.2, E.3, E.4, E.5, E.6 (PromptsIndex)
- [ ] Spec §6 EditableTable contract → E.3 + E.4
- [ ] Spec §7 data flow → E.6, E.7, E.8 (each uses the documented hooks/queries)
- [ ] Spec §11 acceptance #1 list + chip + star → E.6
- [ ] Spec §11 acceptance #2 reader edit/save/delete → E.5, E.7
- [ ] Spec §11 acceptance #3 new prompt → E.7
- [ ] Spec §11 acceptance #4 filters → E.6
- [ ] Spec §11 acceptance #5 glossary table renders + WS refresh → E.8
- [ ] Spec §11 acceptance #6 cell edit → E.3, E.4, E.8
- [ ] Spec §11 acceptance #7 add term → E.8
- [ ] Spec §11 acceptance #8 bulk delete → E.4, E.8
- [ ] Spec §11 acceptance #9 tests pass + smoke → E.9

Type consistency:
- `Category` defined in `PromptReader.tsx` (E.5) + `CategoryChip.tsx` (E.2), both export the same `"summary" | "cleanup" | "voicemail"` union
- `ColumnDef<Row>` defined in `EditableTable.tsx` (E.3), consumed in E.8
- `PromptData` defined in `PromptReader.tsx` (E.5), consumed in E.7
- `useConfirm` exported as a function returning a function — caller calls `confirm(message)`

---

## What's NOT in Phase E (deferred)

| Phase | Scope |
|---|---|
| F | Health pages (Daemons grid + Logs tail) + Playwright E2E |
| G | setup.sh, yulu doctor, release packaging |

Future polish:
- Prompt reordering (`reorder` procedure + drag UI)
- Glossary CSV import / export
- Per-prompt run history
- Multi-field column editors (select / toggle cells in EditableTable)
