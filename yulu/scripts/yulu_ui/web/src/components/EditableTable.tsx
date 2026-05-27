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
