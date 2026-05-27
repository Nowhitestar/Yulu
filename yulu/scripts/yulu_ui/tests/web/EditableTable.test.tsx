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
