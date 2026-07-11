import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const refetch = vi.fn();
let query: { data: unknown; refetch: typeof refetch; isError: boolean; isPending?: boolean } = {
  data: undefined,
  refetch,
  isError: false,
};

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    capabilities: {
      host_capabilities: { useQuery: () => query },
    },
  },
}));

import { CapabilitiesSection, provenanceKey, statusKey } from "../../web/src/components/settings/CapabilitiesSection.js";

function report() {
  return {
    schema_version: 1,
    capabilities: {
      recording_dir: { provenance: "yulu-managed", status: "usable", resolved_path: "/Movies/Yulu", detail: "writable" },
      calendar: { provenance: "host-path", status: "present-but-unverified", resolved_path: "/usr/bin/osascript", detail: "not checked" },
      gog: { provenance: "absent", status: "absent", resolved_path: "", detail: "not installed" },
      hermes: { provenance: "agent-config", status: "usable", resolved_path: "/usr/local/bin/hermes", detail: "Agent-owned" },
      models: { provenance: "yulu-managed", status: "absent", resolved_path: "", detail: "retired" },
      mlx_whisper: { provenance: "yulu-managed", status: "usable", resolved_path: "/mlx", detail: "retired" },
      diarization: { provenance: "yulu-managed", status: "usable", resolved_path: "/models", detail: "retired" },
    },
  };
}

beforeEach(() => {
  refetch.mockClear();
  query = { data: undefined, refetch, isError: false };
});

describe("capability labels", () => {
  it("maps provenance and status values to stable translation keys", () => {
    expect(provenanceKey("host-path")).toBe("settings.capabilities.provenance.hostPath");
    expect(provenanceKey("agent-config")).toBe("settings.capabilities.provenance.hostPath");
    expect(statusKey("usable")).not.toBe(statusKey("absent"));
    expect(statusKey("present-but-unverified")).not.toBe(statusKey("absent"));
  });
});

describe("CapabilitiesSection", () => {
  it("renders general host capabilities but not Agent-owned or retired local transcription rows", () => {
    query = { data: report(), refetch, isError: false };
    render(<CapabilitiesSection />);

    expect(screen.getByText("/Movies/Yulu")).toBeInTheDocument();
    expect(screen.getByText("/usr/bin/osascript")).toBeInTheDocument();
    expect(screen.queryByText("/usr/local/bin/hermes")).toBeNull();
    expect(screen.queryByText("/mlx")).toBeNull();
    expect(screen.queryByText("/models")).toBeNull();
    expect(screen.queryByRole("button", { name: /验证|下载\/修复/ })).toBeNull();
  });

  it("renders all three general capability status badges", () => {
    query = { data: report(), refetch, isError: false };
    const { container } = render(<CapabilitiesSection />);
    expect(container.querySelector('.cap-badge[data-status="usable"]')).not.toBeNull();
    expect(container.querySelector('.cap-badge[data-status="present-but-unverified"]')).not.toBeNull();
    expect(container.querySelector('.cap-badge[data-status="absent"]')).not.toBeNull();
  });

  it("shows loading/error states and supports refresh", async () => {
    query = { data: undefined, refetch, isError: false, isPending: true };
    const { rerender } = render(<CapabilitiesSection />);
    expect(screen.getByText("正在检测主机能力...")).toBeInTheDocument();

    query = { data: { schema_version: 1, capabilities: {}, error: "failed" }, refetch, isError: false };
    rerender(<CapabilitiesSection />);
    expect(screen.getByText(/无法读取主机能力/)).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "刷新" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("renders report values as escaped text", () => {
    const data = report();
    data.capabilities.recording_dir.resolved_path = "/x/<img src=x onerror=alert(1)>";
    query = { data, refetch, isError: false };
    const { container } = render(<CapabilitiesSection />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("/x/<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });
});
