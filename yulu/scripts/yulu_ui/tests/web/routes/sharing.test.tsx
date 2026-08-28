import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { LanguageProvider, translate } from "../../../web/src/i18n/LanguageProvider.js";

const { actions, viewState } = vi.hoisted(() => ({
  actions: {
    select: vi.fn(),
    discover: vi.fn(),
    probe: vi.fn(),
    saveDestination: vi.fn(),
    testShare: vi.fn(),
    reconcileUnknown: vi.fn(),
    abandonUnknown: vi.fn(),
  },
  viewState: {
    connections: [{ id: "codex", adapter: "codex", label: "Codex" }],
    selection: { connectionId: "codex", connector: "notion" },
    connectorDiscovery: {
      status: "ready",
      detail: "Found Product Notes",
      remediation: "",
      options: [{ label: "Product Notes", value: "Product Notes" }],
    },
    connectorReadiness: {
      status: "ready",
      detail: "Notion read access verified",
      remediation: "",
    },
    destination: { configured: false, value: "", savedAt: null as string | null },
    sharingReadiness: {
      status: "untested",
      detail: "Send and verify a meeting-free Test Share",
      remediation: "",
      receipt: null as { id: string; url: string; verifiedAt: string } | null,
      actionId: null as string | null,
      action: null as { id: string; receiptId: string; receiptUrl: string } | null,
      duplicateWarningRequired: false,
    },
  },
}));

vi.mock("../../../web/src/trpc.js", () => {
  const mutation = (spy: ReturnType<typeof vi.fn>) => ({
    useMutation: () => ({ mutate: spy, isPending: false }),
  });
  return {
    trpc: {
      useUtils: () => ({ sharing: { view: { invalidate: vi.fn() } } }),
      sharing: {
        view: { useQuery: () => ({ data: viewState, isPending: false, isError: false }) },
        select: mutation(actions.select),
        discover: mutation(actions.discover),
        probe: mutation(actions.probe),
        saveDestination: mutation(actions.saveDestination),
        testShare: mutation(actions.testShare),
        reconcileUnknown: mutation(actions.reconcileUnknown),
        abandonUnknown: mutation(actions.abandonUnknown),
      },
    },
  };
});

import { SharingSettings } from "../../../web/src/routes/sharing.js";

describe("SharingSettings", () => {
  beforeEach(() => {
    for (const action of Object.values(actions)) action.mockReset();
    viewState.destination = { configured: false, value: "", savedAt: null };
    viewState.sharingReadiness = {
      status: "untested",
      detail: "Send and verify a meeting-free Test Share",
      remediation: "",
      receipt: null,
      actionId: null,
      action: null,
      duplicateWarningRequired: false,
    };
  });

  it("shows discovery and Connector Readiness separately without treating a suggestion as configured", () => {
    const view = render(<LanguageProvider><SharingSettings /></LanguageProvider>);

    expect(view.getByRole("heading", { name: translate("zh", "sharing.discovery.title") }))
      .toBeInTheDocument();
    expect(view.getByRole("heading", { name: translate("zh", "sharing.connectorReadiness.title") }))
      .toBeInTheDocument();
    expect(view.getByText("Product Notes")).toBeInTheDocument();
    expect(view.getByText(translate("zh", "sharing.destination.notConfigured")))
      .toBeInTheDocument();
    expect(view.queryByText(translate("zh", "sharing.destination.configured")))
      .toBeNull();
  });

  it("requires a fresh confirmation before sending the meeting-free Test Share", () => {
    viewState.destination = {
      configured: true,
      value: "Product Notes",
      savedAt: "2026-08-28T03:00:00.000Z",
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const view = render(<LanguageProvider><SharingSettings /></LanguageProvider>);

    fireEvent.click(view.getByRole("button", { name: translate("zh", "sharing.testShare.action") }));

    expect(confirm).toHaveBeenCalledWith(translate("zh", "sharing.testShare.confirm"));
    expect(actions.testShare).toHaveBeenCalledWith({
      confirmed: true,
      actionId: expect.any(String),
      duplicateConfirmed: false,
    });
    confirm.mockRestore();
  });

  it("shows a duplicate warning before another verified Test Share", () => {
    viewState.destination = {
      configured: true,
      value: "Product Notes",
      savedAt: "2026-08-28T03:00:00.000Z",
    };
    viewState.sharingReadiness = {
      status: "untested",
      detail: "A prior receipt exists",
      remediation: "",
      receipt: null,
      actionId: null,
      action: null,
      duplicateWarningRequired: true,
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const view = render(<LanguageProvider><SharingSettings /></LanguageProvider>);

    fireEvent.click(view.getByRole("button", { name: translate("zh", "sharing.testShare.action") }));

    expect(confirm).toHaveBeenCalledWith(translate("zh", "sharing.testShare.confirmDuplicate"));
    expect(actions.testShare).toHaveBeenCalledWith({
      confirmed: true,
      actionId: expect.any(String),
      duplicateConfirmed: true,
    });
    confirm.mockRestore();
  });

  it("offers only reconcile or abandon for an Unknown Outcome", () => {
    viewState.destination = {
      configured: true,
      value: "Product Notes",
      savedAt: "2026-08-28T03:00:00.000Z",
    };
    viewState.sharingReadiness = {
      status: "unknown",
      detail: "receipt read-back timed out",
      remediation: "Do not retry",
      receipt: null,
      actionId: "00000000-0000-4000-8000-000000000001",
      action: {
        id: "00000000-0000-4000-8000-000000000001",
        receiptId: "page-unknown",
        receiptUrl: "https://notion.so/page-unknown",
      },
      duplicateWarningRequired: false,
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const view = render(<LanguageProvider><SharingSettings /></LanguageProvider>);

    expect(view.getByRole("button", { name: translate("zh", "sharing.testShare.action") }))
      .toBeDisabled();
    fireEvent.click(view.getByRole("button", { name: translate("zh", "sharing.unknown.reconcile") }));
    expect(actions.reconcileUnknown).toHaveBeenCalledWith({
      actionId: "00000000-0000-4000-8000-000000000001",
      receiptId: "page-unknown",
      receiptUrl: "https://notion.so/page-unknown",
    });
    fireEvent.click(view.getByRole("button", { name: translate("zh", "sharing.unknown.abandon") }));
    expect(confirm).toHaveBeenCalledWith(translate("zh", "sharing.unknown.abandonConfirm"));
    expect(actions.abandonUnknown).toHaveBeenCalledWith({
      actionId: "00000000-0000-4000-8000-000000000001",
      confirmed: true,
    });
    confirm.mockRestore();
  });
});
