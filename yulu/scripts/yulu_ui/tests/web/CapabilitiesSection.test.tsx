// tests/web/CapabilitiesSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// A single mutable holder the trpc mock reads from, so each test can drive a
// different host_capabilities payload / query state (DbStatsRow + glossary mock pattern).
const refetchMock = vi.fn();
let queryReturn: { data: unknown; refetch: typeof refetchMock; isError: boolean; isPending?: boolean } = {
  data: undefined,
  refetch: refetchMock,
  isError: false,
};

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    capabilities: {
      host_capabilities: { useQuery: () => queryReturn },
    },
  },
}));

import {
  CapabilitiesSection,
  provenanceLabel,
  statusLabel,
} from "../../web/src/components/settings/CapabilitiesSection.js";

beforeEach(() => {
  refetchMock.mockClear();
  queryReturn = { data: undefined, refetch: refetchMock, isError: false };
});

// A report with all four provenance kinds and all three tri-state statuses.
function fullReport() {
  return {
    schema_version: 1,
    capabilities: {
      "claude": {
        provenance: "host-path",
        status: "usable",
        resolved_path: "/opt/homebrew/bin/claude",
        detail: "claude 1.2.3",
      },
      "agent-mlx": {
        provenance: "agent-config",
        status: "present-but-unverified",
        resolved_path: "/Users/me/.config/yulu/agent-mlx",
        detail: "",
      },
      "models": {
        provenance: "yulu-managed",
        status: "present-but-unverified",
        resolved_path: "/Users/me/.config/yulu/models",
        detail: "2 models",
      },
      "whisper-cli": {
        provenance: "absent",
        status: "absent",
        resolved_path: "",
        detail: "not found on PATH",
      },
    },
  };
}

describe("provenanceLabel (D-02 copy, locked)", () => {
  it("maps host-path and agent-config to 'reused from your PATH'", () => {
    expect(provenanceLabel("host-path")).toBe("reused from your PATH");
    expect(provenanceLabel("agent-config")).toBe("reused from your PATH");
  });
  it("maps yulu-managed to 'Yulu-managed' and absent to 'not found'", () => {
    expect(provenanceLabel("yulu-managed")).toBe("Yulu-managed");
    expect(provenanceLabel("absent")).toBe("not found");
  });
});

describe("statusLabel (tri-state)", () => {
  it("maps each tri-state to a distinct human label", () => {
    const usable = statusLabel("usable");
    const unverified = statusLabel("present-but-unverified");
    const absent = statusLabel("absent");
    expect(usable).not.toBe(unverified);
    expect(unverified).not.toBe(absent);
    expect(usable).not.toBe(absent);
  });
});

describe("CapabilitiesSection", () => {
  it("Test 1 — renders the D-02 provenance label for each provenance kind", () => {
    queryReturn = { data: fullReport(), refetch: refetchMock, isError: false };
    render(<CapabilitiesSection />);
    // host-path + agent-config both render "reused from your PATH"
    expect(screen.getAllByText("reused from your PATH").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Yulu-managed")).toBeInTheDocument();
    expect(screen.getByText("not found")).toBeInTheDocument();
  });

  it("Test 2 — renders each non-absent capability's resolved_path", () => {
    queryReturn = { data: fullReport(), refetch: refetchMock, isError: false };
    render(<CapabilitiesSection />);
    expect(screen.getByText("/opt/homebrew/bin/claude")).toBeInTheDocument();
    expect(screen.getByText("/Users/me/.config/yulu/models")).toBeInTheDocument();
    expect(screen.getByText("/Users/me/.config/yulu/agent-mlx")).toBeInTheDocument();
  });

  it("Test 3 — renders three distinct tri-state status badges", () => {
    queryReturn = { data: fullReport(), refetch: refetchMock, isError: false };
    const { container } = render(<CapabilitiesSection />);
    expect(container.querySelector('.cap-badge[data-status="usable"]')).not.toBeNull();
    expect(container.querySelector('.cap-badge[data-status="present-but-unverified"]')).not.toBeNull();
    expect(container.querySelector('.cap-badge[data-status="absent"]')).not.toBeNull();
  });

  it("Test 4 — degrades to a friendly message on the typed error shape (no crash)", () => {
    queryReturn = {
      data: { schema_version: 1, capabilities: {}, error: "doctor.py exited with code 1" },
      refetch: refetchMock,
      isError: false,
    };
    expect(() => render(<CapabilitiesSection />)).not.toThrow();
    expect(screen.getByText(/couldn't read capabilities/i)).toBeInTheDocument();
  });

  it("Test 5 — Refresh button invokes the query's refetch", async () => {
    queryReturn = { data: fullReport(), refetch: refetchMock, isError: false };
    render(<CapabilitiesSection />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /refresh/i }));
    expect(refetchMock).toHaveBeenCalled();
  });

  it("renders report strings as escaped text — no dangerouslySetInnerHTML (T-04-XSS)", () => {
    const report = fullReport();
    report.capabilities["claude"]!.resolved_path = "/x/<img src=x onerror=alert(1)>";
    queryReturn = { data: report, refetch: refetchMock, isError: false };
    const { container } = render(<CapabilitiesSection />);
    // The payload must appear as literal text, never as a live <img> element.
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("/x/<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });
});
