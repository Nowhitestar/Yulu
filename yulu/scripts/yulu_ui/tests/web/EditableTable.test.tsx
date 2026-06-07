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

  it("selectable: renders checkbox column when selectable=true", () => {
    render(<EditableTable columns={COLUMNS} rows={ROWS} onCellCommit={() => {}} selectable />);
    expect(screen.getAllByRole("checkbox").length).toBe(ROWS.length + 1); // +1 = header "select all"
  });

  it("selectable: selecting a row shows the bulk action bar", async () => {
    render(<EditableTable columns={COLUMNS} rows={ROWS} onCellCommit={() => {}} selectable onBulkDelete={() => {}} />);
    const user = userEvent.setup();
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]!);   // first row (after header)
    expect(screen.getByText("已选 1 项")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument();
  });

  it("selectable: header checkbox toggles all rows", async () => {
    render(<EditableTable columns={COLUMNS} rows={ROWS} onCellCommit={() => {}} selectable onBulkDelete={() => {}} />);
    const user = userEvent.setup();
    const [headerCb] = screen.getAllByRole("checkbox");
    await user.click(headerCb!);
    expect(screen.getByText("已选 2 项")).toBeInTheDocument();
    await user.click(headerCb!);
    expect(screen.queryByText(/已选/)).toBeNull();
  });

  it("selectable: clicking Delete fires onBulkDelete with selected ids (after confirm=true)", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onBulkDelete = vi.fn();
    render(<EditableTable columns={COLUMNS} rows={ROWS} onCellCommit={() => {}} selectable onBulkDelete={onBulkDelete} />);
    const user = userEvent.setup();
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]!);   // row id=1
    await user.click(checkboxes[2]!);   // row id=2
    await user.click(screen.getByRole("button", { name: "删除" }));
    expect(onBulkDelete).toHaveBeenCalledWith([1, 2]);
  });

  it("selectable: confirm=false aborts bulk delete", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const onBulkDelete = vi.fn();
    render(<EditableTable columns={COLUMNS} rows={ROWS} onCellCommit={() => {}} selectable onBulkDelete={onBulkDelete} />);
    const user = userEvent.setup();
    const [, firstRow] = screen.getAllByRole("checkbox");
    await user.click(firstRow!);
    await user.click(screen.getByRole("button", { name: "删除" }));
    expect(onBulkDelete).not.toHaveBeenCalled();
  });
});
