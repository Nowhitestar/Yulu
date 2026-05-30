// tests/web/Onboarding.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mutable holders the trpc mock reads from, so each test can drive a different
// config / host_capabilities payload + query state (CapabilitiesSection mock pattern).
const updateMutate = vi.fn(async () => ({ ok: true }));

let configReturn: { data: unknown; isPending?: boolean } = {
  data: undefined,
  isPending: false,
};
let capsReturn: { data: unknown; isError?: boolean; isPending?: boolean } = {
  data: undefined,
  isError: false,
};

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    config: {
      get: { useQuery: () => configReturn },
      update: { useMutation: () => ({ mutateAsync: updateMutate }) },
    },
    capabilities: {
      host_capabilities: { useQuery: () => capsReturn },
    },
  },
}));

import { Onboarding } from "../../web/src/components/Onboarding.js";

const LS_KEY = "yulu_ui.onboarding_dismissed";

// A small host_capabilities report mixing a usable and an absent capability,
// so the walkthrough can render both a ready state and a not-found state.
function liveReport() {
  return {
    schema_version: 1,
    capabilities: {
      recording_dir: {
        provenance: "yulu-managed",
        status: "usable",
        resolved_path: "/Users/me/Movies/Yulu",
        detail: "writable",
      },
      claude: {
        provenance: "host-path",
        status: "usable",
        resolved_path: "/opt/homebrew/bin/claude",
        detail: "claude 1.2.3",
      },
      whisper_cli: {
        provenance: "absent",
        status: "absent",
        resolved_path: "",
        detail: "not found on PATH",
      },
      models: {
        provenance: "yulu-managed",
        status: "present-but-unverified",
        resolved_path: "/Users/me/.config/yulu/models",
        detail: "1 model",
      },
    },
  };
}

beforeEach(() => {
  updateMutate.mockClear();
  localStorage.clear();
  configReturn = { data: undefined, isPending: false };
  capsReturn = { data: undefined, isError: false };
});

describe("Onboarding (SET-03 — skippable first-run walkthrough)", () => {
  it("Test 1 — first run (no flag, no localStorage) shows the walkthrough with live permission status", () => {
    configReturn = { data: {}, isPending: false }; // config loaded, onboarding_dismissed unset
    capsReturn = { data: liveReport(), isError: false };
    render(<Onboarding />);

    // The overlay is present (a dialog) on first run.
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Live status derived from host_capabilities: a usable recording_dir reads ready,
    // an absent whisper reads not-found — both keyed off the report status.
    const dlg = screen.getByRole("dialog");
    expect(dlg.querySelector('[data-status="usable"]')).not.toBeNull();
    expect(dlg.querySelector('[data-status="absent"]')).not.toBeNull();

    // The capability names the walkthrough reflects appear (label + line both
    // mention them, so assert at least one match each).
    expect(screen.getAllByText(/recording/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/whisper/i).length).toBeGreaterThanOrEqual(1);
  });

  it("Test 2 — Skip dismisses WITHOUT completing a step: persists config flag + localStorage, hides overlay", async () => {
    configReturn = { data: {}, isPending: false };
    capsReturn = { data: liveReport(), isError: false };
    render(<Onboarding />);
    const user = userEvent.setup();

    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /skip/i }));

    // Persists the dismissal flag through the config router (SET-03 / D-06).
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({
        key: "onboarding_dismissed",
        value: true,
      }),
    );
    // And the localStorage hint so a returning user never flashes the overlay.
    expect(localStorage.getItem(LS_KEY)).toBe("true");
    // Overlay disappears immediately (local state), no walkthrough step required.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Test 3 — never reappears: config.onboarding_dismissed === true renders nothing (not forced)", () => {
    configReturn = { data: { onboarding_dismissed: true }, isPending: false };
    capsReturn = { data: liveReport(), isError: false };
    const { container } = render(<Onboarding />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it("Test 4 — no flash for a returning user: localStorage flag set + config still pending renders nothing", () => {
    localStorage.setItem(LS_KEY, "true");
    configReturn = { data: undefined, isPending: true }; // config query not yet resolved
    capsReturn = { data: undefined, isError: false };
    const { container } = render(<Onboarding />);
    // localStorage short-circuits the first-run check before config resolves.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it("degrades gracefully when host_capabilities returns the typed error shape (no crash)", () => {
    configReturn = { data: {}, isPending: false };
    capsReturn = {
      data: { schema_version: 1, capabilities: {}, error: "doctor.py exited with code 1" },
      isError: false,
    };
    expect(() => render(<Onboarding />)).not.toThrow();
    // Still renders the overlay (so the user can skip), with "couldn't check"
    // placeholders for each capability instead of implying a failure.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByText(/couldn'?t check/i).length).toBeGreaterThanOrEqual(1);
  });
});
