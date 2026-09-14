import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SharePopover, type RecordingShareView } from "../../web/src/components/SharePopover.js";

const unknown: RecordingShareView = {
  status: "unknown", detail: "Timed out", remediation: "Do not resend", duplicateWarningRequired: false,
  latestAction: { id: "unknown-action", status: "unknown", receiptId: "", receiptUrl: "", detail: "Timed out" },
  snapshot: null,
};

describe("SharePopover receipt reconciliation", () => {
  it("accepts a missing receipt explicitly, never sending on open or cancel", () => {
    const onConfirm = vi.fn();
    const onReconcileUnknown = vi.fn();
    render(<SharePopover view={unknown} onConfirm={onConfirm} onReconcileUnknown={onReconcileUnknown} />);
    fireEvent.click(screen.getByRole("button", { name: /分享摘要/ }));
    expect(screen.getByRole("button", { name: /核对已有回执/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("回执 URL"), { target: { value: " https://notion.so/existing " } });
    fireEvent.click(screen.getByRole("button", { name: /核对已有回执/ }));
    expect(onReconcileUnknown).toHaveBeenCalledExactlyOnceWith({ actionId: "unknown-action", receiptId: "", receiptUrl: "https://notion.so/existing" });
    fireEvent.click(screen.getByRole("button", { name: /取消/ }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows read-only progress and disables both reconciliation and abandonment during the check", () => {
    render(<SharePopover view={{ ...unknown, latestAction: { ...unknown.latestAction!, receiptId: "page-1" } }}
      onConfirm={vi.fn()} onReconcileUnknown={vi.fn()} onAbandonUnknown={vi.fn()} pending reconciling />);
    fireEvent.click(screen.getByRole("button", { name: /分享摘要/ }));
    expect(screen.getByRole("button", { name: /正在核对回执/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /放弃结果未知/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /确认分享/ })).toBeDisabled();
    expect(screen.queryByText("发送中")).not.toBeInTheDocument();
  });

  it("does not expose reconciliation or abandonment for a still-pending write", () => {
    render(<SharePopover view={{ ...unknown, latestAction: { ...unknown.latestAction!, status: "pending" } }}
      onConfirm={vi.fn()} onReconcileUnknown={vi.fn()} onAbandonUnknown={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /分享摘要/ }));
    expect(screen.queryByRole("button", { name: /核对已有回执/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /放弃结果未知/ })).not.toBeInTheDocument();
  });
});
