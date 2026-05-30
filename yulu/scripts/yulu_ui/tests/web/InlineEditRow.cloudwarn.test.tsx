// tests/web/InlineEditRow.cloudwarn.test.tsx
//
// DATA-03 detect-and-warn-NOT-block: the folder picker classifies the chosen
// folder via cloud.detect and, when it is a sync root, shows an eviction warning
// and defers the commit until the user opts in (Accept). A non-cloud folder — or a
// detection error — commits immediately and never blocks selection.
//
// Mirrors CapabilitiesSection.test.tsx's mutable-holder idiom: a single holder the
// trpc mock reads so each test drives cloud / not-cloud / throw on cloud.detect.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const PICKED_PATH = "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Yulu";

// Each test sets `detectImpl` to return a CloudDetect result or throw.
type CloudDetect = { is_cloud: boolean; engine: string; reason: string; dataless: boolean };
let detectImpl: () => Promise<CloudDetect> = async () => ({
  is_cloud: false, engine: "", reason: "", dataless: false,
});

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    system: {
      pickFile: { useMutation: () => ({ mutateAsync: async () => ({ path: PICKED_PATH }), isPending: false }) },
      openInFinder: { useMutation: () => ({ mutate: () => {} }) },
    },
    useUtils: () => ({
      system: { cloud: { detect: { fetch: () => detectImpl() } } },
    }),
  },
}));

import { InlineEditRow } from "../../web/src/components/InlineEditRow.js";

beforeEach(() => {
  detectImpl = async () => ({ is_cloud: false, engine: "", reason: "", dataless: false });
});

function renderFolderRow(onCommit: (v: string) => void, mode: "file" | "folder" = "folder") {
  return render(
    <InlineEditRow label="Output directory" type="path" mode={mode} value="/tmp/old" onCommit={onCommit} />,
  );
}

describe("InlineEditRow folder picker — DATA-03 cloud-warn (detect-and-warn, not block)", () => {
  it("a cloud folder shows the eviction warning and does NOT commit yet", async () => {
    detectImpl = async () => ({ is_cloud: true, engine: "icloud", reason: "iCloud Drive", dataless: false });
    const onCommit = vi.fn();
    renderFolderRow(onCommit);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /choose/i }));
    // The warning appears and names the real harm (eviction); commit is deferred.
    await screen.findByText(/evict/i);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("clicking 'Use anyway' commits the chosen path", async () => {
    detectImpl = async () => ({ is_cloud: true, engine: "icloud", reason: "iCloud Drive", dataless: false });
    const onCommit = vi.fn();
    renderFolderRow(onCommit);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /choose/i }));
    await screen.findByText(/evict/i);
    await user.click(screen.getByRole("button", { name: /use anyway/i }));
    expect(onCommit).toHaveBeenCalledWith(PICKED_PATH);
  });

  it("clicking 'Cancel' does not commit", async () => {
    detectImpl = async () => ({ is_cloud: true, engine: "icloud", reason: "iCloud Drive", dataless: false });
    const onCommit = vi.fn();
    renderFolderRow(onCommit);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /choose/i }));
    await screen.findByText(/evict/i);
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCommit).not.toHaveBeenCalled();
    // The warning is dismissed.
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("a non-cloud folder commits immediately with no warning", async () => {
    detectImpl = async () => ({ is_cloud: false, engine: "", reason: "", dataless: false });
    const onCommit = vi.fn();
    renderFolderRow(onCommit);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /choose/i }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith(PICKED_PATH));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("a detection error commits immediately (never blocks selection)", async () => {
    detectImpl = async () => { throw new Error("detection unavailable"); };
    const onCommit = vi.fn();
    renderFolderRow(onCommit);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /choose/i }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith(PICKED_PATH));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("a file-mode picker never cloud-warns (commits immediately)", async () => {
    // Even if detect would flag cloud, file pickers must be unaffected.
    detectImpl = async () => ({ is_cloud: true, engine: "icloud", reason: "iCloud Drive", dataless: false });
    const onCommit = vi.fn();
    renderFolderRow(onCommit, "file");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /choose/i }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith(PICKED_PATH));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
