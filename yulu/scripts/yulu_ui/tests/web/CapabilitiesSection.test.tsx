// tests/web/CapabilitiesSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// A single mutable holder the trpc mock reads from, so each test can drive a
// different host_capabilities payload / query state (DbStatsRow + glossary mock pattern).
const refetchMock = vi.fn();
const verifyMutateAsyncMock = vi.fn();
const provisionMutateAsyncMock = vi.fn();
let queryReturn: { data: unknown; refetch: typeof refetchMock; isError: boolean; isPending?: boolean } = {
  data: undefined,
  refetch: refetchMock,
  isError: false,
};

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    capabilities: {
      host_capabilities: { useQuery: () => queryReturn },
      verify: { useMutation: () => ({ mutateAsync: verifyMutateAsyncMock, isPending: false }) },
      provision: { useMutation: () => ({ mutateAsync: provisionMutateAsyncMock, isPending: false }) },
    },
  },
}));

import {
  CapabilitiesSection,
  provenanceKey,
  statusKey,
} from "../../web/src/components/settings/CapabilitiesSection.js";

beforeEach(() => {
  refetchMock.mockClear();
  verifyMutateAsyncMock.mockReset();
  verifyMutateAsyncMock.mockResolvedValue({ ok: true, detail: "verified", status: "usable" });
  provisionMutateAsyncMock.mockReset();
  provisionMutateAsyncMock.mockResolvedValue({ ok: true, detail: "provisioned", status: "usable" });
  queryReturn = { data: undefined, refetch: refetchMock, isError: false };
});

// A report with all four provenance kinds and all three tri-state statuses.
function fullReport(): { schema_version: number; capabilities: Record<string, {
  provenance: string;
  status: string;
  resolved_path: string;
  detail: string;
  remediation?: { action: "verify" | "provision" | "manual"; subject: string; reason: string };
}> } {
  return {
    schema_version: 1,
    capabilities: {
      "audio_daemon": {
        provenance: "host-path",
        status: "usable",
        resolved_path: "/opt/yulu/audio_daemon",
        detail: "audio daemon",
      },
      "mlx_whisper": {
        provenance: "yulu-managed",
        status: "present-but-unverified",
        resolved_path: "/Users/me/.config/yulu/mlx",
        detail: "",
        remediation: {
          action: "verify",
          subject: "mlx_whisper",
          reason: "runtime warm-up not run",
        },
      },
      "agent_mlx_whisper": {
        provenance: "agent-config",
        status: "present-but-unverified",
        resolved_path: "/Users/me/.config/yulu/agent-mlx",
        detail: "",
        remediation: {
          action: "verify",
          subject: "mlx_whisper",
          reason: "runtime warm-up not run",
        },
      },
      "models": {
        provenance: "yulu-managed",
        status: "absent",
        resolved_path: "",
        detail: "model files missing",
        remediation: {
          action: "provision",
          subject: "models",
          reason: "model files missing",
        },
      },
      "whisper_cli": {
        provenance: "absent",
        status: "absent",
        resolved_path: "",
        detail: "not found on PATH",
        remediation: {
          action: "manual",
          subject: "whisper_cli",
          reason: "not found on PATH",
        },
      },
    },
  };
}

describe("provenanceKey (D-02 copy, locked)", () => {
  it("maps host-path and agent-config to the shared 'reused from your PATH' key", () => {
    expect(provenanceKey("host-path")).toBe("settings.capabilities.provenance.hostPath");
    expect(provenanceKey("agent-config")).toBe("settings.capabilities.provenance.hostPath");
  });
  it("maps yulu-managed and absent to their own keys", () => {
    expect(provenanceKey("yulu-managed")).toBe("settings.capabilities.provenance.yuluManaged");
    expect(provenanceKey("absent")).toBe("settings.capabilities.provenance.absent");
  });
});

describe("statusKey (tri-state)", () => {
  it("maps each tri-state to a distinct i18n key", () => {
    const usable = statusKey("usable");
    const unverified = statusKey("present-but-unverified");
    const absent = statusKey("absent");
    expect(usable).not.toBe(unverified);
    expect(unverified).not.toBe(absent);
    expect(usable).not.toBe(absent);
  });
});

describe("CapabilitiesSection", () => {
  it("shows loading copy while host capability probing is still pending", () => {
    queryReturn = { data: undefined, refetch: refetchMock, isError: false, isPending: true };
    render(<CapabilitiesSection />);
    expect(screen.getByText("正在检测主机能力...")).toBeInTheDocument();
    expect(screen.queryByText(/尚未检测到任何能力/)).toBeNull();
  });

  it("Test 1 — renders settings-owned provenance labels and filters Agent-managed rows", () => {
    queryReturn = { data: fullReport(), refetch: refetchMock, isError: false };
    render(<CapabilitiesSection />);
    // Default language is zh. Agent-managed rows are filtered out of Settings.
    expect(screen.getAllByText("复用自你的 PATH").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Yulu 托管").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("未找到")).toBeInTheDocument();
    expect(screen.queryByText("/Users/me/.config/yulu/agent-mlx")).toBeNull();
  });

  it("Test 2 — renders each non-absent capability's resolved_path", () => {
    queryReturn = { data: fullReport(), refetch: refetchMock, isError: false };
    render(<CapabilitiesSection />);
    expect(screen.getByText("/opt/yulu/audio_daemon")).toBeInTheDocument();
    expect(screen.getByText("/Users/me/.config/yulu/mlx")).toBeInTheDocument();
  });

  it("Test 3 — renders three distinct tri-state status badges", () => {
    queryReturn = { data: fullReport(), refetch: refetchMock, isError: false };
    const { container } = render(<CapabilitiesSection />);
    expect(container.querySelector('.cap-badge[data-status="usable"]')).not.toBeNull();
    expect(container.querySelector('.cap-badge[data-status="present-but-unverified"]')).not.toBeNull();
    expect(container.querySelector('.cap-badge[data-status="absent"]')).not.toBeNull();
  });

  it("renders capability detail so missing/unverified rows explain why", () => {
    queryReturn = { data: fullReport(), refetch: refetchMock, isError: false };
    render(<CapabilitiesSection />);
    expect(screen.getByText("not found on PATH")).toBeInTheDocument();
    expect(screen.getByText("audio daemon")).toBeInTheDocument();
  });

  it("renders what is missing, why it is missing, and how to fix it", () => {
    queryReturn = { data: fullReport(), refetch: refetchMock, isError: false };
    render(<CapabilitiesSection />);

    expect(screen.getByText(/缺什么：本地 Whisper 模型 · 为什么：model files missing · 怎么补齐：点击“下载\/修复”/)).toBeInTheDocument();
  });

  it("explains manual missing resources without showing a fake Download/Repair button", () => {
    const report = fullReport();
    report.capabilities = {
      "whisper_cli": report.capabilities["whisper_cli"]!,
    };
    queryReturn = { data: report, refetch: refetchMock, isError: false };
    render(<CapabilitiesSection />);

    expect(screen.getByText(/缺什么：whisper-cli · 为什么：not found on PATH · 怎么补齐：安装或配置后点击“刷新”/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "下载/修复" })).toBeNull();
  });

  it("Test 4 — degrades to a friendly message on the typed error shape (no crash)", () => {
    queryReturn = {
      data: { schema_version: 1, capabilities: {}, error: "doctor.py exited with code 1" },
      refetch: refetchMock,
      isError: false,
    };
    expect(() => render(<CapabilitiesSection />)).not.toThrow();
    expect(screen.getByText(/无法读取主机能力/)).toBeInTheDocument();
  });

  it("Test 5 — Refresh button invokes the query's refetch", async () => {
    queryReturn = { data: fullReport(), refetch: refetchMock, isError: false };
    render(<CapabilitiesSection />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "刷新" }));
    expect(refetchMock).toHaveBeenCalled();
  });

  it("renders a Verify action for runtime-verifiable unverified capabilities", async () => {
    queryReturn = { data: fullReport(), refetch: refetchMock, isError: false };
    render(<CapabilitiesSection />);
    const user = userEvent.setup();

    await user.click(screen.getAllByRole("button", { name: "验证" })[0]!);

    expect(verifyMutateAsyncMock).toHaveBeenCalledWith({ capability: "mlx_whisper" });
    expect(refetchMock).toHaveBeenCalled();
  });

  it("renders a Download/Repair action for provisionable missing resources", async () => {
    queryReturn = { data: fullReport(), refetch: refetchMock, isError: false };
    render(<CapabilitiesSection />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "下载/修复" }));

    expect(provisionMutateAsyncMock).toHaveBeenCalledWith({ capability: "models" });
    expect(refetchMock).toHaveBeenCalled();
  });

  it("renders report strings as escaped text — no dangerouslySetInnerHTML (T-04-XSS)", () => {
    const report = fullReport();
    report.capabilities["audio_daemon"]!.resolved_path = "/x/<img src=x onerror=alert(1)>";
    queryReturn = { data: report, refetch: refetchMock, isError: false };
    const { container } = render(<CapabilitiesSection />);
    // The payload must appear as literal text, never as a live <img> element.
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("/x/<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });
});
