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
    expect((screen.getByLabelText(/^名称$/i) as HTMLInputElement).value).toBe("Default Summary");
    expect((screen.getByLabelText(/^slug$/i) as HTMLInputElement).value).toBe("default");
    expect((screen.getByLabelText(/^类别$/i) as HTMLSelectElement).value).toBe("summary");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    expect((screen.getByLabelText(/^内容$/i) as HTMLTextAreaElement).value).toBe("Summarize this meeting.");
  });

  it("Save button is disabled when not dirty", () => {
    render(<PromptReader prompt={EXISTING} onSave={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^保存$/i })).toBeDisabled();
  });

  it("editing a field enables Save and fires onSave with the diff", async () => {
    const onSave = vi.fn();
    render(<PromptReader prompt={EXISTING} onSave={onSave} onDelete={vi.fn()} />);
    const user = userEvent.setup();
    const name = screen.getByLabelText(/^名称$/i);
    await user.clear(name);
    await user.type(name, "New Name");
    const saveBtn = screen.getByRole("button", { name: /^保存$/i });
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);
    expect(onSave).toHaveBeenCalledWith({ name: "New Name" });
  });

  it("Delete button fires onDelete after confirm=true", async () => {
    const onDelete = vi.fn();
    render(<PromptReader prompt={EXISTING} onSave={vi.fn()} onDelete={onDelete} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^删除$/i }));
    expect(onDelete).toHaveBeenCalled();
  });

  it("Delete does not fire when confirm=false", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const onDelete = vi.fn();
    render(<PromptReader prompt={EXISTING} onSave={vi.fn()} onDelete={onDelete} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^删除$/i }));
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe("PromptReader — create mode", () => {
  it("renders empty fields, Delete hidden, Save disabled until valid", async () => {
    const onSave = vi.fn();
    render(<PromptReader prompt={null} onSave={onSave} onDelete={vi.fn()} />);
    expect((screen.getByLabelText(/^名称$/i) as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("button", { name: /^删除$/i })).toBeNull();
    const saveBtn = screen.getByRole("button", { name: /^保存$/i });
    expect(saveBtn).toBeDisabled();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^名称$/i), "X");
    await user.type(screen.getByLabelText(/^slug$/i), "x");
    await user.type(screen.getByLabelText(/^内容$/i), "content");
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);
    expect(onSave).toHaveBeenCalledWith({ name: "X", slug: "x", category: "summary", content: "content", isAutoRun: false });
  });
});
