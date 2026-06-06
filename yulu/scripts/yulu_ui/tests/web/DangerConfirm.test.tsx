// tests/web/DangerConfirm.test.tsx
// P3-3: the styled danger-confirm dialog (mirrors the .cloud-warn alertdialog).
// useDangerConfirm() returns an async confirm(label) → Promise<boolean>; the
// dialog renders only while a request is pending and resolves true on "Apply",
// false on "Cancel".
import { describe, it, expect } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { DangerConfirmProvider, useDangerConfirm } from "../../web/src/components/DangerConfirm.js";

function Harness({ onResult }: { onResult: (v: boolean) => void }) {
  const { confirm } = useDangerConfirm();
  return (
    <button type="button" onClick={async () => { onResult(await confirm("Audio output dir")); }}>
      trigger
    </button>
  );
}

function mount(onResult: (v: boolean) => void) {
  return render(
    <DangerConfirmProvider>
      <Harness onResult={onResult} />
    </DangerConfirmProvider>,
  );
}

describe("DangerConfirm (P3-3)", () => {
  it("renders nothing until confirm() is called", () => {
    mount(() => {});
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows the dialog with the field label when confirm() is invoked", async () => {
    mount(() => {});
    fireEvent.click(screen.getByText("trigger"));
    const dialog = await waitFor(() => screen.getByRole("alertdialog"));
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/Audio output dir/)).toBeInTheDocument();
  });

  it("resolves true and closes when Apply is clicked", async () => {
    let resolved: boolean | undefined;
    mount((v) => { resolved = v; });
    fireEvent.click(screen.getByText("trigger"));
    await waitFor(() => screen.getByRole("alertdialog"));
    fireEvent.click(screen.getByRole("button", { name: /apply/i }));
    await waitFor(() => expect(resolved).toBe(true));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("resolves false and closes when Cancel is clicked", async () => {
    let resolved: boolean | undefined;
    mount((v) => { resolved = v; });
    fireEvent.click(screen.getByText("trigger"));
    await waitFor(() => screen.getByRole("alertdialog"));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(resolved).toBe(false));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("the default (no-provider) confirm resolves true so a section used standalone still commits", async () => {
    // The context default must be permissive: a section rendered without the
    // provider (e.g. a focused unit test) should not silently swallow edits.
    let resolved: boolean | undefined;
    render(<Harness onResult={(v) => { resolved = v; }} />);
    await act(async () => { fireEvent.click(screen.getByText("trigger")); });
    await waitFor(() => expect(resolved).toBe(true));
  });
});
