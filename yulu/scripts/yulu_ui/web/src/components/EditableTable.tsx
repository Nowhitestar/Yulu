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
